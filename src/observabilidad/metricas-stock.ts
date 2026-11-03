import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { Reloj } from '../common/reloj';
import { StockBookingRepository } from '../modules/vuelos/stock-booking/stock-booking.repository';
import { Observabilidad } from './observabilidad';

/** Cuánto, como mucho, puede tardar la consulta de la cola al raspar /metrics. */
export const PLAZO_CONSULTA_STOCK_MS = 2_000;

/** Una lectura vale esto: los dos gauges de un mismo raspado comparten una sola consulta. */
const VIGENCIA_LECTURA_MS = 1_000;

/**
 * Los gauges de la cola de empuje de stock a Booking (solo con BOOKING_STOCK_ENABLED=true):
 *
 * - `core_stock_pending`: órdenes PENDIENTE (por mandar o por reintentar).
 * - `core_stock_oldest_pending_seconds`: la edad de la orden PENDIENTE más vieja (0 si no hay).
 *
 * Igual que los de la bandeja de eventos: se calculan al raspar, con plazo, y si la base no
 * contesta a tiempo el gauge no se publica en ese raspado. Sin etiquetas: ningún id de vuelo.
 */
@Injectable()
export class MetricasStock implements OnModuleInit {
  private readonly logger = new Logger(MetricasStock.name);
  private lectura: { cuando: number; datos: Promise<{ pendientes: number; desde: Date | null }> };

  constructor(
    private readonly observabilidad: Observabilidad,
    private readonly cola: StockBookingRepository,
    private readonly reloj: Reloj,
  ) {}

  onModuleInit(): void {
    const registers = [this.observabilidad.metricas.registro];
    const pendientes = new Gauge({
      name: 'core_stock_pending',
      help: 'Órdenes de empuje de stock a Booking PENDIENTE (por mandar o por reintentar)',
      registers,
      collect: async () => {
        const lectura = await this.leer();
        if (lectura) pendientes.set(lectura.pendientes);
        else pendientes.remove();
      },
    });
    const masVieja = new Gauge({
      name: 'core_stock_oldest_pending_seconds',
      help: 'Edad en segundos de la orden de stock PENDIENTE más vieja (0 si no hay ninguna)',
      registers,
      collect: async () => {
        const lectura = await this.leer();
        if (lectura) {
          masVieja.set(
            lectura.desde === null
              ? 0
              : Math.max(0, (this.reloj.ahora().getTime() - lectura.desde.getTime()) / 1000),
          );
        } else {
          masVieja.remove();
        }
      },
    });
  }

  /** La lectura de la cola, o null si no llegó a tiempo (o falló). Nunca lanza. */
  private async leer(): Promise<{ pendientes: number; desde: Date | null } | null> {
    const ahora = Date.now();
    if (!this.lectura || ahora - this.lectura.cuando > VIGENCIA_LECTURA_MS) {
      this.lectura = {
        cuando: ahora,
        datos: this.cola.resumenPendientes(PLAZO_CONSULTA_STOCK_MS),
      };
    }
    let temporizador: NodeJS.Timeout | undefined;
    const tope = new Promise<null>((listo) => {
      temporizador = setTimeout(() => listo(null), PLAZO_CONSULTA_STOCK_MS + 500);
    });
    try {
      return await Promise.race([this.lectura.datos, tope]);
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la cola de stock para las métricas: ${(error as Error).name}`,
      );
      return null;
    } finally {
      clearTimeout(temporizador);
    }
  }
}
