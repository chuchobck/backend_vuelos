import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { CodigoError } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { Reloj } from '../../../../common/reloj';
import { Prisma, tipo_pasajero } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { cuerpoInvalido } from '../../compartido/errores';
import { ConteoPasajeros } from '../../compartido/pasajeros';
import { ItinerarioArmado, SalidaVendible } from '../busqueda/busqueda.modelo';
import {
  BusquedaService,
  REGLAS_BUSQUEDA,
  validarFechaDeSalida,
} from '../busqueda/busqueda.service';
import {
  exigirConfirmada,
  exigirSinDespegar,
  itinerarioDeLaReserva,
} from '../reserva/reglas-postventa';
import { ItinerarioDeReserva, Reserva } from '../reserva/reserva.modelo';
import { ReservaService } from '../reserva/reserva.service';
import { DiferenciaPrecio, OpcionCambio } from './cambio-fecha.modelo';
import { CambioFechaRepository, OfertaCambioNueva } from './cambio-fecha.repository';
import { SolicitudBusquedaCambioDto } from './dto/cambio-fecha.dto';

/** Reglas del cambio de fecha. */
export const REGLAS_CAMBIO = {
  /** Vigencia de una oferta de cambio si CHANGE_OFFER_TTL_MINUTES no dice otra cosa. */
  vigenciaOfertaPorDefectoMinutos: 15,
  /** Itinerarios por cambio que entran a combinarse (los más baratos). */
  candidatosPorCambio: 10,
  /** Ofertas que devuelve una búsqueda de cambio, como máximo. */
  maximoOfertas: 10,
};

const MINUTO = 60_000;
const CERO = new Prisma.Decimal(0);
const ORDEN_TIPOS: tipo_pasajero[] = ['ADULTO', 'JOVEN', 'NINO', 'INFANTE'];

/** Un itinerario nuevo posible para uno de los cambios pedidos, con su diferencia. */
interface Candidato {
  linea: ItinerarioDeReserva;
  lineaId: bigint;
  nuevo: ItinerarioArmado;
  tarifa: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  cargo: Prisma.Decimal;
}

/**
 * Cambio de fecha (POST .../date-change/search y POST .../date-change).
 *
 * Buscar: para cada itinerario a cambiar, las salidas de la misma ruta (origen del primer vuelo
 * y destino del último) y la misma aerolínea en la nueva fecha, con la misma familia tarifaria
 * (misma cabina) vendible y con cupo para los pasajeros con asiento. Lo arma la búsqueda
 * (BusquedaService.itinerariosConPrecio): las mismas consultas y las mismas reglas de escala.
 *
 * Precio, para todos los pasajeros:
 * - fareDifference = tarifa nueva − tarifa pagada; taxDifference = impuestos nuevos − pagados.
 * - changeFee = `cargo_cambio` de las tarifas del itinerario que se reemplaza (el catálogo lo
 *   fija por familia y vuelo; la semilla lo calcula como % de la tarifa base de un adulto) por
 *   cada pasajero con asiento. Una familia no cambiable (`es_cambiable = false`) es 409
 *   FARE_NOT_CHANGEABLE.
 * - totalToPay = max(0, fareDifference + taxDifference) + changeFee: lo que baja la tarifa no se
 *   devuelve, y el cargo se cobra siempre.
 *
 * Cada combinación (un itinerario nuevo por cambio, en orden con los itinerarios que no cambian)
 * se guarda como una oferta de cambio OFERTADO, vigente CHANGE_OFFER_TTL_MINUTES. No toma cupo.
 */
@Injectable()
export class CambioFechaService {
  private readonly logger = new Logger(CambioFechaService.name);
  private readonly vigenciaMinutos: number;

  constructor(
    private readonly repositorio: CambioFechaRepository,
    private readonly reservas: ReservaService,
    private readonly busqueda: BusquedaService,
    private readonly prisma: PrismaService,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.vigenciaMinutos =
      config.get<number>('CHANGE_OFFER_TTL_MINUTES') ??
      REGLAS_CAMBIO.vigenciaOfertaPorDefectoMinutos;
  }

