import { estado_reserva, estado_retencion } from '../../../generated/prisma/client';

/** Base de las rutas de la fachada: la URL pública que ve Booking. */
export const BASE_V2 = '/api/v2/vuelos';

/** components.schemas.Link del contrato v2. */
export interface Enlace {
  href: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

/** components.schemas.Links: acciones disponibles según el estado actual del recurso. */
export type Enlaces = Record<string, Enlace>;

const reserva = (id: string, resto = '') => `${BASE_V2}/bookings/${id}${resto}`;

/** Un hold: verlo siempre; liberarlo y reservar con él mientras sigue retenido. */
export function enlacesDeHold(holdId: string, estado: estado_retencion): Enlaces {
  const enlaces: Enlaces = { self: { href: `${BASE_V2}/offers/hold/${holdId}`, method: 'GET' } };
  if (estado === 'RETENIDA') {
    enlaces.release = { href: `${BASE_V2}/offers/hold/${holdId}`, method: 'DELETE' };
    enlaces.book = { href: `${BASE_V2}/bookings`, method: 'POST' };
  }
  return enlaces;
}

/**
 * Una reserva: verla y sus boletos siempre; emitir mientras espera su pago o su emisión; check-in,
 * pases, maletas, cambio de fecha, cotizar y cancelar solo CONFIRMADA (las demás lo rechazan).
 */
export function enlacesDeReserva(id: string, estado: estado_reserva): Enlaces {
  const enlaces: Enlaces = {
    self: { href: reserva(id), method: 'GET' },
    tickets: { href: reserva(id, '/tickets'), method: 'GET' },
  };
  if (estado === 'PENDIENTE_PAGO' || estado === 'EMITIENDO_BOLETOS') {
    enlaces['issue-tickets'] = { href: reserva(id, '/tickets'), method: 'POST' };
  }
  if (estado === 'CONFIRMADA') {
    enlaces['check-in'] = { href: reserva(id, '/check-in'), method: 'POST' };
    enlaces['boarding-passes'] = { href: reserva(id, '/boarding-passes'), method: 'GET' };
    enlaces['baggage-options'] = { href: reserva(id, '/baggage-options'), method: 'GET' };
    enlaces['date-change'] = { href: reserva(id, '/date-change/search'), method: 'POST' };
    enlaces['cancellation-quote'] = { href: reserva(id, '/cancellation-quote'), method: 'GET' };
    enlaces.cancel = { href: reserva(id, '/cancel'), method: 'POST' };
  }
  return enlaces;
}
