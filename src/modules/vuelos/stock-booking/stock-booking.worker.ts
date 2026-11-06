import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpanKind } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';
import { Reloj } from '../../../common/reloj';
import { configuracionStockBooking } from '../../../config/stock-booking';
import { Observabilidad } from '../../../observabilidad/observabilidad';
import { marcarError } from '../../../observabilidad/trazas';
import { ClienteStockBooking, ResultadoEnvio, RUTA_STOCK_BOOKING } from './cliente-stock-booking';
import { armarRegistro } from './item-stock';
import { OrdenReclamada, ResultadoOrden, StockBookingRepository } from './stock-booking.repository';
import { SincronizadorStock } from './sincronizador-stock';

/** Reglas del empuje de stock a Booking. */
export const REGLAS_STOCK = {
  /** Cada cuántos segundos corre si BOOKING_STOCK_JOB_INTERVAL_SECONDS no dice otra cosa. */
  intervaloPorDefectoSegundos: 5,
  /** Espera tras el intento 1, 2, 3...; después del último, cada hora. */
  esperasSegundos: [5, 30, 120, 600, 1800],
  esperaMaximaSegundos: 3600,
  /** Tras tantos intentos con error de red, plazo, 5xx o 429, la orden queda FALLIDA (la recupera la sincronización). */
  maximoIntentos: 10,
  /** Lo que una orden tomada queda apartada de otros procesos mientras se manda. */
  arrendamientoSegundos: 60,
  /** Órdenes que se mandan a la vez: la concurrencia hacia Booking es baja a propósito. */
  lote: 5,
  /** Órdenes que atiende, como mucho, una corrida (lo que quede, en la siguiente). */
  maximoPorCorrida: 200,
};

/** La espera tras fallar el `intento`-ésimo: 5 s, 30 s, 2 min, 10 min, 30 min y luego cada hora. */
export function esperaTras(intento: number): number {
  return REGLAS_STOCK.esperasSegundos[intento - 1] ?? REGLAS_STOCK.esperaMaximaSegundos;
}

/** Segundos de un Retry-After numérico, acotados a una hora; null si no se entiende. */
function segundosDeRetryAfter(valor: string | null): number | null {
  if (valor === null || !/^\d+$/.test(valor.trim())) return null;
  return Math.min(REGLAS_STOCK.esperaMaximaSegundos, Number(valor.trim()));
}

export interface ResultadoCorridaStock {
  enviados: number;
  reintentos: number;
  rechazados: number;
  fallidos: number;
  /** Quedaron sin mandar porque el cortacircuitos estaba abierto. */
  bloqueados: number;
}

/**
 * Proceso periódico que manda a Booking el stock de las órdenes de orden_stock_booking
 * (BOOKING_STOCK_ENABLED=true). Sigue el patrón de RelevoEventos: una corrida a la vez por proceso
 * y, entre instancias, cada orden se toma con FOR UPDATE SKIP LOCKED y un arrendamiento, así el
 * HTTP ocurre fuera de toda transacción y una clave nunca se manda en paralelo.
 *
 * Lo que se manda es el valor ABSOLUTO de `available_units` leído al tomar la orden (el cupo actual
 * de esa salida y cabina, 0 si la salida está cancelada), nunca un delta: reenviar o reordenar es
 * seguro. Una orden se da por ENVIADA solo si no llegó otra de la misma clave mientras tanto.
 *
 * Según la respuesta de Booking:
 * - 2xx con `success: true`: ENVIADO.
 * - 2xx con `success: false` o un 4xx de validación (400, 404, 409, 413, 415, 422): FALLIDO sin
 *   reintento y un aviso en el log (un cambio de cupo nuevo la vuelve a PENDIENTE; la sincronización
 *   completa también).
 * - Red caída, plazo, 5xx, 429, 3xx, 401/403, un 4xx inesperado o un 2xx que no es JSON: reintento
 *   con espera creciente (5 s, 30 s, 2 min, 10 min, 30 min, luego cada hora) hasta 10 intentos;
 *   después, FALLIDO con un aviso. La venta no espera a nada de esto.
 * - Con el cortacircuitos abierto no se llama a Booking y las órdenes no gastan intentos.
 *
 * BOOKING_STOCK_JOB_ENABLED=false lo apaga (las pruebas lo apagan y llaman a `ejecutar`).
 */
