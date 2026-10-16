import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reloj } from '../../../../common/reloj';
import {
  BandejaEventosRepository,
  EstadoEventoSaliente,
  EventoReclamado,
} from './bandeja-eventos.repository';
import { ClienteNotifier, ResultadoPublicacion } from './cliente-notifier';
import { ClienteTokenIdentity, TokenNoDisponibleError } from './cliente-token-identity';

/** Reglas del relevo de la bandeja de eventos al notifier. */
export const REGLAS_RELEVO = {
  /** Cada cuántos segundos corre si EVENT_RELAY_JOB_INTERVAL_SECONDS no dice otra cosa. */
  intervaloPorDefectoSegundos: 5,
  /** Espera tras el intento 1, 2, 3...; después del último, cada hora. */
  esperasSegundos: [5, 30, 120, 600, 1800],
  esperaMaximaSegundos: 3600,
  /** Lo que un evento tomado queda apartado de otros procesos mientras se publica. */
  arrendamientoSegundos: 60,
  /** Eventos que se publican a la vez. */
  lote: 20,
  /** Eventos que atiende, como mucho, una corrida (lo que quede, en la siguiente). */
  maximoPorCorrida: 200,
  /** Un evento pendiente más viejo que esto deja un aviso en el log. */
  avisoPendienteMinutos: 15,
  /** Cada cuánto, como mucho, se repite ese aviso. */
  avisoCadaMinutos: 5,
};

/** Respuestas del notifier que son errores del publicador: reintentar no sirve. */
export const RECHAZOS_DEFINITIVOS = new Set([400, 409, 413, 415, 422]);

/** La espera tras fallar el `intento`-ésimo: 5 s, 30 s, 2 min, 10 min, 30 min y luego cada hora. */
export function esperaTras(intento: number): number {
  return REGLAS_RELEVO.esperasSegundos[intento - 1] ?? REGLAS_RELEVO.esperaMaximaSegundos;
}

/** Segundos de un Retry-After (número o fecha HTTP), acotados a una hora; null si no se entiende. */
export function segundosDeRetryAfter(valor: string | null, ahora: Date): number | null {
  if (valor === null || valor.trim() === '') return null;
  const texto = valor.trim();
  const segundos = /^\d+$/.test(texto)
    ? Number(texto)
    : (Date.parse(texto) - ahora.getTime()) / 1000;
  if (!Number.isFinite(segundos)) return null;
  return Math.min(REGLAS_RELEVO.esperaMaximaSegundos, Math.max(0, Math.ceil(segundos)));
}

export interface ResultadoRelevo {
  publicados: number;
  reintentos: number;
  fallidos: number;
}

/**
 * Proceso periódico que publica la bandeja (evento_saliente) en el notifier
 * (WEBHOOKS_MODE=notifier). Sigue el patrón de EntregaWebhooks: una corrida a la vez por
 * proceso y, entre instancias, cada evento se toma con FOR UPDATE SKIP LOCKED y un arrendamiento,
 * así el HTTP ocurre fuera de toda transacción y dos procesos no publican el mismo a la vez.
 *
 * Se manda siempre el sobre guardado, byte a byte (el notifier compara su huella por eventId).
 * Según la respuesta:
 * - 202 (guardado) o 200 (ya estaba): PUBLICADO.
 * - 400, 409, 413, 415, 422 (error del publicador): FALLIDO sin reintento y un aviso en el log;
 *   `npm run eventos:reencolar` lo devuelve a PENDIENTE.
 * - 401: el token se invalida y se reintenta en el acto con uno nuevo; si vuelve a dar 401, se
 *   reintenta más tarde.
 * - 429, 5xx, red caída, plazo agotado, sin token, y también 403 (al cliente le falta
 *   events:publish), 3xx o un 4xx inesperado (configuración que se arregla sin perder eventos):
 *   reintento con espera creciente (5 s, 30 s, 2 min, 10 min, 30 min, luego cada hora) o la del
 *   Retry-After si es mayor, hasta 48 h desde que se guardó; después, FALLIDO con un aviso.
 *
 * El orden de llegada no está garantizado: los eventos de un lote se publican a la vez y uno que
 * se reintenta llega después de otros más nuevos. El receptor ordena por occurredAt.
 * La disponibilidad del core no depende del notifier: /health/ready no lo mira.
 *
 * EVENT_RELAY_JOB_ENABLED=false lo apaga (las pruebas lo apagan y llaman a `ejecutar`).
 */
