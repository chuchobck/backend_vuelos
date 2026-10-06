import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { clase_cabina, Prisma, tipo_pasajero } from '../../../../generated/prisma/client';
import { fechaIsoAUtc } from '../../../../common/pipes/formatos';
import { cuerpoInvalido } from '../../compartido/errores';
import { fechaLocal, sumarDias } from '../../compartido/fechas';
import { asientosOcupados, ConteoPasajeros, validarPasajeros } from '../../compartido/pasajeros';
import {
  ItinerarioArmado,
  OfertaArmada,
  OpcionTarifa,
  PrecioPasajero,
  SalidaVendible,
  Totales,
} from './busqueda.modelo';
import { BusquedaRepository, FilaTarifaVendible } from './busqueda.repository';
import { SolicitudBusquedaDto } from './dto/solicitud-busqueda.dto';

/**
 * Reglas de la búsqueda. Todas deterministas: la misma búsqueda sobre los mismos datos da las
 * mismas ofertas en el mismo orden (cambian solo los ids, que se generan en cada búsqueda).
 */
export const REGLAS_BUSQUEDA = {
  /** Vigencia de una oferta si SEARCH_OFFER_TTL_MINUTES no dice otra cosa. */
  vigenciaPorDefectoMinutos: 30,
  /** Conexión de una escala: el segundo vuelo sale entre 45 minutos y 6 horas después de llegar. */
  conexionMinimaMinutos: 45,
  conexionMaximaMinutos: 6 * 60,
  /** Entre tramos de un multidestino (o la vuelta), al menos lo mismo que una conexión. */
  separacionMinimaEntreTramosMinutos: 45,
  /** Itinerarios por tramo y aerolínea que entran a combinarse (los más baratos). */
  itinerariosPorTramo: 10,
  /** Ofertas que devuelve una búsqueda, como máximo. */
  maximoOfertas: 20,
  /** Hasta cuántos días hacia adelante se puede buscar. */
  horizonteDias: 365,
};

/**
 * Zona con la fecha más atrasada de Ecuador (Galápagos, UTC-6): una fecha es "pasada" solo si
 * ya terminó también ahí. La salida concreta se filtra después por su instante.
 */
const ZONA_HOY = 'Pacific/Galapagos';

/** Orden del contrato para pricePerPassengerType. */
const ORDEN_TIPOS: tipo_pasajero[] = ['ADULTO', 'JOVEN', 'NINO', 'INFANTE'];
const ORDEN_CABINAS: clase_cabina[] = ['ECONOMICA', 'ECONOMICA_PREMIUM', 'EJECUTIVA', 'PRIMERA'];
const CERO = new Prisma.Decimal(0);
const MINUTO = 60_000;

interface Tramo {
  origen: string;
  destino: string;
  fecha: Date;
}

/** Precios de una familia en una salida, agrupados desde las filas de la consulta. */
interface PrecioEnSalida {
  fila: FilaTarifaVendible;
  porTipo: Map<tipo_pasajero, { base: Prisma.Decimal; impuestos: Prisma.Decimal }>;
}

/**
 * POST /search: arma itinerarios directos y con una escala para cada tramo pedido, les pone
 * las familias tarifarias vendibles, los combina en ofertas de una sola aerolínea y guarda
 * las que devuelve. Solo lee el catálogo y el inventario: no toma cupos ni escribe nada más
 * que las ofertas y sus itinerarios.
 */
@Injectable()
export class BusquedaService {
  private readonly logger = new Logger(BusquedaService.name);
  private readonly vigenciaMinutos: number;

  constructor(
    private readonly repositorio: BusquedaRepository,
    config: ConfigService,
  ) {
    this.vigenciaMinutos =
      config.get<number>('SEARCH_OFFER_TTL_MINUTES') ?? REGLAS_BUSQUEDA.vigenciaPorDefectoMinutos;
  }

