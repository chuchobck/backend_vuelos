import { ConfigService } from '@nestjs/config';

/** Donde Booking recibe el stock (contrato que dio su equipo; ver docs/STOCK-BOOKING.md). */
export const URL_STOCK_BOOKING =
  'https://booking-core-api.azurewebsites.net/api/v2/inventory/stock';

/** Su ESB corta a los 5 s: nuestro plazo no pasa de ahí por defecto. */
export const PLAZO_STOCK_BOOKING_MS = 5_000;

/** Zona en que Booking toma `date` y `time_slot`, tal cual y sin convertirlos (Ecuador, UTC-5, sin horario de verano). */
export const ZONA_STOCK_BOOKING = 'America/Guayaquil';

/** Días hacia adelante de la sincronización completa. */
export const DIAS_STOCK_BOOKING = 90;

/** Lo que necesita el empuje de stock, ya validado por entorno.ts. */
export interface ConfiguracionStockBooking {
  url: string;
  serviceId: string;
  plazoMs: number;
  dias: number;
  /** BOOKING_STOCK_TZ: la zona de `date` y `time_slot`. */
  zonaHoraria: string;
}

/** BOOKING_STOCK_ENABLED=true, leído del entorno (para ConditionalModule, antes de ConfigService). */
export function esStockBookingActivo(entorno: NodeJS.ProcessEnv): boolean {
  return entorno.BOOKING_STOCK_ENABLED === 'true';
}

/** BOOKING_STOCK_ENABLED=true, leído de ConfigService. */
export function stockBookingActivo(config: Pick<ConfigService, 'get'>): boolean {
  return config.get<string>('BOOKING_STOCK_ENABLED') === 'true';
}

export function configuracionStockBooking(config: ConfigService): ConfiguracionStockBooking {
  return {
    url: config.get<string>('BOOKING_STOCK_URL') ?? URL_STOCK_BOOKING,
    serviceId: config.getOrThrow<string>('BOOKING_STOCK_SERVICE_ID'),
    plazoMs: config.get<number>('BOOKING_STOCK_TIMEOUT_MS') ?? PLAZO_STOCK_BOOKING_MS,
    dias: config.get<number>('BOOKING_STOCK_DIAS') ?? DIAS_STOCK_BOOKING,
    zonaHoraria: config.get<string>('BOOKING_STOCK_TZ') ?? ZONA_STOCK_BOOKING,
  };
}