@Injectable()
export class StockBookingWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StockBookingWorker.name);
  private readonly habilitado: boolean;
  private readonly sincronizarAlArrancar: boolean;
  private readonly intervaloSegundos: number;
  private temporizador: NodeJS.Timeout | undefined;
  private corriendo: Promise<ResultadoCorridaStock> | undefined;

  constructor(
    private readonly cola: StockBookingRepository,
    private readonly cliente: ClienteStockBooking,
    private readonly sincronizador: SincronizadorStock,
    private readonly reloj: Reloj,
    private readonly observabilidad: Observabilidad,
    private readonly config: ConfigService,
  ) {
    this.habilitado = config.get<string>('BOOKING_STOCK_JOB_ENABLED') !== 'false';
    this.sincronizarAlArrancar = config.get<string>('BOOKING_STOCK_SYNC_AL_ARRANCAR') === 'true';
    this.intervaloSegundos =
      config.get<number>('BOOKING_STOCK_JOB_INTERVAL_SECONDS') ??
      REGLAS_STOCK.intervaloPorDefectoSegundos;
  }

  onApplicationBootstrap(): void {
    if (this.sincronizarAlArrancar) {
      // Solo registra las órdenes de la ventana; el trabajador las va mandando a su ritmo
      void this.sincronizador
        .registrar()
        .then((n) => this.logger.log(`Sincronización al arrancar: ${n} claves registradas`))
        .catch((error: Error) =>
          this.logger.error(`Falló la sincronización al arrancar: ${error.name}`),
        );
    }
    if (!this.habilitado) {
      this.logger.log('Apagado (BOOKING_STOCK_JOB_ENABLED=false)');
      return;
    }
    this.temporizador = setInterval(() => void this.ejecutar(), this.intervaloSegundos * 1000);
    this.temporizador.unref();
    this.logger.log(`Activo: cada ${this.intervaloSegundos} s`);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.temporizador);
    await this.corriendo;
  }

  /** Una corrida; si ya hay una en curso, devuelve esa. Un error se registra y no la detiene. */
  ejecutar(): Promise<ResultadoCorridaStock> {
    this.corriendo ??= this.observabilidad
      .corridaDeJob('stock-booking', () => this.corrida())
      .finally(() => (this.corriendo = undefined));
    return this.corriendo;
  }

  private async corrida(): Promise<ResultadoCorridaStock> {
    const resultado: ResultadoCorridaStock = {
      enviados: 0,
      reintentos: 0,
      rechazados: 0,
      fallidos: 0,
      bloqueados: 0,
    };
    // Una correlación por ciclo para las órdenes que no traen la de la petición que las produjo
    const correlacionDelCiclo = `corr-${randomUUID()}`;
    const { serviceId, zonaHoraria } = configuracionStockBooking(this.config);
    let atendidas = 0;
    try {
      while (atendidas < REGLAS_STOCK.maximoPorCorrida) {
        // Con Booking caído no se toman órdenes: ni se gastan intentos ni se golpea
        if (!this.cliente.cortacircuito.disponible(this.reloj.ahora())) break;
        const lote = await this.cola.reclamar(
          this.reloj.ahora(),
          REGLAS_STOCK.lote,
          REGLAS_STOCK.arrendamientoSegundos,
        );
        if (lote.length === 0) break;
        atendidas += lote.length;
        const salidas = await Promise.allSettled(
          lote.map((orden) => this.mandar(orden, serviceId, zonaHoraria, correlacionDelCiclo)),
        );
        salidas.forEach((salida, i) => {
          if (salida.status === 'rejected') {
            // Quedó apartada: vuelve a estar disponible cuando venza el arrendamiento
            this.logger.error(
              `Orden de stock sin registrar (${lote[i].numeroVuelo}): ${(salida.reason as Error).name}`,
            );
            return;
          }
          if (salida.value === 'enviado') resultado.enviados++;
          else if (salida.value === 'reintento') resultado.reintentos++;
          else if (salida.value === 'rechazado') resultado.rechazados++;
          else if (salida.value === 'fallido') resultado.fallidos++;
          else if (salida.value === 'bloqueado') resultado.bloqueados++;
        });
      }
    } catch (error) {
      this.logger.error(`Falló el empuje de stock: ${(error as Error).name}`);
    }
    return resultado;
  }

  private async mandar(
    orden: OrdenReclamada,
    serviceId: string,
    zonaHoraria: string,
    correlacionDelCiclo: string,
  ): Promise<'enviado' | 'reintento' | 'rechazado' | 'fallido' | 'bloqueado' | null> {
    const registro = armarRegistro(serviceId, orden, zonaHoraria);
    const envio = await this.llamar(registro, orden.correlationId ?? correlacionDelCiclo);
    const ahora = this.reloj.ahora();
    let decision: ResultadoOrden & {
      resultado: 'enviado' | 'reintento' | 'rechazado' | 'fallido' | 'bloqueado';
    };
    let detalle: string;

    if (envio.tipo === 'ok') {
      decision = {
        resultado: 'enviado',
        estado: 'ENVIADO',
        intentos: orden.intentos,
        codigoHttp: envio.codigoHttp,
        error: null,
        proximoIntento: null,
        unidades: registro.available_units,
      };
      detalle = `ENVIADO HTTP_${envio.codigoHttp}`;
    } else if (envio.tipo === 'rechazado') {
      decision = {
        resultado: 'rechazado',
        estado: 'FALLIDO',
        intentos: orden.intentos,
        codigoHttp: envio.codigoHttp,
        error: envio.error,
        proximoIntento: null,
        unidades: null,
      };
      detalle = `FALLIDO ${envio.error}${envio.resumen ? ` (${envio.resumen})` : ''}`;
      this.logger.warn(
        `Booking rechazó el stock de ${registro.item_id} ${registro.date} con ${envio.error}: no se reintenta ` +
          '(un cambio de cupo o npm run stock:sincronizar la vuelve a mandar)',
      );
    } else if (envio.tipo === 'circuito-abierto') {
      // No se llamó: la orden no gasta el intento y espera a que el cortacircuitos deje pasar
      decision = {
        resultado: 'bloqueado',
        estado: 'PENDIENTE',
        intentos: Math.max(0, orden.intentos - 1),
        codigoHttp: null,
        error: 'CIRCUITO_ABIERTO',
        proximoIntento: envio.reabreEn,
        unidades: null,
      };
      detalle = 'PENDIENTE CIRCUITO_ABIERTO';
    } else if (orden.intentos >= REGLAS_STOCK.maximoIntentos) {
      decision = {
        resultado: 'fallido',
        estado: 'FALLIDO',
        intentos: orden.intentos,
        codigoHttp: envio.codigoHttp,
        error: envio.error,
        proximoIntento: null,
        unidades: null,
      };
      detalle = `FALLIDO ${envio.error}`;
      this.logger.warn(
        `Stock de ${registro.item_id} ${registro.date} sin mandar tras ${orden.intentos} intentos ` +
          `(${envio.error}): queda FALLIDO (npm run stock:sincronizar lo vuelve a mandar)`,
      );
    } else {
      const espera = Math.max(
        esperaTras(orden.intentos),
        segundosDeRetryAfter(envio.retryAfter) ?? 0,
      );
      decision = {
        resultado: 'reintento',
        estado: 'PENDIENTE',
        intentos: orden.intentos,
        codigoHttp: envio.codigoHttp,
        error: envio.error,
        proximoIntento: new Date(ahora.getTime() + espera * 1000),
        unidades: null,
      };
      detalle = `PENDIENTE ${envio.error}`;
    }

    const aplicado = await this.cola.registrarResultado(orden, ahora, decision);
    if (aplicado !== null && decision.resultado !== 'bloqueado') {
      this.observabilidad.core.empujesStock.inc({
        result:
          decision.resultado === 'enviado'
            ? 'ok'
            : decision.resultado === 'reintento'
              ? 'retry'
              : decision.resultado === 'rechazado'
                ? 'rejected'
                : 'failed',
      });
    }
    // Ni la URL, ni el cuerpo de Booking, ni un dato de pasajero: la clave del stock y el resultado
    this.logger.log(
      `Stock ${registro.item_id} ${registro.date} ${registro.time_slot} = ${registro.available_units} ` +
        `intento ${orden.intentos}: ${aplicado === 'superada' ? 'SUPERADA (llegó una orden nueva) ' : ''}${detalle}`,
    );
    return aplicado === null ? null : decision.resultado;
  }

  /** Una llamada a Booking dentro de un span CLIENT; nunca lanza. */
  private async llamar(
    registro: ReturnType<typeof armarRegistro>,
    correlacion: string,
  ): Promise<ResultadoEnvio> {
    const { trazas, metricas } = this.observabilidad;
    const span = trazas.iniciar(`POST ${RUTA_STOCK_BOOKING}`, SpanKind.CLIENT, {
      'http.request.method': 'POST',
      'http.route': RUTA_STOCK_BOOKING,
      'quinde.upstream': 'booking-stock',
    });
    const inicio = process.hrtime.bigint();
    const envio = await this.cliente.enviar(registro, correlacion);
    if (envio.tipo === 'circuito-abierto') {
      // No hubo llamada: ni métrica del cliente ni error en el span
      span.setAttribute('quinde.circuit_open', true);
      span.end();
      return envio;
    }
    const { codigoHttp } = envio;
    if (codigoHttp !== null) span.setAttribute('http.response.status_code', codigoHttp);
    if (envio.tipo === 'reintentar') {
      if (codigoHttp === null)
        marcarError(span, envio.error === 'TIMEOUT' ? 'timeout' : 'unavailable');
      else if (codigoHttp >= 500) marcarError(span, String(Math.min(codigoHttp, 504)));
    }
    span.end();
    metricas.registrarCliente(
      'booking-stock',
      'POST',
      codigoHttp ?? 'error',
      Number(process.hrtime.bigint() - inicio) / 1e9,
    );
    return envio;
  }
}