  async buscar(
    reservaId: string,
    solicitud: SolicitudBusquedaCambioDto,
    idPropietario: string,
  ): Promise<OpcionCambio[]> {
    const ahora = this.reloj.ahora();
    const reserva = await this.reservas.detalle(reservaId, idPropietario);
    exigirConfirmada(reserva, 'a date change');

    const vistos = new Set<string>();
    const pedidos = solicitud.changes.map((cambio, i) => {
      const campo = `changes[${i}]`;
      const id = cambio.itineraryId.toLowerCase();
      if (vistos.has(id)) throw cuerpoInvalido(`${campo}.itineraryId`, 'is repeated');
      vistos.add(id);
      const linea = itinerarioDeLaReserva(reserva, id, `${campo}.itineraryId`);
      if (!linea.familia.esCambiable) {
        throw new ErrorNegocio(
          409,
          CodigoError.FARE_NOT_CHANGEABLE,
          `Fare ${linea.familia.codigo} of itinerary ${linea.id} does not allow date changes`,
        );
      }
      exigirSinDespegar([linea], ahora);
      const fecha = validarFechaDeSalida(cambio.newDepartureDate, `${campo}.newDepartureDate`);
      return { linea, fecha };
    });

    const pasajeros = conteoDe(reserva);
    const conAsiento = pasajeros
      .filter((p) => p.tipo !== 'INFANTE')
      .reduce((suma, p) => suma + p.cantidad, 0);
    const porTramo = await this.busqueda.itinerariosConPrecio(
      pedidos.map(({ linea, fecha }) => ({
        origen: linea.salidas[0].origen,
        destino: linea.salidas[linea.salidas.length - 1].destino,
        fecha,
      })),
      pasajeros,
    );

    const candidatosPorCambio: Candidato[][] = [];
    for (const [i, { linea }] of pedidos.entries()) {
      const lineaId = (await this.repositorio.lineaVigente(reserva.id, linea.id))!;
      const cargo = (await this.repositorio.cargoPorPersona(lineaId)).times(conAsiento);
      candidatosPorCambio.push(candidatosDe(linea, lineaId, porTramo[i], ahora, cargo));
    }

    const combinaciones = combinar(reserva, candidatosPorCambio);
    if (combinaciones.length === 0) return [];

    const vence = new Date(ahora.getTime() + this.vigenciaMinutos * MINUTO);
    const ofertas: Array<OfertaCambioNueva & { opcion: OpcionCambio }> = combinaciones.map((c) => {
      const id = randomUUID();
      const diferencia = diferenciaDe(c);
      return {
        id,
        reservaId: reserva.id,
        cargo: diferencia.cargo,
        creada: ahora,
        vence,
        detalles: c.map((x) => ({
          lineaId: x.lineaId,
          itinerarioNuevoId: x.nuevo.id,
          diferenciaTarifa: x.tarifa,
          diferenciaImpuestos: x.impuestos,
        })),
        opcion: { id, vence, salidas: c.flatMap((x) => x.nuevo.segmentos), diferencia },
      };
    });

    // Un itinerario nuevo puede estar en varias ofertas: se guarda una vez
    const itinerarios = new Map(combinaciones.flat().map((x) => [x.nuevo.id, x.nuevo]));
    await this.prisma.transaccionAuditada(async (tx) => {
      await this.busqueda.guardarItinerarios(tx, [...itinerarios.values()], ahora);
      await this.repositorio.guardarOfertas(tx, ofertas);
    });
    try {
      await this.repositorio.purgarVencidas(ahora);
    } catch (error) {
      this.logger.warn(
        `No se pudieron purgar las ofertas de cambio vencidas: ${(error as Error).name}`,
      );
    }
    return ofertas.map((o) => o.opcion);
  }
}

/** Pasajeros de la reserva por tipo (solo los que hay), en el orden del contrato. */
function conteoDe(reserva: Reserva): ConteoPasajeros {
  return ORDEN_TIPOS.map((tipo) => ({
    tipo,
    cantidad: reserva.pasajeros.filter((p) => p.tipo === tipo).length,
  })).filter((c) => c.cantidad > 0);
}

