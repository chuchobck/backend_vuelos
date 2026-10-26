import { Prisma } from '../../../generated/prisma/client';
import { aInstante } from '../compartido/formatos-salida';
import { aBoleto } from '../operaciones/boleto/boleto.mapper';
import {
  CodigoMotivo,
  CotizacionGuardada,
} from '../operaciones/cancelacion/cancelacion.repository';
import { MotivoCancelacionV2 } from '../operaciones/cancelacion/cancelacion.service';
import { aCheckin } from '../operaciones/checkin/checkin.mapper';
import { ResultadoCheckin } from '../operaciones/checkin/checkin.modelo';
import { aMapaAsientosOferta } from '../operaciones/oferta/oferta.mapper';
import { MapaDeSegmento } from '../operaciones/oferta/oferta.service';
import { aDetalleReserva, aResumenReserva } from '../operaciones/reserva/reserva.mapper';
import { Reserva, ResumenReserva } from '../operaciones/reserva/reserva.modelo';
import { RetencionCreadaDto } from '../operaciones/retencion/dto/respuesta-retencion.dto';
import { aEstadoRetencion } from '../operaciones/retencion/retencion.mapper';
import { Retencion } from '../operaciones/retencion/retencion.modelo';
import { CanalVentaDto } from './dto/comunes-v2.dto';
import {
  CancelacionV2Dto,
  CheckInV2Dto,
  DetalleReservaV2Dto,
  EmisionBoletosDto,
  EstadoRetencionV2Dto,
  ListaReservasV2Dto,
  MapaAsientosV2Dto,
  RetencionCreadaV2Dto,
} from './dto/respuestas-v2.dto';
import { enlacesDeHold, enlacesDeReserva } from './enlaces';
import { DatosV2DeReserva, EstadoAsientoOcupado } from './fachada-v2.repository';

/** Los mappers de la fachada v2: el de v1 de cada entidad más lo que el contrato v2 agrega. */

export function aRetencionCreadaV2(cuerpo: RetencionCreadaDto): RetencionCreadaV2Dto {
  return { ...cuerpo, _links: enlacesDeHold(cuerpo.holdId, 'RETENIDA') };
}

export function aEstadoRetencionV2(retencion: Retencion, ahora: Date): EstadoRetencionV2Dto {
  return {
    holdId: retencion.id,
    ...aEstadoRetencion(retencion, ahora),
    _links: enlacesDeHold(retencion.id, retencion.estado),
  };
}

/**
 * SeatMapResponse v2: el de v1 más `status` por asiento. Un asiento libre de una cabina que se
 * vende es AVAILABLE; uno ocupado, BOOKED, TICKETED o CHECKED_IN según su pasajero; uno de una
 * cabina que no se vende en esta salida no lleva status (SeatStatus no tiene un valor para eso).
 */
export function aMapaAsientosV2(
  mapa: MapaDeSegmento,
  ocupados: Map<bigint, EstadoAsientoOcupado>,
): MapaAsientosV2Dto {
  const base = aMapaAsientosOferta(mapa);
  // aMapaAsientosOferta recorre las filas y los asientos en el mismo orden que mapa.filas
  const filas = base.cabins.flatMap((c) => c.rows);
  return {
    ...base,
    cabins: base.cabins.map((cabina) => ({
      ...cabina,
      rows: cabina.rows.map((fila) => {
        const original = mapa.filas[filas.indexOf(fila)];
        return {
          ...fila,
          seats: fila.seats.map((asiento, j) => {
            const id = original.asiento[j].id;
            const estado = ocupados.get(id) ?? (asiento.isAvailable ? 'AVAILABLE' : undefined);
            return estado === undefined ? asiento : { ...asiento, status: estado };
          }),
        };
      }),
    })),
  };
}

export function aDetalleReservaV2(reserva: Reserva, datos: DatosV2DeReserva): DetalleReservaV2Dto {
  const canal = aCanalVenta(datos.canal);
  return {
    ...aDetalleReserva(reserva),
    holdId: datos.holdId,
    ...(datos.referenciaPago === null ? {} : { paymentReference: datos.referenciaPago }),
    ...(canal === undefined ? {} : { salesChannel: canal }),
    _links: enlacesDeReserva(reserva.id, reserva.estado),
  };
}

/** salesChannel solo si la reserva trae algún dato del canal. */
function aCanalVenta(canal: DatosV2DeReserva['canal']): CanalVentaDto | undefined {
  const dto: CanalVentaDto = {
    ...(canal.socio === null ? {} : { partnerId: canal.socio }),
    ...(canal.orden === null ? {} : { partnerOrderId: canal.orden }),
    ...(canal.paquete === null ? {} : { packageId: canal.paquete }),
    ...(canal.promocion === null ? {} : { promotionApplied: canal.promocion }),
    ...(canal.descuento === null ? {} : { discountPercentage: canal.descuento }),
  };
  return Object.keys(dto).length === 0 ? undefined : dto;
}

