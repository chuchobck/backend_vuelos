import { Counter, Histogram, Registry } from 'prom-client';
import { CUBETAS_DURACION } from './metricas';

/** Resultados de `core_bookings_total`: una lista cerrada, nunca un id ni un pnr. */
export const RESULTADOS_RESERVA = ['confirmed', 'pending_payment', 'failed', 'declined'] as const;
export type ResultadoReserva = (typeof RESULTADOS_RESERVA)[number];

/** Resultados de `core_relay_publish_total`. */
export const RESULTADOS_PUBLICACION = ['published', 'retry', 'failed'] as const;
export type ResultadoPublicacion = (typeof RESULTADOS_PUBLICACION)[number];

/** Los procesos periódicos del core (etiqueta `job`): una lista cerrada. */
export const JOBS = [
  'relevo-eventos',
  'entrega-webhooks',
  'vencimiento-retenciones',
  'emision-pendiente',
  'pendientes-postventa',
] as const;
export type NombreJob = (typeof JOBS)[number];

/**
 * Las métricas propias del core (prefijo `core_`), en el mismo Registry que las comunes y con las
 * mismas reglas de cardinalidad (docs/OBSERVABILIDAD.md, sección 4): etiquetas de listas cerradas,
 * nunca pnr, ids, correos ni IPs. Las de la bandeja (`core_outbox_*`) están en MetricasBandeja.
 */
export class MetricasCore {
  readonly reservas: Counter<'result'>;
  readonly publicaciones: Counter<'result'>;
  readonly duracionJob: Histogram<'job'>;

  constructor(registro: Registry) {
    this.reservas = new Counter({
      name: 'core_bookings_total',
      help: 'Reservas creadas por resultado: confirmed, pending_payment, failed o declined (pago no autorizado)',
      labelNames: ['result'] as const,
      registers: [registro],
    });
    this.publicaciones = new Counter({
      name: 'core_relay_publish_total',
      help: 'Intentos de publicación de la bandeja al notifier: published, retry (se reintenta) o failed (definitivo)',
      labelNames: ['result'] as const,
      registers: [registro],
    });
    this.duracionJob = new Histogram({
      name: 'core_job_run_duration_seconds',
      help: 'Duración de cada corrida de un proceso periódico, por job',
      labelNames: ['job'] as const,
      buckets: CUBETAS_DURACION,
      registers: [registro],
    });
    // Las series existen en cero desde el arranque: un rate() no empieza ciego
    for (const result of RESULTADOS_RESERVA) this.reservas.inc({ result }, 0);
    for (const result of RESULTADOS_PUBLICACION) this.publicaciones.inc({ result }, 0);
  }
}