  async buscar(solicitud: SolicitudBusquedaDto, huella: string): Promise<OfertaArmada[]> {
    const pasajeros = validarPasajeros(solicitud.passengers, 'passengers');
    const tramos = validarTramos(solicitud);
    const asientos = asientosOcupados(pasajeros);

    const salidasPorTramo = await Promise.all(
      tramos.map((t) => this.repositorio.salidasDelTramo(t.origen, t.destino, t.fecha)),
    );
    const itinerariosPorTramo = tramos.map((tramo, i) =>
      armarItinerarios(tramo, salidasPorTramo[i]),
    );

    const ids = [
      ...new Set(itinerariosPorTramo.flat().flatMap((it) => it.segmentos.map((s) => s.id))),
    ];
    const precios = agruparPrecios(
      await this.repositorio.tarifasVendibles(
        ids,
        asientos,
        pasajeros.map((p) => p.tipo),
      ),
    );
    for (const itinerarios of itinerariosPorTramo) {
      for (const itinerario of itinerarios) {
        itinerario.opciones = opcionesDe(itinerario, precios, pasajeros);
      }
    }

    const ofertas = combinar(
      itinerariosPorTramo.map((its) => its.filter((it) => it.opciones.length > 0)),
    );
    await this.guardar(ofertas, huella);
    return ofertas;
  }

  /** Guarda las ofertas y, aprovechando la escritura, purga las vencidas (no falla la búsqueda). */
  private async guardar(ofertas: OfertaArmada[], huella: string): Promise<void> {
    const ahora = Date.now();
    await this.repositorio.guardarOfertas(
      ofertas,
      huella,
      new Date(ahora),
      new Date(ahora + this.vigenciaMinutos * MINUTO),
    );
    try {
      await this.repositorio.purgarVencidas(new Date(ahora - this.vigenciaMinutos * MINUTO));
    } catch (error) {
      this.logger.warn(`No se pudieron purgar las ofertas vencidas: ${(error as Error).name}`);
    }
  }
}

/** Tramos con origen distinto del destino, fechas desde hoy, dentro del horizonte y en orden. */
function validarTramos(solicitud: SolicitudBusquedaDto): Tramo[] {
  const hoy = fechaLocal(new Date(), ZONA_HOY);
  const limite = sumarDias(hoy, REGLAS_BUSQUEDA.horizonteDias);
  return solicitud.itineraries.map((tramo, i) => {
    const campo = `itineraries[${i}]`;
    if (tramo.origin === tramo.destination) {
      throw cuerpoInvalido(`${campo}.destination`, 'must be different from origin');
    }
    const fecha = fechaIsoAUtc(tramo.departureDate) as Date;
    if (fecha < hoy) throw cuerpoInvalido(`${campo}.departureDate`, 'must not be in the past');
    if (fecha > limite) {
      throw cuerpoInvalido(
        `${campo}.departureDate`,
        `must be within ${REGLAS_BUSQUEDA.horizonteDias} days from today`,
      );
    }
    const anterior = i > 0 ? fechaIsoAUtc(solicitud.itineraries[i - 1].departureDate) : undefined;
    if (anterior && fecha < anterior) {
      throw cuerpoInvalido(`${campo}.departureDate`, 'must not be before the previous itinerary');
    }
    return { origen: tramo.origin, destino: tramo.destination, fecha };
  });
}

/**
 * Itinerarios del tramo: los vuelos directos que salen en la fecha pedida y las escalas de una
 * parada con la misma aerolínea comercializadora y una conexión de 45 minutos a 6 horas.
 */
function armarItinerarios(tramo: Tramo, salidas: SalidaVendible[]): ItinerarioArmado[] {
  const mismaFecha = (s: SalidaVendible) => s.fechaSalida.getTime() === tramo.fecha.getTime();
  const primeras = salidas.filter((s) => s.origen === tramo.origen && mismaFecha(s));
  const segundas = salidas.filter((s) => s.destino === tramo.destino && s.origen !== tramo.origen);

  const itinerarios: SalidaVendible[][] = primeras
    .filter((s) => s.destino === tramo.destino)
    .map((s) => [s]);
  for (const primera of primeras.filter((s) => s.destino !== tramo.destino)) {
    for (const segunda of segundas) {
      const espera = (segunda.salida.getTime() - primera.llegada.getTime()) / MINUTO;
      if (
        segunda.origen === primera.destino &&
        segunda.comercializa === primera.comercializa &&
        espera >= REGLAS_BUSQUEDA.conexionMinimaMinutos &&
        espera <= REGLAS_BUSQUEDA.conexionMaximaMinutos
      ) {
        itinerarios.push([primera, segunda]);
      }
    }
  }
  return itinerarios.map((segmentos) => ({ id: randomUUID(), segmentos, opciones: [] }));
}

