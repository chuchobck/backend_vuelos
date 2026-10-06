import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { CodigoError, CODIGO_SIN_EQUIVALENTE } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { Reloj } from '../../../../common/reloj';
import { clase_cabina, Prisma, tipo_pasajero } from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';
import { cuerpoInvalido } from '../../compartido/errores';
import {
  ClaveGuardada,
  IdClave,
  IdempotenciaRepository,
} from '../../compartido/idempotencia.repository';
import { InventarioRepository, MovimientoDeCupo } from '../../compartido/inventario.repository';
import { Cobros } from '../../compartido/pagos/cobros';
import { PagosRepository } from '../../compartido/pagos/pagos.repository';
import { SERVICIO_PAGOS, ServicioPagos } from '../../compartido/pagos/servicio-pagos';
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
import { asignarAsientos, validarAsientosElegidos } from '../reserva/asientos-reserva';
import { PasajeroReservaDto } from '../reserva/dto/solicitud-reserva.dto';
import { ItinerarioDeReserva, Reserva } from '../reserva/reserva.modelo';
import { ReservaService } from '../reserva/reserva.service';
import { DiferenciaPrecio, OpcionCambio } from './cambio-fecha.modelo';
import {
  CambioFechaRepository,
  CambioPendiente,
  OfertaCambio,
  OfertaCambioNueva,
} from './cambio-fecha.repository';
import { SolicitudBusquedaCambioDto, SolicitudCambioDto } from './dto/cambio-fecha.dto';

/** Reglas del cambio de fecha. */
export const REGLAS_CAMBIO = {
  /** Vigencia de una oferta de cambio si CHANGE_OFFER_TTL_MINUTES no dice otra cosa. */
  vigenciaOfertaPorDefectoMinutos: 15,
  /** Itinerarios por cambio que entran a combinarse (los más baratos). */
  candidatosPorCambio: 10,
  /** Ofertas que devuelve una búsqueda de cambio, como máximo. */
  maximoOfertas: 10,
  /** Cuánto se recuerda una Idempotency-Key de POST .../date-change. */
  vigenciaClaveHoras: 24,
  /** Tope de la transacción que confirma (espera a otras reservas de las mismas cabinas). */
  transaccion: { maxWait: 5_000, timeout: 15_000 },
};

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const ESTADOS_VENDIBLES = ['PROGRAMADO', 'DEMORADO'];
/** Los procesos periódicos escriben sin usuario. */
const SISTEMA = { idUsuario: null, direccionIp: null };

export interface ResultadoCambio {
  reserva: Reserva;
  codigoHttp: 200 | 202;
  repetida: boolean;
}

/** La otra petición con la misma clave ganó: se repite su respuesta. */
class ClaveEnUso extends Error {}

const ofertaNoExiste = () =>
  new ErrorNegocio(422, CODIGO_SIN_EQUIVALENTE, 'changeOfferId: the change offer was not found', {
    invalidParams: [
      { name: 'changeOfferId', reason: 'the change offer was not found for this booking' },
    ],
  });
const ofertaUsada = (id: string) =>
  new ErrorNegocio(409, CODIGO_SIN_EQUIVALENTE, `Change offer ${id} was already used`);
