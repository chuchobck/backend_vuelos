import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reloj } from '../../../../common/reloj';
import { IdempotenciaRepository } from '../../compartido/idempotencia.repository';
import { RetencionRepository } from './retencion.repository';

/** Reglas del proceso periódico de vencimiento. */
export const REGLAS_VENCIMIENTO = {
  /** Cada cuántos segundos corre si HOLD_EXPIRY_JOB_INTERVAL_SECONDS no dice otra cosa. */
  intervaloPorDefectoSegundos: 60,
  /** Retenciones que vence, como mucho, en una corrida (lo que quede, en la siguiente). */
  maximoPorCorrida: 500,
};

export interface ResultadoVencimiento {
  /** Retenciones vencidas cuyo cupo volvió en esta corrida. */
  retenciones: number;
  /** Claves de idempotencia vencidas que se borraron. */
  claves: number;
}

/**
 * Proceso periódico que vence las retenciones RETENIDA cuya hora ya pasó (y devuelve su cupo)
 * y borra las claves de idempotencia vencidas. Complementa al vencimiento perezoso de
 * consultar y competir por cupo: sin él, el cupo de un hold abandonado volvería recién cuando
 * alguien lo consultara o pidiera esas salidas.
 *
 * Nunca corre dos veces a la vez en el mismo proceso (`corriendo`); entre varias instancias
 * de la API, cada retención se elige con FOR UPDATE SKIP LOCKED y se cierra con un UPDATE
 * condicionado, así dos corridas simultáneas nunca vencen la misma ni devuelven su cupo dos
 * veces. Cada vencimiento es una transacción corta y auditada, sin usuario (proceso interno).
 *
 * HOLD_EXPIRY_JOB_ENABLED=false lo apaga (las pruebas lo apagan y llaman a `ejecutar`).
 */
@Injectable()
export class VencimientoRetenciones implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(VencimientoRetenciones.name);
  private readonly habilitado: boolean;
  private readonly intervaloSegundos: number;
  private temporizador: NodeJS.Timeout | undefined;
  private corriendo: Promise<ResultadoVencimiento> | undefined;

  constructor(
    private readonly repositorio: RetencionRepository,
    private readonly claves: IdempotenciaRepository,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.habilitado = config.get<string>('HOLD_EXPIRY_JOB_ENABLED') !== 'false';
    this.intervaloSegundos =
      config.get<number>('HOLD_EXPIRY_JOB_INTERVAL_SECONDS') ??
      REGLAS_VENCIMIENTO.intervaloPorDefectoSegundos;
  }

  onApplicationBootstrap(): void {
    if (!this.habilitado) return;
    this.temporizador = setInterval(() => void this.ejecutar(), this.intervaloSegundos * 1000);
    // No mantiene vivo el proceso: al cerrar la API no hay que esperar al siguiente tic.
    this.temporizador.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.temporizador);
    await this.corriendo;
  }

  /**
   * Una corrida. Si ya hay una en curso, devuelve esa misma en vez de empezar otra. Un error
   * se registra y no detiene las corridas siguientes.
   */
  ejecutar(): Promise<ResultadoVencimiento> {
    this.corriendo ??= this.corrida().finally(() => (this.corriendo = undefined));
    return this.corriendo;
  }

  private async corrida(): Promise<ResultadoVencimiento> {
    const ahora = this.reloj.ahora();
    const resultado: ResultadoVencimiento = { retenciones: 0, claves: 0 };
    try {
      while (resultado.retenciones < REGLAS_VENCIMIENTO.maximoPorCorrida) {
        if ((await this.repositorio.vencerSiguiente(ahora)) === null) break;
        resultado.retenciones++;
      }
      resultado.claves = await this.claves.borrarVencidas(ahora);
    } catch (error) {
      this.logger.error(`Falló el vencimiento de retenciones: ${(error as Error).name}`);
    }
    if (resultado.retenciones > 0 || resultado.claves > 0) {
      this.logger.log(
        `Vencidas ${resultado.retenciones} retenciones; borradas ${resultado.claves} claves`,
      );
    }
    return resultado;
  }
}
