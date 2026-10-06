import { aBoleto } from '../boleto/boleto.mapper';
import { aItinerario, aMonto } from '../busqueda/busqueda.mapper';
import { ESTADO_RESERVA, GENERO, TIPO_DOCUMENTO, TIPO_PASAJERO } from '../../compartido/enums';
import { aFecha, aInstante } from '../../compartido/formatos-salida';
import { PasajeroReservaDto } from './dto/solicitud-reserva.dto';
import {
  DetalleReservaDto,
  ListaReservasDto,
  ResumenReservaDto,
} from './dto/respuesta-reserva.dto';
import {
  ItinerarioDeReserva,
  MontoReserva,
  PasajeroDeReserva,
  Reserva,
  ResumenReserva,
} from './reserva.modelo';

const aTotal = (monto: MontoReserva) =>
  aMonto(monto.moneda, { base: monto.base, impuestos: monto.impuestos, total: monto.total });

/**
 * El itinerario con el formato de la búsqueda (ItineraryOption). pricingOptions lleva solo la
 * familia vendida: el hold congela el total del itinerario, no el precio de cada tipo de
 * pasajero, así que pricePerPassengerType va vacío.
 */
function aItinerarioReservado(itinerario: ItinerarioDeReserva, moneda: string) {
  const { familia } = itinerario;
  return aItinerario({
    id: itinerario.id,
    segmentos: itinerario.salidas,
    opciones: [
      {
        familiaId: '',
        codigo: familia.codigo,
        cabina: familia.cabina,
        esCambiable: familia.esCambiable,
        reembolsable: familia.reembolsable,
        articuloPersonal: familia.articuloPersonal,
        equipajeMano: familia.equipajeMano,
        equipajeBodega: familia.equipajeBodega,
        moneda,
        asientosDisponibles: familia.asientosDisponibles,
        equipajeAdicional: familia.equipajeAdicional,
        precios: [],
        totalPasajeros: {
          base: itinerario.base,
          impuestos: itinerario.impuestos,
          total: itinerario.base.plus(itinerario.impuestos),
        },
      },
    ],
  });
}

export function aPasajero(pasajero: PasajeroDeReserva): PasajeroReservaDto {
  return {
    passengerId: pasajero.codigo,
    passengerType: TIPO_PASAJERO.aContrato(pasajero.tipo),
    ...(pasajero.adultoResponsable ? { associatedAdultId: pasajero.adultoResponsable } : {}),
    firstName: pasajero.nombres,
    lastName: pasajero.apellidos,
    documentType: TIPO_DOCUMENTO.aContrato(pasajero.tipoDocumento),
    documentNumber: pasajero.numeroDocumento,
    nationality: pasajero.nacionalidad,
    ...(pasajero.vencimientoDocumento
      ? { documentExpiryDate: aFecha(pasajero.vencimientoDocumento) }
      : {}),
    birthDate: aFecha(pasajero.nacimiento),
    gender: GENERO.aContrato(pasajero.genero),
    contact: { email: pasajero.correo, phone: pasajero.telefono },
    assignedSeats: pasajero.asientos.map((a) => ({ segmentId: a.salidaId, seatNumber: a.numero })),
    extraBaggage: pasajero.equipaje.map((e) => ({
      itineraryId: e.itinerarioId,
      quantity: e.cantidad,
    })),
  };
}

export function aDetalleReserva(reserva: Reserva): DetalleReservaDto {
  return {
    bookingId: reserva.id,
    pnr: reserva.pnr,
    status: ESTADO_RESERVA.aContrato(reserva.estado),
    grandTotal: aTotal(reserva.total),
    createdAt: aInstante(reserva.creada),
    updatedAt: aInstante(reserva.actualizada),
    itineraries: reserva.itinerarios.map((it) => aItinerarioReservado(it, reserva.total.moneda)),
    passengers: reserva.pasajeros.map(aPasajero),
    tickets: reserva.boletos.map(aBoleto),
    changes: reserva.historial.map((h) => ({
      changedAt: aInstante(h.fecha),
      description: h.descripcion,
    })),
  };
}

export function aResumenReserva(reserva: ResumenReserva): ResumenReservaDto {
  return {
    bookingId: reserva.id,
    pnr: reserva.pnr,
    status: ESTADO_RESERVA.aContrato(reserva.estado),
    origin: reserva.origen,
    destination: reserva.destino,
    departureDate: aFecha(reserva.fechaSalida),
    grandTotal: aTotal(reserva.total),
  };
}

export function aListaReservas(pagina: {
  filas: ResumenReserva[];
  nextCursor?: string;
}): ListaReservasDto {
  const items = pagina.filas.map(aResumenReserva);
  return pagina.nextCursor === undefined ? { items } : { items, nextCursor: pagina.nextCursor };
}