const ofertaVencida = (id: string) =>
  new ErrorNegocio(410, CodigoError.CHANGE_OFFER_EXPIRED, `Change offer ${id} has expired`);
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
    private readonly inventario: InventarioRepository,
    private readonly claves: IdempotenciaRepository,
    private readonly cobros: Cobros,
    private readonly pagosRegistrados: PagosRepository,
    @Inject(SERVICIO_PAGOS) private readonly pagos: ServicioPagos,
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

  /**
   * POST .../date-change: confirma una oferta vigente de esta reserva. Antes de la transacción
   * se valida la oferta (422 si no es de la reserva, 409 si ya se usó, 410 si venció) y se cobra
   * lo que haya que pagar. Después, en UNA transacción auditada: reclama la clave, bloquea la
   * reserva, saca la oferta de OFERTADO (una sola confirmación gana), mueve el cupo en una
   * sentencia ordenada (toma el de los vuelos nuevos y, si el pago está aprobado, devuelve el
   * de los viejos; sin cupo, 409), asigna asientos (los pedidos o la regla de la reserva) y
   * agrega las líneas nuevas apagadas. Pago aprobado (o nada que pagar): enciende las líneas,
   * libera los asientos viejos, vuelve a emitir los boletos y responde 200. Pago pendiente: la
   * reserva queda CAMBIO_PENDIENTE con los vuelos nuevos tomados (202) y el proceso periódico
   * termina o deshace el cambio.
   */
  async confirmar(
    reservaId: string,
    solicitud: SolicitudCambioDto,
    idPropietario: string,
    clave: string,
  ): Promise<ResultadoCambio> {
    const ahora = this.reloj.ahora();
    const huella = huellaDe(reservaId, solicitud);
    const idClave: IdClave = { idPropietario, operacion: 'CONFIRMAR_CAMBIO_FECHA', clave };
    const previa = await this.claves.leer(idClave);
    if (previa && previa.vence > ahora)
      return this.repetir(previa, huella, reservaId, idPropietario);
    if (previa) await this.claves.borrarVencidas(ahora, idClave);

    try {
      return await this.confirmarNueva(reservaId, solicitud, idPropietario, idClave, huella, ahora);
    } catch (error) {
      if (error instanceof ClaveEnUso || (error instanceof ErrorNegocio && error.status === 409)) {
        const ganadora = await this.claves.leer(idClave);
        if (ganadora) return this.repetir(ganadora, huella, reservaId, idPropietario);
      }
      throw error;
    }
  }

  private async confirmarNueva(
    reservaId: string,
    solicitud: SolicitudCambioDto,
    idPropietario: string,
    idClave: IdClave,
    huella: string,
    ahora: Date,
  ): Promise<ResultadoCambio> {
    const reserva = await this.reservas.detalle(reservaId, idPropietario);
    const oferta = await this.repositorio.leer(solicitud.changeOfferId);
    if (!oferta || oferta.reservaId !== reserva.id) throw ofertaNoExiste();
    if (oferta.estado !== 'OFERTADO') throw ofertaUsada(oferta.id);
    if (oferta.vence <= ahora) throw ofertaVencida(oferta.id);
    exigirConfirmada(reserva, 'a date change');
    for (const d of oferta.detalles) {
      const vieja = reserva.itinerarios.find((it) => it.id === d.itinerarioViejoId);
      if (!vieja) {
        throw new ErrorNegocio(
          409,
          CODIGO_SIN_EQUIVALENTE,
          `The booking changed since change offer ${oferta.id}`,
        );
      }
      exigirSinDespegar([vieja], ahora);
      for (const salida of d.salidasNuevas) {
        if (salida.salida <= ahora || !ESTADOS_VENDIBLES.includes(salida.estado)) {
          throw new ErrorNegocio(
            409,
            CodigoError.OFFER_NO_LONGER_AVAILABLE,
            `Segment ${salida.id} of change offer ${oferta.id} is no longer sold`,
          );
        }
      }
    }

    const aPagar = totalAPagar(oferta);
    let pago: 'APROBADO' | 'PENDIENTE' = 'APROBADO';
    if (aPagar.greaterThan(0)) {
      if (!solicitud.payment) {
        throw new ErrorNegocio(
          422,
          CODIGO_SIN_EQUIVALENTE,
          `payment: is required, totalToPay is ${aPagar.toFixed(2)}`,
          {
            invalidParams: [
              { name: 'payment', reason: 'is required when totalToPay is greater than 0' },
            ],
          },
        );
      }
      pago = await this.cobros.autorizar({
        referencia: solicitud.payment.paymentReference,
        concepto: 'CAMBIO_FECHA',
        moneda: reserva.total.moneda,
        monto: aPagar,
      });
    }
    const salidasNuevas = salidasConCabina(oferta);
    const { pasajeros, pedidos } = asientosPedidos(reserva, solicitud, salidasNuevas);
    const conAsiento = reserva.pasajeros.filter((p) => p.tipo !== 'INFANTE').length;
    const codigoHttp = pago === 'APROBADO' ? 200 : 202;

    await this.prisma.transaccionAuditada(async (tx) => {
      const reclamada = await this.claves.reclamar(tx, {
        ...idClave,
        huella,
        codigoHttp,
        respuesta: { bookingId: reserva.id },
        creada: ahora,
        vence: new Date(ahora.getTime() + REGLAS_CAMBIO.vigenciaClaveHoras * HORA),
      });
      if (!reclamada) throw new ClaveEnUso();

      if ((await this.reservas.bloquear(tx, reserva.id)) !== 'CONFIRMADA') {
        throw new ErrorNegocio(
          409,
          CODIGO_SIN_EQUIVALENTE,
          `Booking ${reserva.id} is no longer CONFIRMED`,
        );
      }
      const pagoId = aPagar.greaterThan(0)
        ? await this.pagosRegistrados.registrar(tx, {
            reservaId: reserva.id,
            referencia: solicitud.payment!.paymentReference,
            concepto: 'CAMBIO_FECHA',
            estado: pago,
            fecha: ahora,
          })
        : undefined;
      const hacia = pago === 'APROBADO' ? 'CONFIRMADO' : 'PENDIENTE';
      if (
        !(await this.repositorio.cambiarEstado(tx, oferta.id, 'OFERTADO', hacia, ahora, pagoId))
      ) {
        throw ofertaUsada(oferta.id);
      }

      const movimientos: MovimientoDeCupo[] = salidasNuevas.map((s) => ({
        salidaId: s.id,
        cabina: s.cabina,
        delta: -conAsiento,
      }));
      if (pago === 'APROBADO') movimientos.push(...cupoViejo(oferta, conAsiento));
      if (!(await this.inventario.mover(tx, movimientos))) {
        throw new ErrorNegocio(
          409,
          CodigoError.OFFER_NO_LONGER_AVAILABLE,
          'There are not enough seats left on the new flights',
        );
      }
      const mapa = await this.reservas.asientosDeSalidas(
        tx,
        salidasNuevas.map((s) => s.id),
      );
      await this.reservas.asignarAsientos(
        tx,
        reserva.id,
        asignarAsientos(pasajeros, salidasNuevas, pedidos, mapa),
        ahora,
      );
      await this.repositorio.agregarLineas(tx, reserva.id, lineasNuevas(oferta));

      if (pago === 'APROBADO') {
        await this.aplicar(tx, reserva.id, oferta, ahora);
        await this.reservas.evento(
          tx,
          reserva.id,
          'booking.changed',
          descripcion(oferta, aPagar),
          ahora,
        );
      } else {
        await this.reservas.transicion(tx, reserva.id, 'CONFIRMADA', 'CAMBIO_PENDIENTE', ahora, {
          tipo: 'booking.change_pending',
          descripcion: `${descripcion(oferta, aPagar)}; payment pending`,
        });
      }
    }, REGLAS_CAMBIO.transaccion);

    return {
      reserva: await this.reservas.detalle(reserva.id, idPropietario),
      codigoHttp,
      repetida: false,
    };
  }

  /**
   * Un cambio con pago PENDIENTE (proceso periódico). Aprobado: devuelve el cupo y los asientos
   * viejos, enciende las líneas nuevas, vuelve a emitir los boletos y la reserva vuelve a
   * CONFIRMADA. Rechazado: devuelve el cupo y los asientos de los vuelos nuevos, el cambio queda
   * FALLIDO y la reserva sigue como estaba (CONFIRMADA). Pendiente: no la toca.
   */
  async procesarPendiente(pendiente: CambioPendiente): Promise<'APROBADO' | 'RECHAZADO' | null> {
    const pago = await this.pagos.consultar(pendiente.referencia);
    if (pago === 'PENDIENTE') return null;
    const ahora = this.reloj.ahora();
    const oferta = (await this.repositorio.leer(pendiente.cambioId))!;
    return this.prisma.transaccionAuditada(
      async (tx) => {
        if (!(await this.reservas.tomarSiSigue(tx, pendiente.reservaId, 'CAMBIO_PENDIENTE'))) {
          return null;
        }
        await this.pagosRegistrados.resolver(tx, pendiente.pagoId, pago);
        const conAsiento = await this.repositorio.pasajerosConAsiento(tx, pendiente.reservaId);
        if (pago === 'APROBADO') {
          await this.repositorio.cambiarEstado(tx, oferta.id, 'PENDIENTE', 'CONFIRMADO', ahora);
          await this.inventario.mover(tx, cupoViejo(oferta, conAsiento));
          await this.aplicar(tx, pendiente.reservaId, oferta, ahora);
          await this.reservas.transicion(
            tx,
            pendiente.reservaId,
            'CAMBIO_PENDIENTE',
            'CONFIRMADA',
            ahora,
            {
              tipo: 'booking.changed',
              descripcion: descripcion(oferta, totalAPagar(oferta)),
            },
          );
        } else {
          await this.repositorio.cambiarEstado(tx, oferta.id, 'PENDIENTE', 'FALLIDO', ahora);
          await this.inventario.mover(
            tx,
            salidasConCabina(oferta).map((s) => ({
              salidaId: s.id,
              cabina: s.cabina,
              delta: conAsiento,
            })),
          );
          await this.reservas.liberarAsientos(
            tx,
            pendiente.reservaId,
            salidasConCabina(oferta).map((s) => s.id),
            ahora,
          );
          await this.reservas.transicion(
            tx,
            pendiente.reservaId,
            'CAMBIO_PENDIENTE',
            'CONFIRMADA',
            ahora,
            {
              tipo: 'booking.change_failed',
              descripcion: 'Date change not applied: the payment was not authorized',
            },
          );
        }
        return pago;
      },
      { ...REGLAS_CAMBIO.transaccion, actor: SISTEMA },
    );
  }

  /** El cambio ya pagado: líneas nuevas vigentes, asientos viejos libres, boletos nuevos. */
  private async aplicar(
    tx: TransaccionVuelos,
    reservaId: string,
    oferta: OfertaCambio,
    ahora: Date,
  ): Promise<void> {
    await this.repositorio.activarLineas(
      tx,
      reservaId,
      oferta.detalles.map((d) => ({
        lineaViejaId: d.lineaId,
        itinerarioNuevoId: d.itinerarioNuevoId,
      })),
    );
    await this.reservas.liberarAsientos(
      tx,
      reservaId,
      oferta.detalles.flatMap((d) => d.salidasViejas),
      ahora,
    );
    await this.reservas.reemitirBoletos(tx, reservaId, ahora);
  }

  private async repetir(
    previa: ClaveGuardada,
    huella: string,
    reservaId: string,
    idPropietario: string,
  ): Promise<ResultadoCambio> {
    if (previa.huella !== huella) {
      throw new ErrorNegocio(
        422,
        CODIGO_SIN_EQUIVALENTE,
        'This Idempotency-Key was already used with a different request body',
        { invalidParams: [{ name: 'Idempotency-Key', reason: 'already used with another body' }] },
      );
    }
    return {
      reserva: await this.reservas.detalle(reservaId, idPropietario),
      codigoHttp: previa.codigoHttp === 202 ? 202 : 200,
      repetida: true,
    };
  }
}