/** salida → familia → precios por tipo de pasajero. */
function agruparPrecios(filas: FilaTarifaVendible[]): Map<string, Map<string, PrecioEnSalida>> {
  const porSalida = new Map<string, Map<string, PrecioEnSalida>>();
  for (const fila of filas) {
    const familias = porSalida.get(fila.salida_id) ?? new Map<string, PrecioEnSalida>();
    porSalida.set(fila.salida_id, familias);
    const precio = familias.get(fila.familia_id) ?? { fila, porTipo: new Map() };
    familias.set(fila.familia_id, precio);
    precio.porTipo.set(fila.tipo_pasajero, { base: fila.tarifa_base, impuestos: fila.impuestos });
  }
  return porSalida;
}

/**
 * Familias vendibles en TODOS los segmentos del itinerario, con precio para todos los tipos
 * pedidos y en una sola moneda. El precio de un pasajero es la suma de sus segmentos; el cupo,
 * el menor de los segmentos. De la más barata a la más cara para los pasajeros pedidos.
 */
function opcionesDe(
  itinerario: ItinerarioArmado,
  precios: Map<string, Map<string, PrecioEnSalida>>,
  pasajeros: ConteoPasajeros,
): OpcionTarifa[] {
  const [primero, ...resto] = itinerario.segmentos;
  const opciones: OpcionTarifa[] = [];

  for (const [familiaId, enPrimero] of precios.get(primero.id) ?? []) {
    const porSegmento = [enPrimero, ...resto.map((s) => precios.get(s.id)?.get(familiaId))];
    if (porSegmento.some((p) => p === undefined)) continue;
    const segmentos = porSegmento as PrecioEnSalida[];
    if (segmentos.some((p) => p.fila.moneda !== enPrimero.fila.moneda)) continue;
    if (pasajeros.some((p) => segmentos.some((s) => !s.porTipo.has(p.tipo)))) continue;

    const preciosPasajero: PrecioPasajero[] = ORDEN_TIPOS.filter((tipo) =>
      pasajeros.some((p) => p.tipo === tipo),
    ).map((tipo) => ({
      tipo,
      base: sumar(segmentos.map((s) => s.porTipo.get(tipo)!.base)),
      impuestos: sumar(segmentos.map((s) => s.porTipo.get(tipo)!.impuestos)),
    }));

    const f = enPrimero.fila;
    opciones.push({
      familiaId,
      codigo: f.codigo,
      cabina: f.clase_cabina,
      esCambiable: f.es_cambiable,
      reembolsable: f.porcentaje_penalidad_cancelacion.lessThan(100),
      articuloPersonal: f.incluye_articulo_personal,
      equipajeMano: f.equipaje_mano_incluido,
      equipajeBodega: f.equipaje_bodega_incluido,
      moneda: f.moneda,
      asientosDisponibles: Math.min(...segmentos.map((s) => s.fila.cupos_disponibles)),
      equipajeAdicional: sumar(segmentos.map((s) => s.fila.precio_equipaje_adicional)),
      precios: preciosPasajero,
      totalPasajeros: totalPara(preciosPasajero, pasajeros),
    });
  }

  return opciones.sort(
    (a, b) =>
      a.totalPasajeros.total.comparedTo(b.totalPasajeros.total) ||
      ORDEN_CABINAS.indexOf(a.cabina) - ORDEN_CABINAS.indexOf(b.cabina) ||
      a.codigo.localeCompare(b.codigo),
  );
}

/** Base, impuestos y total de todos los pasajeros pedidos. */
function totalPara(precios: PrecioPasajero[], pasajeros: ConteoPasajeros): Totales {
  let base = CERO;
  let impuestos = CERO;
  for (const { tipo, cantidad } of pasajeros) {
    const precio = precios.find((p) => p.tipo === tipo)!;
    base = base.plus(precio.base.times(cantidad));
    impuestos = impuestos.plus(precio.impuestos.times(cantidad));
  }
  return { base, impuestos, total: base.plus(impuestos) };
}