@Injectable()
export class RelevoEventos implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RelevoEventos.name);
  private readonly habilitado: boolean;
  private readonly intervaloSegundos: number;
  private temporizador: NodeJS.Timeout | undefined;
  private corriendo: Promise<ResultadoRelevo> | undefined;
  private ultimoAvisoMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly bandeja: BandejaEventosRepository,
    private readonly notifier: ClienteNotifier,
    private readonly tokens: ClienteTokenIdentity,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.habilitado = config.get<string>('EVENT_RELAY_JOB_ENABLED') !== 'false';
    this.intervaloSegundos =
      config.get<number>('EVENT_RELAY_JOB_INTERVAL_SECONDS') ??
      REGLAS_RELEVO.intervaloPorDefectoSegundos;
  }

  onApplicationBootstrap(): void {
    if (!this.habilitado) {
      this.logger.log('Apagado (EVENT_RELAY_JOB_ENABLED=false)');
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
  ejecutar(): Promise<ResultadoRelevo> {
    this.corriendo ??= this.corrida().finally(() => (this.corriendo = undefined));
    return this.corriendo;
  }

  private async corrida(): Promise<ResultadoRelevo> {
    const resultado: ResultadoRelevo = { publicados: 0, reintentos: 0, fallidos: 0 };
    let atendidos = 0;
    try {
      while (atendidos < REGLAS_RELEVO.maximoPorCorrida) {
        const lote = await this.bandeja.reclamar(
          this.reloj.ahora(),
          REGLAS_RELEVO.lote,
          REGLAS_RELEVO.arrendamientoSegundos,
        );
        if (lote.length === 0) break;
        atendidos += lote.length;
        const salidas = await Promise.allSettled(lote.map((e) => this.publicar(e)));
        salidas.forEach((salida, i) => {
          if (salida.status === 'rejected') {
            // Quedó apartado: vuelve a estar disponible cuando venza el arrendamiento
            this.logger.error(
              `Evento ${lote[i].idEvento} sin registrar: ${(salida.reason as Error).name}`,
            );
            return;
          }
          if (salida.value === 'PUBLICADO') resultado.publicados++;
          else if (salida.value === 'FALLIDO') resultado.fallidos++;
          else if (salida.value === 'PENDIENTE') resultado.reintentos++;
        });
      }
      await this.avisarSiHayAtraso();
    } catch (error) {
      this.logger.error(`Falló el relevo de eventos: ${(error as Error).name}`);
    }
    return resultado;
  }

  private async publicar(e: EventoReclamado): Promise<EstadoEventoSaliente | null> {
    let envio = await this.enviar(e.sobre);
    if (envio.respuesta.codigoHttp === 401) {
      // Token vencido o revocado: uno nuevo y otra vez, en el mismo intento
      this.tokens.invalidar(envio.token);
      envio = await this.enviar(e.sobre);
      if (envio.respuesta.codigoHttp === 401) this.tokens.invalidar(envio.token);
    }
    const { codigoHttp, retryAfter, error } = envio.respuesta;
    const ahora = this.reloj.ahora();
    const codigo = error ?? `HTTP_${codigoHttp}`;
    let decision: { estado: EstadoEventoSaliente; proximoIntento: Date | null };

    if (codigoHttp === 200 || codigoHttp === 202) {
      decision = { estado: 'PUBLICADO', proximoIntento: null };
    } else if (codigoHttp !== null && RECHAZOS_DEFINITIVOS.has(codigoHttp)) {
      decision = { estado: 'FALLIDO', proximoIntento: null };
      this.logger.warn(
        `Evento ${e.idEvento} (${e.tipo}) rechazado por el notifier con HTTP ${codigoHttp}: ` +
          'no se reintenta (npm run eventos:reencolar lo devuelve a PENDIENTE)',
      );
    } else if (ahora.getTime() >= e.reintentarHasta.getTime()) {
      decision = { estado: 'FALLIDO', proximoIntento: null };
      this.logger.warn(
        `Evento ${e.idEvento} (${e.tipo}) sin publicar tras 48 h (${codigo}): queda FALLIDO ` +
          '(npm run eventos:reencolar lo devuelve a PENDIENTE)',
      );
    } else {
      if (codigoHttp === 403) {
        this.logger.warn('El notifier respondió 403: el cliente del core no tiene events:publish');
      }
      const espera = Math.max(esperaTras(e.intentos), segundosDeRetryAfter(retryAfter, ahora) ?? 0);
      const proximo = Math.min(ahora.getTime() + espera * 1000, e.reintentarHasta.getTime());
      decision = { estado: 'PENDIENTE', proximoIntento: new Date(proximo) };
    }

    const exito = decision.estado === 'PUBLICADO';
    const estado = await this.bandeja.registrarResultado(e.idEvento, e.intentos, ahora, {
      estado: decision.estado,
      codigoHttp,
      error: exito ? null : codigo,
      proximoIntento: decision.proximoIntento,
    });
    // Ni el sobre, ni el dueño, ni el token: el id y el tipo bastan para seguir el evento
    this.logger.log(
      `Evento ${e.idEvento} (${e.tipo}) intento ${e.intentos}: ${estado ?? 'NO_APLICADO'} ${codigo}`,
    );
    return estado;
  }

  /** Un intento de publicación, con el token que se usó; nunca lanza. */
  private async enviar(
    sobre: string,
  ): Promise<{ respuesta: ResultadoPublicacion; token: string | undefined }> {
    let token: string;
    try {
      token = await this.tokens.token();
    } catch (error) {
      const codigo = error instanceof TokenNoDisponibleError ? error.codigo : 'TOKEN_ERROR';
      return { respuesta: { codigoHttp: null, retryAfter: null, error: codigo }, token: undefined };
    }
    return { respuesta: await this.notifier.publicar(sobre, token), token };
  }

  /** Si el pendiente más viejo lleva más de 15 minutos, lo dice (como mucho cada 5 minutos). */
  private async avisarSiHayAtraso(): Promise<void> {
    const ahora = this.reloj.ahora().getTime();
    // Si el reloj volvió atrás (un aviso "en el futuro"), se puede avisar de nuevo
    const reciente =
      ahora >= this.ultimoAvisoMs &&
      ahora - this.ultimoAvisoMs < REGLAS_RELEVO.avisoCadaMinutos * 60_000;
    if (reciente) return;
    const desde = await this.bandeja.pendienteMasViejo();
    if (desde === null) return;
    const minutos = Math.floor((ahora - desde.getTime()) / 60_000);
    if (minutos < REGLAS_RELEVO.avisoPendienteMinutos) return;
    this.ultimoAvisoMs = ahora;
    this.logger.warn(
      `El evento pendiente más viejo lleva ${minutos} minutos sin publicarse en el notifier`,
    );
  }
}