/** max(0, Σ diferencias) + cargo, con lo guardado en la oferta. */
function totalAPagar(oferta: OfertaCambio): Prisma.Decimal {
  const diferencia = oferta.detalles.reduce(
    (s, d) => s.plus(d.diferenciaTarifa).plus(d.diferenciaImpuestos),
    CERO,
  );
  return (diferencia.greaterThan(0) ? diferencia : CERO).plus(oferta.cargo);
}

/**
 * Las líneas nuevas: el itinerario nuevo con la familia y el orden del viejo, y el precio
 * pagado más la diferencia cobrada. Si la diferencia total no se cobró (bajó), la línea queda
 * con lo pagado antes: lo que baja no se devuelve.
 */
function lineasNuevas(oferta: OfertaCambio) {
  const cobrada = oferta.detalles
    .reduce((s, d) => s.plus(d.diferenciaTarifa).plus(d.diferenciaImpuestos), CERO)
    .greaterThan(0);
  return oferta.detalles.map((d) => ({
    itinerarioId: d.itinerarioNuevoId,
    familiaId: d.familiaId,
    orden: d.orden,
    base: cobrada ? d.base.plus(d.diferenciaTarifa) : d.base,
    impuestos: cobrada ? d.impuestos.plus(d.diferenciaImpuestos) : d.impuestos,
  }));
}

