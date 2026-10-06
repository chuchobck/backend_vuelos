import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reloj } from '../../../common/reloj';
import { CambioFechaService } from './cambio-fecha/cambio-fecha.service';
import { CambioFechaRepository } from './cambio-fecha/cambio-fecha.repository';
import { CancelacionRepository } from './cancelacion/cancelacion.repository';
import { CancelacionService } from './cancelacion/cancelacion.service';
import { EquipajeRepository } from './equipaje/equipaje.repository';
import { EquipajeService } from './equipaje/equipaje.service';

/** Reglas del proceso periódico de postventa. */
export const REGLAS_POSTVENTA = {
  /** Cada cuántos segundos corre si POSTSALE_JOB_INTERVAL_SECONDS no dice otra cosa. */
  intervaloPorDefectoSegundos: 30,
  /** Pendientes de cada tipo que revisa, como mucho, en una corrida. */
  maximoPorCorrida: 100,
};

export interface ResultadoPostventa {
  /** Compras de maletas con el pago resuelto (aprobado o rechazado). */
  equipaje: number;
  /** Cambios de fecha resueltos. */
  cambios: number;
  /** Cancelaciones completadas (reembolso aprobado). */
  cancelaciones: number;
  /** Ofertas de cambio y cotizaciones vencidas que se borraron. */
  purgadas: number;
}

/**
 * Hermano de EmisionPendiente para la postventa: completa lo que quedó en 202. Por cada
 * pendiente consulta a ServicioPagos y, en una transacción corta por pendiente tomada con
 * FOR UPDATE SKIP LOCKED y auditada sin usuario:
 *
 * - maletas con pago pendiente: aprobado, cuentan; rechazado, dejan de contar;
 * - cambios de fecha (CAMBIO_PENDIENTE): aprobado, se aplican; rechazado, se deshacen;
 * - cancelaciones (CANCELACION_PENDIENTE): reembolso aprobado, quedan CANCELADA.
 *
 * Además purga las ofertas de cambio y las cotizaciones vencidas que nadie aceptó. Una corrida
 * a la vez por proceso; entre instancias, SKIP LOCKED y los UPDATE condicionados. Un pendiente
 * que falla no detiene a los demás. POSTSALE_JOB_ENABLED=false lo apaga (las pruebas llaman a
 * `ejecutar`).
 */
@Injectable()
export class PendientesPostventa implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PendientesPostventa.name);
  private readonly habilitado: boolean;
  private readonly intervaloSegundos: number;
  private temporizador: NodeJS.Timeout | undefined;
  private corriendo: Promise<ResultadoPostventa> | undefined;

  constructor(
    private readonly equipaje: EquipajeService,
    private readonly equipajes: EquipajeRepository,
    private readonly cambio: CambioFechaService,
    private readonly cambios: CambioFechaRepository,
    private readonly cancelacion: CancelacionService,
    private readonly cancelaciones: CancelacionRepository,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.habilitado = config.get<string>('POSTSALE_JOB_ENABLED') !== 'false';
    this.intervaloSegundos =
      config.get<number>('POSTSALE_JOB_INTERVAL_SECONDS') ??
      REGLAS_POSTVENTA.intervaloPorDefectoSegundos;
  }

  onApplicationBootstrap(): void {
    // Una línea al arrancar: en el log de cada instancia se ve qué procesos corren y cada cuánto
    if (!this.habilitado) {
      this.logger.log('Apagado (POSTSALE_JOB_ENABLED=false)');
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

  /** Una corrida; si ya hay una en curso, devuelve esa misma. */
  ejecutar(): Promise<ResultadoPostventa> {
    this.corriendo ??= this.corrida().finally(() => (this.corriendo = undefined));
    return this.corriendo;
  }

  private async corrida(): Promise<ResultadoPostventa> {
    const resultado: ResultadoPostventa = {
      equipaje: 0,
      cambios: 0,
      cancelaciones: 0,
      purgadas: 0,
    };
    const limite = REGLAS_POSTVENTA.maximoPorCorrida;
    resultado.equipaje = await this.procesar(
      'maletas',
      () => this.equipajes.pendientes(limite),
      (p) => this.equipaje.procesarPendiente(p),
    );
    resultado.cambios = await this.procesar(
      'cambios',
      () => this.cambios.pendientes(limite),
      (p) => this.cambio.procesarPendiente(p),
    );
    resultado.cancelaciones = await this.procesar(
      'cancelaciones',
      () => this.cancelaciones.pendientes(limite),
      (p) => this.cancelacion.procesarPendiente(p),
    );
    try {
      const ahora = this.reloj.ahora();
      resultado.purgadas =
        (await this.cambios.purgarVencidas(ahora)) +
        (await this.cancelaciones.purgarVencidas(ahora));
    } catch (error) {
      this.logger.error(`No se pudieron purgar las ofertas vencidas: ${(error as Error).name}`);
    }
    if (resultado.equipaje + resultado.cambios + resultado.cancelaciones > 0) {
      this.logger.log(
        `Postventa: ${resultado.equipaje} maletas, ${resultado.cambios} cambios y ` +
          `${resultado.cancelaciones} cancelaciones resueltos`,
      );
    }
    return resultado;
  }

  /** Procesa cada pendiente por separado; devuelve cuántos resolvió. */
  private async procesar<T>(
    nombre: string,
    leer: () => Promise<T[]>,
    resolver: (pendiente: T) => Promise<unknown>,
  ): Promise<number> {
    let pendientes: T[];
    try {
      pendientes = await leer();
    } catch (error) {
      this.logger.error(
        `No se pudieron leer los pendientes de ${nombre}: ${(error as Error).name}`,
      );
      return 0;
    }
    let resueltos = 0;
    for (const pendiente of pendientes) {
      try {
        if (await resolver(pendiente)) resueltos++;
      } catch (error) {
        this.logger.error(
          `No se pudo resolver un pendiente de ${nombre}: ${(error as Error).name}`,
        );
      }
    }
    return resueltos;
  }
}
