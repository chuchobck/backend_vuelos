import { Module } from '@nestjs/common';
import { MetricasStock } from '../../../observabilidad/metricas-stock';
import { ClienteStockBooking } from './cliente-stock-booking';
import { SincronizadorStock } from './sincronizador-stock';
import { StockBookingRepository } from './stock-booking.repository';
import { StockBookingWorker } from './stock-booking.worker';

/**
 * El empuje de stock a Booking: la cola, el cliente HTTP, el trabajador y la sincronización. Solo
 * se importa con BOOKING_STOCK_ENABLED=true (AppModule): apagado no existe y no se toca la red.
 * El registro de las órdenes (OrdenesStock) es aparte y global, para quien mueve el cupo.
 */
@Module({
  providers: [
    StockBookingRepository,
    ClienteStockBooking,
    SincronizadorStock,
    StockBookingWorker,
    MetricasStock,
  ],
  exports: [StockBookingWorker, SincronizadorStock, StockBookingRepository],
})
export class StockBookingModule {}
