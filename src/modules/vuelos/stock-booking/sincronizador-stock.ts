import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Reloj } from '../../../common/reloj';
import { configuracionStockBooking } from '../../../config/stock-booking';
import { fechaLocal, sumarDias } from '../compartido/fechas';
import { armarRegistro, RegistroStock } from './item-stock';
import { StockBookingRepository } from './stock-booking.repository';

/** La fecha de salida de los vuelos se cuenta en Ecuador continental, como la de /health (v2). */
const ZONA_VENTANA = 'America/Guayaquil';

/**
 * La sincronización completa: todas las claves (salida, cabina) de las salidas de los próximos
 * BOOKING_STOCK_DIAS días, desde hoy. Sirve para la primera carga, para recuperar lo que quedó
 * FALLIDO y para ponerse al día tras un tiempo con el empuje apagado.
 *
 * No manda nada por sí misma: registra una orden por clave (coalesce con las que ya haya) y el
 * trabajador las manda con su concurrencia baja, leyendo el cupo de ese momento.
 */
@Injectable()
export class SincronizadorStock {
  constructor(
    private readonly cola: StockBookingRepository,
    private readonly reloj: Reloj,
    private readonly config: ConfigService,
  ) {}

  /** La ventana: desde hoy hasta hoy + BOOKING_STOCK_DIAS (fechas locales, a medianoche UTC). */
  ventana(): { desde: Date; hasta: Date } {
    const desde = fechaLocal(this.reloj.ahora(), ZONA_VENTANA);
    return { desde, hasta: sumarDias(desde, configuracionStockBooking(this.config).dias) };
  }

  /** Registra las órdenes de la ventana. Devuelve cuántas claves. */
  registrar(): Promise<number> {
    const { desde, hasta } = this.ventana();
    return this.cola.registrarVentana(desde, hasta, this.reloj.ahora(), `corr-${randomUUID()}`);
  }

  /** Lo que mandaría, sin escribir ni llamar a nadie (--dry-run). */
  async simular(): Promise<RegistroStock[]> {
    const { desde, hasta } = this.ventana();
    const { serviceId, zonaHoraria } = configuracionStockBooking(this.config);
    return (await this.cola.listarVentana(desde, hasta)).map((datos) =>
      armarRegistro(serviceId, datos, zonaHoraria),
    );
  }
}
