import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reloj } from '../../../../common/reloj';
import { BandejaEventosRepository } from './bandeja-eventos.repository';

const DIA_MS = 24 * 60 * 60 * 1000;

/** Reglas de la purga de la bandeja de eventos (evento_saliente). */
export const REGLAS_PURGA = {
  /** EVENT_OUTBOX_PURGE_INTERVAL_MINUTES por defecto. */
  intervaloPorDefectoMinutos: 60,
  /** EVENT_OUTBOX_RETENTION_DAYS por defecto: días de un PUBLICADO desde publicado_en. */
  retencionPublicadosDias: 7,
  /** EVENT_OUTBOX_FAILED_RETENTION_DAYS por defecto: días de un FALLIDO desde que falló. */
  retencionFallidosDias: 30,
  /** Filas por sentencia DELETE: lotes chicos para no retener locks ni inflar el WAL de golpe. */
  lote: 1000,
  /** Filas que borra, como mucho, una corrida (lo que quede, en la siguiente). */
  maximoPorCorrida: 20_000,
};

export interface ResultadoPurga {
  publicados: number;
  fallidos: number;
  /** Quedó más por borrar que el tope de la corrida. */
  hayMas: boolean;
  milisegundos: number;
}

/**
 * Proceso periódico que purga la bandeja evento_saliente (solo WEBHOOKS_MODE=notifier: el módulo
 * que lo registra no se importa en local). Sin él la tabla crece sin límite.
 *
 * - PUBLICADO: se borra pasados EVENT_OUTBOX_RETENTION_DAYS (7) días desde publicado_en.
 * - FALLIDO: pasados EVENT_OUTBOX_FAILED_RETENTION_DAYS (30) días desde que falló, para dar tiempo
 *   a diagnosticar y a `npm run eventos:reencolar` (que solo ve filas FALLIDO que existan).
 * - PENDIENTE: jamás, tampoco con el arrendamiento vencido.
 *
 * Los cortes se calculan con la hora del Reloj. Borra en sentencias de 1000 filas, alternando
 * PUBLICADO y FALLIDO, hasta 20 000 por corrida; no usa transacción larga ni toca lo que el
 * relevo tiene tomado. Entre instancias es seguro (FOR UPDATE SKIP LOCKED, ver
 * BandejaEventosRepository.purgarLote). En el log, solo conteos y duración: nunca un sobre, un
 * eventId, un dueño ni un dato de la reserva.
 *
 * EVENT_OUTBOX_PURGE_JOB_ENABLED=false lo apaga (las pruebas lo apagan y llaman a `ejecutar`).
 */
@Injectable()
export class PurgaBandeja implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PurgaBandeja.name);
  private readonly habilitado: boolean;
  private readonly intervaloMinutos: number;
  private readonly retencionPublicadosDias: number;
  private readonly retencionFallidosDias: number;
  private temporizador: NodeJS.Timeout | undefined;
  private corriendo: Promise<ResultadoPurga> | undefined;

  constructor(
    private readonly bandeja: BandejaEventosRepository,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.habilitado = config.get<string>('EVENT_OUTBOX_PURGE_JOB_ENABLED') !== 'false';
    this.intervaloMinutos =
      config.get<number>('EVENT_OUTBOX_PURGE_INTERVAL_MINUTES') ??
      REGLAS_PURGA.intervaloPorDefectoMinutos;
    this.retencionPublicadosDias =
      config.get<number>('EVENT_OUTBOX_RETENTION_DAYS') ?? REGLAS_PURGA.retencionPublicadosDias;
    this.retencionFallidosDias =
      config.get<number>('EVENT_OUTBOX_FAILED_RETENTION_DAYS') ??
      REGLAS_PURGA.retencionFallidosDias;
  }

  onApplicationBootstrap(): void {
    if (!this.habilitado) {
      this.logger.log('Apagado (EVENT_OUTBOX_PURGE_JOB_ENABLED=false)');
      return;
    }
    this.temporizador = setInterval(() => void this.ejecutar(), this.intervaloMinutos * 60_000);
    this.temporizador.unref();
    this.logger.log(
      `Activo: cada ${this.intervaloMinutos} min; PUBLICADO ${this.retencionPublicadosDias} días, ` +
        `FALLIDO ${this.retencionFallidosDias} días`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.temporizador);
    await this.corriendo;
  }

  /** Una corrida; si ya hay una en curso, devuelve esa. Un error se registra y no la detiene. */
  ejecutar(): Promise<ResultadoPurga> {
    this.corriendo ??= this.corrida().finally(() => (this.corriendo = undefined));
    return this.corriendo;
  }

  private async corrida(): Promise<ResultadoPurga> {
    const inicio = performance.now();
    const ahora = this.reloj.ahora();
    const cortes = {
      PUBLICADO: new Date(ahora.getTime() - this.retencionPublicadosDias * DIA_MS),
      FALLIDO: new Date(ahora.getTime() - this.retencionFallidosDias * DIA_MS),
    } as const;
    const borrados = { PUBLICADO: 0, FALLIDO: 0 };
    let hayMas = false;
    try {
      // Una tanda de cada estado por vuelta: uno enorme no deja sin purgar al otro
      const pendientes = new Set<'PUBLICADO' | 'FALLIDO'>(['PUBLICADO', 'FALLIDO']);
      while (pendientes.size > 0) {
        for (const estado of [...pendientes]) {
          const total = borrados.PUBLICADO + borrados.FALLIDO;
          const cupo = Math.min(REGLAS_PURGA.lote, REGLAS_PURGA.maximoPorCorrida - total);
          if (cupo <= 0) {
            hayMas = true;
            pendientes.clear();
            break;
          }
          const n = await this.bandeja.purgarLote(estado, cortes[estado], ahora, cupo);
          borrados[estado] += n;
          // Menos de lo pedido: ya no queda nada vencido en ese estado
          if (n < cupo) pendientes.delete(estado);
        }
      }
    } catch (error) {
      this.logger.error(`Falló la purga de la bandeja de eventos: ${(error as Error).name}`);
    }
    const milisegundos = Math.round(performance.now() - inicio);
    const resultado = {
      publicados: borrados.PUBLICADO,
      fallidos: borrados.FALLIDO,
      hayMas,
      milisegundos,
    };
    if (borrados.PUBLICADO + borrados.FALLIDO > 0 || hayMas) {
      this.logger.log(
        `Purga de la bandeja: ${borrados.PUBLICADO} PUBLICADO y ${borrados.FALLIDO} FALLIDO ` +
          `borrados en ${milisegundos} ms` +
          (hayMas
            ? ` (tope de ${REGLAS_PURGA.maximoPorCorrida} por corrida: sigue en la próxima)`
            : ''),
      );
    }
    return resultado;
  }
}
