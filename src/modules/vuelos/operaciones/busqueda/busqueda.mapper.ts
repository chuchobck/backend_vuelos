import { MontoDto } from '../../compartido/dto/monto.dto';
import { CABINA, ESTADO_VUELO, TIPO_PASAJERO } from '../../compartido/enums';
import { aInstante, aTextoDecimal } from '../../compartido/formatos-salida';
import {
  ItinerarioArmado,
  OfertaArmada,
  OpcionTarifa,
  SalidaVendible,
  Totales,
} from './busqueda.modelo';
import {
  OfertaVueloDto,
  OpcionItinerarioDto,
  PrecioCabinaDto,
  RespuestaBusquedaDto,
  SegmentoVueloDto,
} from './dto/respuesta-busqueda.dto';

const MILISEGUNDOS_POR_MINUTO = 60_000;

const minutosEntre = (desde: Date, hasta: Date): number =>
  Math.round((hasta.getTime() - desde.getTime()) / MILISEGUNDOS_POR_MINUTO);

export function aMonto(moneda: string, totales: Totales): MontoDto {
  return {
    currency: moneda,
    baseFare: aTextoDecimal(totales.base),
    taxes: aTextoDecimal(totales.impuestos),
    total: aTextoDecimal(totales.total),
  };
}

function aSegmento(salida: SalidaVendible, anterior: SalidaVendible | undefined): SegmentoVueloDto {
  return {
    segmentId: salida.id,
    flightNumber: salida.numeroVuelo,
    departure: {
      iataCode: salida.origen,
      at: aInstante(salida.salida),
      terminal: salida.terminalSalida,
    },
    arrival: {
      iataCode: salida.destino,
      at: aInstante(salida.llegada),
      terminal: salida.terminalLlegada,
    },
    // El contrato lo deja opcional: solo tiene sentido desde el segundo segmento
    ...(anterior ? { layoverMinutes: minutosEntre(anterior.llegada, salida.salida) } : {}),
    marketingCarrier: salida.comercializa,
    operatingCarrier: salida.opera,
    aircraft: salida.modelo,
    durationMinutes: minutosEntre(salida.salida, salida.llegada),
    status: ESTADO_VUELO.aContrato(salida.estado),
  };
}

function aPrecioCabina(opcion: OpcionTarifa): PrecioCabinaDto {
  return {
    cabinClass: CABINA.aContrato(opcion.cabina),
    fareBrand: opcion.codigo,
    availableSeats: opcion.asientosDisponibles,
    fareRules: { isRefundable: opcion.reembolsable, isChangeable: opcion.esCambiable },
    baggageAllowance: {
      personalItemIncluded: opcion.articuloPersonal,
      carryOnIncluded: opcion.equipajeMano,
      checkedBaggageIncluded: opcion.equipajeBodega,
    },
    extraCheckedBaggagePrice: {
      currency: opcion.moneda,
      total: aTextoDecimal(opcion.equipajeAdicional),
    },
    pricePerPassengerType: opcion.precios.map((precio) => ({
      passengerType: TIPO_PASAJERO.aContrato(precio.tipo),
      price: aMonto(opcion.moneda, {
        base: precio.base,
        impuestos: precio.impuestos,
        total: precio.base.plus(precio.impuestos),
      }),
    })),
  };
}

export function aItinerario(itinerario: ItinerarioArmado): OpcionItinerarioDto {
  const { segmentos } = itinerario;
  return {
    itineraryId: itinerario.id,
    totalDurationMinutes: minutosEntre(
      segmentos[0].salida,
      segmentos[segmentos.length - 1].llegada,
    ),
    stopsCount: segmentos.length - 1,
    segments: segmentos.map((salida, i) => aSegmento(salida, segmentos[i - 1])),
    pricingOptions: itinerario.opciones.map(aPrecioCabina),
  };
}

export function aOfertaVuelo(oferta: OfertaArmada): OfertaVueloDto {
  return {
    offerId: oferta.id,
    airline: { code: oferta.aerolinea.codigo, name: oferta.aerolinea.nombre },
    itineraries: oferta.itinerarios.map(aItinerario),
    grandTotal: aMonto(oferta.moneda, oferta.total),
  };
}

export function aRespuestaBusqueda(ofertas: OfertaArmada[]): RespuestaBusquedaDto {
  return { totalOffers: ofertas.length, offers: ofertas.map(aOfertaVuelo) };
}
