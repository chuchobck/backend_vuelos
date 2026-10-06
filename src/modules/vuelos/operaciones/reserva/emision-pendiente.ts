import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReservaRepository } from './reserva.repository';
import { ReservaService } from './reserva.service';

/** Reglas del proceso periódico de emisión. */
export const REGLAS_EMISION = {
  /** Cada cuántos segundos corre si BOOKING_ISSUE_JOB_INTERVAL_SECONDS no dice otra cosa. */
  intervaloPorDefectoSegundos: 30,
  /** Reservas que revisa, como mucho, en una corrida (las demás, en la siguiente). */
  maximoPorCorrida: 100,
};

export interface ResultadoEmision {
  /** Reservas con pago aprobado que quedaron CONFIRMADA. */
  confirmadas: number;
  /** Reservas cuyo pago se rechazó (o cuya emisión falló) y quedaron FALLIDA. */
  fallidas: number;
  /** Reservas que siguen esperando el pago. */
  pendientes: number;
}

/**
 * Completa las reservas del 202: las que quedaron PENDIENTE_PAGO. Por cada una consulta el
 * pago a ServicioPagos; aprobado, emite los boletos y la confirma; rechazado, la da por
 * fallida (devuelve asientos y cupo); pendiente, la deja para la siguiente corrida.
 *
 * Nunca corre dos veces a la vez en el mismo proceso (`corriendo`); entre instancias, cada
 * reserva se toma con FOR UPDATE SKIP LOCKED y cambia de estado con un UPDATE condicionado,
 * así ninguna se emite dos veces. Cada reserva es una transacción corta y auditada sin usuario.
 *
 * BOOKING_ISSUE_JOB_ENABLED=false lo apaga (las pruebas lo apagan y llaman a `ejecutar`).
 */
@Injectable()
export class EmisionPendiente implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EmisionPendiente.name);
  private readonly habilitado: boolean;
  private readonly intervaloSegundos: number;
  private temporizador: NodeJS.Timeout | undefined;
  private corriendo: Promise<ResultadoEmision> | undefined;

  constructor(
    private readonly repositorio: ReservaRepository,
    private readonly reservas: ReservaService,
    config: ConfigService,
  ) {
    this.habilitado = config.get<string>('BOOKING_ISSUE_JOB_ENABLED') !== 'false';
    this.intervaloSegundos =
      config.get<number>('BOOKING_ISSUE_JOB_INTERVAL_SECONDS') ??
      REGLAS_EMISION.intervaloPorDefectoSegundos;
  }

  onApplicationBootstrap(): void {
    if (!this.habilitado) return;
    this.temporizador = setInterval(() => void this.ejecutar(), this.intervaloSegundos * 1000);
    this.temporizador.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.temporizador);
    await this.corriendo;
  }

  /** Una corrida; si ya hay una en curso, devuelve esa misma. */
  ejecutar(): Promise<ResultadoEmision> {
    this.corriendo ??= this.corrida().finally(() => (this.corriendo = undefined));
    return this.corriendo;
  }

  private async corrida(): Promise<ResultadoEmision> {
    const resultado: ResultadoEmision = { confirmadas: 0, fallidas: 0, pendientes: 0 };
    let candidatas: Array<{ id: string; referencia: string }>;
    try {
      candidatas = await this.repositorio.pendientesDePago(REGLAS_EMISION.maximoPorCorrida);
    } catch (error) {
      this.logger.error(`No se pudieron leer las reservas pendientes: ${(error as Error).name}`);
      return resultado;
    }
    for (const { id, referencia } of candidatas) {
      try {
        const estado = await this.reservas.procesarPendiente(id, referencia);
        if (estado === 'CONFIRMADA') resultado.confirmadas++;
        else if (estado === 'FALLIDA') resultado.fallidas++;
        else resultado.pendientes++;
      } catch (error) {
        // Una reserva que falla no detiene a las demás; se reintenta en la siguiente corrida
        this.logger.error(`No se pudo procesar la reserva ${id}: ${(error as Error).name}`);
        resultado.pendientes++;
      }
    }
    if (resultado.confirmadas > 0 || resultado.fallidas > 0) {
      this.logger.log(
        `Emisión: ${resultado.confirmadas} confirmadas, ${resultado.fallidas} fallidas, ` +
          `${resultado.pendientes} pendientes`,
      );
    }
    return resultado;
  }
}