/** Los vuelos nuevos con la cabina de la familia, en el orden de bloqueo. */
function salidasConCabina(oferta: OfertaCambio): Array<{ id: string; cabina: clase_cabina }> {
  return oferta.detalles
    .flatMap((d) => d.salidasNuevas.map((s) => ({ id: s.id, cabina: d.cabina })))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** El cupo de los vuelos viejos, que vuelve al inventario. */
function cupoViejo(oferta: OfertaCambio, conAsiento: number): MovimientoDeCupo[] {
  return oferta.detalles.flatMap((d) =>
    d.salidasViejas.map((id) => ({ salidaId: id, cabina: d.cabina, delta: conAsiento })),
  );
}

/**
 * Los asientos pedidos para los vuelos nuevos. DateChangeRequest.assignedSeats no nombra al
 * pasajero: en cada vuelo, el primer asiento pedido es del primer pasajero con asiento de la
 * reserva, el segundo del segundo, y así. Los demás se asignan con la regla de la reserva.
 */
function asientosPedidos(
  reserva: Reserva,
  solicitud: SolicitudCambioDto,
  salidas: Array<{ id: string; cabina: clase_cabina }>,
) {
  const conAsiento = reserva.pasajeros.filter((p) => p.tipo !== 'INFANTE');
  const porVuelo = new Map<string, string[]>();
  (solicitud.assignedSeats ?? []).forEach((a, j) => {
    const id = a.segmentId.toLowerCase();
    if (!salidas.some((s) => s.id === id)) {
      throw new ErrorNegocio(
        422,
        CODIGO_SIN_EQUIVALENTE,
        `assignedSeats[${j}].segmentId: is not a new segment of the change offer`,
        {
          invalidParams: [
            {
              name: `assignedSeats[${j}].segmentId`,
              reason: 'is not a new segment of the change offer',
            },
          ],
        },
      );
    }
    const lista = porVuelo.get(id) ?? [];
    lista.push(a.seatNumber);
    if (lista.length > conAsiento.length) {
      throw cuerpoInvalido(
        'assignedSeats',
        `more seats than passengers with a seat on segment ${id}`,
      );
    }
    porVuelo.set(id, lista);
  });
  const pasajeros = reserva.pasajeros.map((p) => {
    const i = conAsiento.indexOf(p);
    return {
      passengerId: p.codigo,
      passengerType: p.tipo === 'INFANTE' ? 'INFANT' : 'ADULT',
      assignedSeats:
        i < 0
          ? []
          : [...porVuelo]
              .filter(([, n]) => n[i] !== undefined)
              .map(([segmentId, n]) => ({ segmentId, seatNumber: n[i] })),
    } as unknown as PasajeroReservaDto;
  });
  return { pasajeros, pedidos: validarAsientosElegidos(pasajeros, salidas) };
}

function descripcion(oferta: OfertaCambio, aPagar: Prisma.Decimal): string {
  const n = oferta.detalles.length;
  return `Date changed for ${n} itinerary(ies); ${aPagar.toFixed(2)} charged`;
}

function huellaDe(reservaId: string, s: SolicitudCambioDto): string {
  const canonica = {
    bookingId: reservaId.toLowerCase(),
    changeOfferId: s.changeOfferId.toLowerCase(),
    payment: s.payment ? { paymentReference: s.payment.paymentReference } : null,
    assignedSeats: (s.assignedSeats ?? []).map((a) => ({
      segmentId: a.segmentId.toLowerCase(),
      seatNumber: a.seatNumber,
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonica)).digest('hex');
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
