import { Global, Module } from '@nestjs/common';
import { OrdenesStock } from './ordenes-stock';

/**
 * El registro de órdenes de empuje de stock, global y siempre presente: quien mueve el cupo (holds,
 * reservas, cambio de fecha, catálogo) lo inyecta sin saber si el empuje está activo. Con
 * BOOKING_STOCK_ENABLED=false `OrdenesStock` no hace nada; el trabajador y el cliente HTTP están en
 * StockBookingModule, que solo se importa con el empuje activo.
 */
@Global()
@Module({
  providers: [OrdenesStock],
  exports: [OrdenesStock],
})
export class OrdenesStockModule {}