const sumar = (montos: Prisma.Decimal[]) => montos.reduce((a, b) => a.plus(b), CERO);

const sumarTotales = (a: Totales, b: Totales): Totales => ({
  base: a.base.plus(b.base),
  impuestos: a.impuestos.plus(b.impuestos),
  total: a.total.plus(b.total),
});

/** Desempate estable de dos listas de itinerarios: por la hora y luego por el id de cada salida. */
function compararSegmentos(a: ItinerarioArmado[], b: ItinerarioArmado[]): number {
  const clave = (its: ItinerarioArmado[]) =>
    its.flatMap((it) => it.segmentos.map((s) => `${s.salida.toISOString()}|${s.id}`)).join(',');
  return clave(a).localeCompare(clave(b));
}

interface Parcial {
  itinerarios: ItinerarioArmado[];
  total: Totales;
}

const masBarataPrimero = (a: Parcial, b: Parcial) =>
  a.total.total.comparedTo(b.total.total) || compararSegmentos(a.itinerarios, b.itinerarios);

/**
 * Combina un itinerario por tramo, de la misma aerolínea, cada tramo saliendo al menos 45
 * minutos después de que llega el anterior. Para no explotar con 6 tramos, se avanza tramo a
 * tramo quedándose con las combinaciones más baratas (a lo sumo `maximoOfertas` por paso).
 *
 * Orden final: precio total (con la familia más barata de cada itinerario), luego la hora de
 * salida de cada segmento y el id de la salida para desempatar. Se devuelven a lo sumo 20.
 */
function combinar(itinerariosPorTramo: ItinerarioArmado[][]): OfertaArmada[] {
  const aerolineas = new Set(
    (itinerariosPorTramo[0] ?? []).map((it) => it.segmentos[0].comercializa),
  );
  const ofertas: Parcial[] = [];

  for (const aerolinea of aerolineas) {
    let parciales: Parcial[] = [
      { itinerarios: [], total: { base: CERO, impuestos: CERO, total: CERO } },
    ];
    for (const itinerarios of itinerariosPorTramo) {
      const candidatos = itinerarios
        .filter((it) => it.segmentos[0].comercializa === aerolinea)
        .map((it) => ({ itinerarios: [it], total: it.opciones[0].totalPasajeros }))
        .sort(masBarataPrimero)
        .slice(0, REGLAS_BUSQUEDA.itinerariosPorTramo)
        .map((c) => c.itinerarios[0]);

      const siguientes: Parcial[] = [];
      for (const parcial of parciales) {
        const ultimo = parcial.itinerarios[parcial.itinerarios.length - 1];
        const llegada = ultimo?.segmentos[ultimo.segmentos.length - 1].llegada.getTime();
        for (const itinerario of candidatos) {
          const moneda = itinerario.opciones[0].moneda;
          if (ultimo && moneda !== ultimo.opciones[0].moneda) continue;
          const sale = itinerario.segmentos[0].salida.getTime();
          if (
            llegada !== undefined &&
            sale - llegada < REGLAS_BUSQUEDA.separacionMinimaEntreTramosMinutos * MINUTO
          ) {
            continue;
          }
          siguientes.push({
            itinerarios: [...parcial.itinerarios, itinerario],
            total: sumarTotales(parcial.total, itinerario.opciones[0].totalPasajeros),
          });
        }
      }
      parciales = siguientes.sort(masBarataPrimero).slice(0, REGLAS_BUSQUEDA.maximoOfertas);
    }
    ofertas.push(...parciales.filter((p) => p.itinerarios.length === itinerariosPorTramo.length));
  }

  return ofertas
    .sort(masBarataPrimero)
    .slice(0, REGLAS_BUSQUEDA.maximoOfertas)
    .map((parcial) => {
      const primero = parcial.itinerarios[0].segmentos[0];
      return {
        id: randomUUID(),
        aerolinea: { codigo: primero.comercializa, nombre: primero.nombreComercializa },
        itinerarios: parcial.itinerarios,
        moneda: parcial.itinerarios[0].opciones[0].moneda,
        total: parcial.total,
      };
    });
}
