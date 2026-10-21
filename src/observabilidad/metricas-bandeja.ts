import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { Reloj } from '../common/reloj';
import { BandejaEventosRepository } from '../modules/vuelos/operaciones/webhook/bandeja-eventos.repository';
import { Observabilidad } from './observabilidad';

/** Cuánto, como mucho, puede tardar la consulta de la bandeja al raspar /metrics. */
export const PLAZO_CONSULTA_MS = 2_000;

/** Una lectura vale esto: los dos gauges de un mismo raspado comparten una sola consulta. */
const VIGENCIA_LECTURA_MS = 1_000;

/**
 * Los gauges de la bandeja hacia el notifier (solo WEBHOOKS_MODE=notifier, donde la tabla se usa):
 *
 * - `core_outbox_pending`: eventos PENDIENTE (por publicar o por reintentar).
 * - `core_outbox_oldest_pending_seconds`: la edad del PENDIENTE más viejo (0 si no hay).
 *
 * Se calculan al raspar, con una consulta barata (el índice parcial de PENDIENTE) y con plazo:
 * 2 s en la base y 2,5 s en total. Si la base no contesta a tiempo, el gauge no se publica en ese
 * raspado (una serie ausente, no un 0 engañoso ni un raspado colgado). Sin etiquetas: ningún id,
 * dueño ni tipo de evento.
 */
@Injectable()
export class MetricasBandeja implements OnModuleInit {
  private readonly logger = new Logger(MetricasBandeja.name);
  private lectura: { cuando: number; datos: Promise<{ pendientes: number; desde: Date | null }> };

  constructor(
    private readonly observabilidad: Observabilidad,
    private readonly bandeja: BandejaEventosRepository,
    private readonly reloj: Reloj,
  ) {}

  onModuleInit(): void {
    const registers = [this.observabilidad.metricas.registro];
    const pendientes = new Gauge({
      name: 'core_outbox_pending',
      help: 'Eventos PENDIENTE en la bandeja hacia el notifier (por publicar o por reintentar)',
      registers,
      collect: async () => {
        const lectura = await this.leer();
        if (lectura) pendientes.set(lectura.pendientes);
        else pendientes.remove();
      },
    });
    const masViejo = new Gauge({
      name: 'core_outbox_oldest_pending_seconds',
      help: 'Edad en segundos del evento PENDIENTE más viejo de la bandeja (0 si no hay ninguno)',
      registers,
      collect: async () => {
        const lectura = await this.leer();
        if (lectura) {
          masViejo.set(
            lectura.desde === null
              ? 0
              : Math.max(0, (this.reloj.ahora().getTime() - lectura.desde.getTime()) / 1000),
          );
        } else {
          masViejo.remove();
        }
      },
    });
  }

  /** La lectura de la bandeja, o null si no llegó a tiempo (o falló). Nunca lanza. */
  private async leer(): Promise<{ pendientes: number; desde: Date | null } | null> {
    const ahora = Date.now();
    if (!this.lectura || ahora - this.lectura.cuando > VIGENCIA_LECTURA_MS) {
      this.lectura = {
        cuando: ahora,
        datos: this.bandeja.resumenPendientes(PLAZO_CONSULTA_MS),
      };
    }
    let temporizador: NodeJS.Timeout | undefined;
    const tope = new Promise<null>((listo) => {
      temporizador = setTimeout(() => listo(null), PLAZO_CONSULTA_MS + 500);
    });
    try {
      return await Promise.race([this.lectura.datos, tope]);
    } catch (error) {
      this.logger.warn(`No se pudo leer la bandeja para las métricas: ${(error as Error).name}`);
      return null;
    } finally {
      clearTimeout(temporizador);
    }
  }
}