/**
 * Los itinerarios nuevos posibles para un cambio: de la aerolínea de la reserva, con la misma
 * familia (código y cabina) vendible, que todavía no salen y que no son el mismo itinerario de
 * hoy. Los más baratos primero, a lo sumo `candidatosPorCambio`.
 */
function candidatosDe(
  linea: ItinerarioDeReserva,
  lineaId: bigint,
  itinerarios: ItinerarioArmado[],
  ahora: Date,
  cargo: Prisma.Decimal,
): Candidato[] {
  const aerolinea = linea.salidas[0].comercializa;
  const hoy = linea.salidas.map((s) => s.id).join(',');
  const candidatos: Candidato[] = [];
  for (const nuevo of itinerarios) {
    if (nuevo.segmentos[0].comercializa !== aerolinea) continue;
    if (nuevo.segmentos.map((s) => s.id).join(',') === hoy) continue;
    if (nuevo.segmentos[0].salida <= ahora) continue;
    const opcion = nuevo.opciones.find(
      (o) => o.codigo === linea.familia.codigo && o.cabina === linea.familia.cabina,
    );
    if (!opcion) continue;
    candidatos.push({
      linea,
      lineaId,
      nuevo,
      tarifa: opcion.totalPasajeros.base.minus(linea.base),
      impuestos: opcion.totalPasajeros.impuestos.minus(linea.impuestos),
      cargo,
    });
  }
  return candidatos
    .sort(
      (a, b) =>
        a.tarifa.plus(a.impuestos).comparedTo(b.tarifa.plus(b.impuestos)) ||
        a.nuevo.segmentos[0].salida.getTime() - b.nuevo.segmentos[0].salida.getTime(),
    )
    .slice(0, REGLAS_CAMBIO.candidatosPorCambio);
}

/**
 * Un candidato por cambio, en todas las combinaciones que quedan en orden con los itinerarios
 * que no cambian (cada uno sale al menos 45 minutos después de que llega el anterior). Las más
 * baratas primero, a lo sumo `maximoOfertas`.
 */
function combinar(reserva: Reserva, candidatosPorCambio: Candidato[][]): Candidato[][] {
  let parciales: Candidato[][] = [[]];
  for (const candidatos of candidatosPorCambio) {
    parciales = parciales.flatMap((p) => candidatos.map((c) => [...p, c]));
  }
  return parciales
    .filter((c) => c.length > 0 && enOrden(reserva, c))
    .sort(
      (a, b) =>
        diferenciaDe(a).aPagar.comparedTo(diferenciaDe(b).aPagar) ||
        a[0].nuevo.segmentos[0].salida.getTime() - b[0].nuevo.segmentos[0].salida.getTime(),
    )
    .slice(0, REGLAS_CAMBIO.maximoOfertas);
}

function enOrden(reserva: Reserva, combinacion: Candidato[]): boolean {
  const vuelos = (it: ItinerarioDeReserva): SalidaVendible[] =>
    combinacion.find((c) => c.linea.id === it.id)?.nuevo.segmentos ?? it.salidas;
  const secuencia = [...reserva.itinerarios].sort((a, b) => a.orden - b.orden).map(vuelos);
  return secuencia.every(
    (actual, i) =>
      i === 0 ||
      actual[0].salida.getTime() >=
        secuencia[i - 1][secuencia[i - 1].length - 1].llegada.getTime() +
          REGLAS_BUSQUEDA.separacionMinimaEntreTramosMinutos * MINUTO,
  );
}

/** Las diferencias de todos los cambios sumadas, y lo que se cobra. */
function diferenciaDe(combinacion: Candidato[]): DiferenciaPrecio {
  const tarifa = combinacion.reduce((s, c) => s.plus(c.tarifa), CERO);
  const impuestos = combinacion.reduce((s, c) => s.plus(c.impuestos), CERO);
  const cargo = combinacion.reduce((s, c) => s.plus(c.cargo), CERO);
  const diferencia = tarifa.plus(impuestos);
  return {
    tarifa,
    impuestos,
    cargo,
    aPagar: (diferencia.greaterThan(0) ? diferencia : CERO).plus(cargo),
  };
}
