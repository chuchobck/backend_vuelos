import { PagoDeFachada } from '../compartido/pagos/servicio-pagos';
import { OrigenReserva } from '../operaciones/reserva/reserva.repository';
import { CanalVentaDto, PagoV2Dto } from './dto/comunes-v2.dto';
import { UsuarioV2 } from './partner/usuario-v2';

/** Lo que entra por la fachada v2, en la forma que esperan los services de v1. */

/** PaymentReference → el pago de la fachada. Sin provider, BOOKING_PROTOTIPO (contrato v2). */
export function aPagoDeFachada(pago: PagoV2Dto): PagoDeFachada {
  return {
    proveedor: pago.provider === 'AIRLINE_DIRECT' ? 'AEROLINEA' : 'BOOKING_PROTOTIPO',
    ...(pago.amount ? { monto: { moneda: pago.amount.currency, total: pago.amount.total } } : {}),
  };
}

/**
 * El origen de una reserva v2: el partner (client_id) y su usuario final (X-User-Id) si el token
 * es de partner, y el salesChannel si llegó. Una persona sin salesChannel no tiene origen.
 */
export function aOrigenReserva(
  usuario: UsuarioV2,
  canal: CanalVentaDto | undefined,
): OrigenReserva | undefined {
  if (usuario.clienteId === undefined && canal === undefined) return undefined;
  return {
    ...(usuario.clienteId === undefined ? {} : { idCliente: usuario.clienteId }),
    ...(usuario.usuarioExterno === undefined ? {} : { usuarioExterno: usuario.usuarioExterno }),
    ...(canal === undefined
      ? {}
      : {
          canal: {
            socio: canal.partnerId,
            orden: canal.partnerOrderId,
            paquete: canal.packageId,
            promocion: canal.promotionApplied,
            descuento: canal.discountPercentage,
          },
        }),
  };
}