export function aListaReservasV2(pagina: {
  filas: ResumenReserva[];
  nextCursor?: string;
}): ListaReservasV2Dto {
  return {
    nextCursor: pagina.nextCursor ?? null,
    items: pagina.filas.map((fila) => ({
      ...aResumenReserva(fila),
      _links: enlacesDeReserva(fila.id, fila.estado),
    })),
  };
}

/** TicketIssuanceResponse: `issued` son los boletos que salieron en esta llamada. */
export function aEmisionBoletos(reserva: Reserva, emitidos: number): EmisionBoletosDto {
  return {
    bookingId: reserva.id,
    pnr: reserva.pnr,
    status: reserva.estado === 'CONFIRMADA' ? 'CONFIRMED' : 'TICKET_ISSUING',
    tickets: reserva.boletos.map(aBoleto),
    issued: emitidos,
    _links: enlacesDeReserva(reserva.id, reserva.estado),
  };
}

export function aCheckinV2(resultado: ResultadoCheckin): CheckInV2Dto {
  const base = aCheckin(resultado);
  return {
    ...base,
    _links: {
      self: { href: `/api/v2/vuelos/bookings/${resultado.reservaId}`, method: 'GET' },
      'boarding-passes': {
        href: `/api/v2/vuelos/bookings/${resultado.reservaId}/boarding-passes`,
        method: 'GET',
      },
    },
  };
}

/** cotizacion_cancelacion.codigo_motivo → reasonCode. Una cancelación de v1 no tiene motivo. */
const MOTIVO_CONTRATO: Readonly<Record<CodigoMotivo, MotivoCancelacionV2>> = {
  SOLICITUD_CLIENTE: 'CUSTOMER_REQUEST',
  COMPENSACION_SAGA: 'SAGA_COMPENSATION',
  VUELO_CANCELADO: 'FLIGHT_CANCELLED',
  OTRO: 'OTHER',
};

const CIEN = new Prisma.Decimal(100);

/**
 * CancelBookingResponse. refund.status: NOT_REFUNDABLE si no hay nada que devolver;
 * CALCULATED si cobró Booking (lo ejecuta Booking) o si la Payment API todavía no lo resolvió;
 * SETTLED si la Payment API de la aerolínea ya lo hizo. ticketsVoided son los ticketId anulados
 * (o reembolsados) de la reserva.
 */
export function aCancelacionV2(
  reserva: Reserva,
  cancelacion: CotizacionGuardada,
  datos: DatosV2DeReserva,
  asientosLiberados: number,
): CancelacionV2Dto {
  const cancelada = reserva.estado === 'CANCELADA';
  const total = reserva.total.total;
  const devuelve = cancelacion.reembolso.greaterThan(0);
  const estadoReembolso = !devuelve
    ? 'NOT_REFUNDABLE'
    : datos.proveedorPago !== 'BOOKING_PROTOTIPO' && cancelada
      ? 'SETTLED'
      : 'CALCULATED';
  const porcentaje = total.greaterThan(0)
    ? cancelacion.reembolso.times(CIEN).div(total).toDecimalPlaces(2).toNumber()
    : 0;
  return {
    bookingId: reserva.id,
    pnr: reserva.pnr,
    status: cancelada ? 'CANCELLED' : 'CANCELLATION_PENDING',
    ...(cancelacion.aceptada === null ? {} : { cancelledAt: aInstante(cancelacion.aceptada) }),
    reasonCode: MOTIVO_CONTRATO[cancelacion.codigoMotivo ?? 'SOLICITUD_CLIENTE'],
    refund: {
      refundId: cancelacion.id,
      amount: cancelacion.reembolso.toFixed(2),
      penaltyAmount: cancelacion.penalidad.toFixed(2),
      currency: reserva.total.moneda,
      percentage: porcentaje,
      ...(datos.referenciaPago === null ? {} : { originalPaymentReference: datos.referenciaPago }),
      status: estadoReembolso,
    },
    ticketsVoided: reserva.boletos
      .filter((b) => b.estado === 'ANULADO' || b.estado === 'REEMBOLSADO')
      .map((b) => b.id),
    inventoryRestoration: {
      status: 'RESTORED',
      seatsReleased: asientosLiberados,
      newSeatStatus: 'AVAILABLE',
    },
    message: !cancelada
      ? 'Cancellation accepted; seats released; the refund is pending in the Payment API'
      : !devuelve
        ? 'Booking cancelled; seats released; nothing to refund'
        : estadoReembolso === 'SETTLED'
          ? 'Booking cancelled; seats released and refund settled'
          : 'Booking cancelled; seats released and refund calculated',
    _links: { self: { href: `/api/v2/vuelos/bookings/${reserva.id}`, method: 'GET' } },
  };
}
