import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { CodigoError, CODIGO_SIN_EQUIVALENTE } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { Reloj } from '../../../../common/reloj';
import { estado_reserva, estado_vuelo, Prisma } from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';
import { esUuid, fechaIsoAUtc } from '../../../../common/pipes/formatos';
import { cursorInvalido } from '../../catalogo/base/errores-catalogo';
import {
  codificarCursor,
  decodificarCursor,
  LIMITE_POR_DEFECTO,
} from '../../catalogo/base/paginacion';
import { ESTADO_RESERVA, ORDEN_CABINAS } from '../../compartido/enums';
import { cuerpoInvalido, noExiste } from '../../compartido/errores';
import { sumarDias } from '../../compartido/fechas';
import {
  ClaveGuardada,
  IdClave,
  IdempotenciaRepository,
} from '../../compartido/idempotencia.repository';
import { Cobros } from '../../compartido/pagos/cobros';
import { PagosRepository } from '../../compartido/pagos/pagos.repository';
import { EstadoPago, SERVICIO_PAGOS, ServicioPagos } from '../../compartido/pagos/servicio-pagos';
import { BoletoService } from '../boleto/boleto.service';
import { RetencionService } from '../retencion/retencion.service';
import { asignarAsientos, SalidaConCabina, validarAsientosElegidos } from './asientos-reserva';
import { ConsultaReservasDto } from './dto/consulta-reservas.dto';
import { SolicitudReservaDto } from './dto/solicitud-reserva.dto';
import { EventosReserva, TipoEventoReserva } from './eventos-reserva';
import { validarPasajeros } from './pasajeros-reserva';
import { Reserva, ResumenReserva } from './reserva.modelo';
import {
  AsientoDeSalida,
  FilaListado,
  FiltrosReservas,
  HoldParaReservar,
  PnrAgotado,
  ReservaRepository,
} from './reserva.repository';

/** Reglas de POST /bookings. */
export const REGLAS_RESERVA = {
  /** Cuánto se recuerda una Idempotency-Key de POST /bookings (como la del hold). */
  vigenciaClaveHoras: 24,
  /**
   * Tope de la transacción que crea la reserva. Espera, como mucho, a otras reservas de la
   * misma cabina (que bloquean el inventario mientras eligen asiento) y a un hold que compite.
   */
  transaccion: { maxWait: 5_000, timeout: 15_000 },
};

/** Estados en los que un vuelo se sigue vendiendo (los de la búsqueda y del hold). */
const ESTADOS_VENDIBLES: estado_vuelo[] = ['PROGRAMADO', 'DEMORADO'];
const HORA = 60 * 60_000;

/** Lo que responde POST /bookings: 201 si los boletos salieron, 202 si el pago sigue pendiente. */
export interface ResultadoReserva {
  reserva: Reserva;
  codigoHttp: 201 | 202;
  repetida: boolean;
}

/** La otra petición con la misma clave ganó: se repite su respuesta. */
class ClaveEnUso extends Error {}

/**
 * 422 para un hold que no existe y también para el de otro usuario (no se revela que existe).
 * POST /bookings no declara 404 en el contrato: es un dato del cuerpo que no se puede procesar.
 */
const holdNoExiste = () =>
  new ErrorNegocio(422, CODIGO_SIN_EQUIVALENTE, 'holdId: the hold was not found', {
    invalidParams: [{ name: 'holdId', reason: 'the hold was not found' }],
  });
const holdVencido = (id: string) =>
  new ErrorNegocio(
    410,
    CodigoError.OFFER_NO_LONGER_AVAILABLE,
    `Hold ${id} has expired or was released`,
  );
const holdConsumido = (id: string) =>
  new ErrorNegocio(
    409,
    CodigoError.OFFER_NO_LONGER_AVAILABLE,
    `Hold ${id} was already used for a booking`,
  );
const reservaNoExiste = (id: string) => noExiste(`Booking ${id} was not found`);

/**
 * Reservas: POST /bookings convierte un hold vigente en una reserva con sus pasajeros, sus
 * asientos y sus boletos, y GET /bookings y GET /bookings/{bookingId} las consultan. El dueño es
 * siempre el `sub` del token (el mismo del hold); una reserva ajena no existe para nadie más.
 *
 * Todo lo que crea la reserva va en UNA transacción auditada: la clave de idempotencia, el
 * consumo del hold, los asientos, la reserva y sus detalles, los boletos y su historial. Si
 * algo falla, no queda nada y el hold sigue RETENIDA.
 */
@Injectable()
export class ReservaService {
  constructor(
    private readonly repositorio: ReservaRepository,
    private readonly prisma: PrismaService,
    private readonly claves: IdempotenciaRepository,
    private readonly retenciones: RetencionService,
    private readonly boletos: BoletoService,
    private readonly eventos: EventosReserva,
    @Inject(SERVICIO_PAGOS) private readonly pagos: ServicioPagos,
    private readonly pagosRegistrados: PagosRepository,
    private readonly cobros: Cobros,
    private readonly reloj: Reloj,
  ) {}

  async crear(
    solicitud: SolicitudReservaDto,
    idPropietario: string,
    clave: string,
  ): Promise<ResultadoReserva> {
    const ahora = this.reloj.ahora();
    const huella = huellaDe(solicitud);
    const idClave = { idPropietario, operacion: 'CREAR_RESERVA' as const, clave };

    const previa = await this.claves.leer(idClave);
    if (previa && previa.vence > ahora) return this.repetir(previa, huella, idPropietario);
    if (previa) await this.claves.borrarVencidas(ahora, idClave);

    try {
      return await this.crearNueva(solicitud, idPropietario, idClave, huella, ahora);
    } catch (error) {
      // Otra petición con la misma clave pudo terminar entre la lectura de arriba y la
      // comprobación que falló (el hold ya consumido, la referencia ya usada): se repite su
      // respuesta en vez de responder un 409 que el cliente no provocó.
      if (error instanceof ErrorNegocio && error.status === 409) {
        const ganadora = await this.claves.leer(idClave);
        if (ganadora) return this.repetir(ganadora, huella, idPropietario);
      }
      throw error;
    }
  }

  private async crearNueva(
    solicitud: SolicitudReservaDto,
    idPropietario: string,
    idClave: IdClave,
    huella: string,
    ahora: Date,
  ): Promise<ResultadoReserva> {
    const hold = await this.repositorio.holdParaReservar(solicitud.holdId);
    if (!hold || hold.idPropietario !== idPropietario) throw holdNoExiste();
    if (hold.estado === 'CONSUMIDA') throw holdConsumido(hold.id);
    if (hold.estado !== 'RETENIDA' || hold.vence <= ahora) throw holdVencido(hold.id);
    validarSalidas(hold, ahora);

    const salidas = salidasConCabina(hold);
    const fechas = hold.itinerarios.flatMap((it) => it.salidas.map((s) => s.fechaSalida));
    const pasajeros = validarPasajeros(solicitud.passengers, {
      conteo: {
        ADULTO: hold.adultos,
        JOVEN: hold.jovenes,
        NINO: hold.ninos,
        INFANTE: hold.infantes,
      },
      primeraSalida: new Date(Math.min(...fechas.map((f) => f.getTime()))),
      ultimaSalida: new Date(Math.max(...fechas.map((f) => f.getTime()))),
      paises: await this.repositorio.paises([
        ...new Set(solicitud.passengers.map((p) => p.nationality)),
      ]),
    });
    const elegidos = validarAsientosElegidos(solicitud.passengers, salidas);

    const prefijo = hold.aerolinea.prefijoBoleto;
    if (prefijo === null) {
      throw new ErrorNegocio(
        422,
        CodigoError.TICKET_ISSUANCE_FAILED,
        `Airline ${hold.aerolinea.codigo} cannot issue tickets yet (it has no ticket prefix)`,
      );
    }
    const referencia = solicitud.payment.paymentReference;
    const pago = await this.autorizarPago(referencia, hold);
    const codigoHttp = pago === 'APROBADO' ? 201 : 202;

    const id = randomUUID();
    try {
      await this.prisma.transaccionAuditada(async (tx) => {
        const reclamada = await this.claves.reclamar(tx, {
          ...idClave,
          huella,
          codigoHttp,
          respuesta: { bookingId: id },
          creada: ahora,
          vence: new Date(ahora.getTime() + REGLAS_RESERVA.vigenciaClaveHoras * HORA),
        });
        if (!reclamada) throw new ClaveEnUso();

        const consumo = await this.retenciones.consumir(hold.id, idPropietario, tx);
        if (consumo === 'ya-consumida') throw holdConsumido(hold.id);
        if (consumo === 'no-existe') throw holdNoExiste();
        if (consumo !== 'consumida') throw holdVencido(hold.id);

        await this.repositorio.bloquearCabinas(
          tx,
          salidas.map((s) => ({ salidaId: s.id, cabina: s.cabina })),
        );
        const mapa = await this.repositorio.asientosDeSalidas(
          tx,
          salidas.map((s) => s.id),
        );
        const asientos = asignarAsientos(solicitud.passengers, salidas, elegidos, mapa);

        await this.repositorio.crear(tx, {
          id,
          retencionId: hold.id,
          ahora,
          itinerarios: hold.itinerarios.map((it) => ({
            itinerarioId: it.id,
            familiaId: it.familiaId,
            orden: it.orden,
            base: it.base,
            impuestos: it.impuestos,
          })),
          pasajeros,
          asientos,
        });
        await this.pagosRegistrados.registrar(tx, {
          reservaId: id,
          referencia,
          concepto: 'EMISION',
          estado: pago === 'APROBADO' ? 'APROBADO' : 'PENDIENTE',
          fecha: ahora,
        });
        await this.evento(tx, id, 'booking.created', 'Booking created from hold', ahora, [
          null,
          'PENDIENTE',
        ]);
        await this.boletos.crearPendientes(tx, id, ahora);

        if (pago === 'APROBADO') {
          await this.emitirBoletos(tx, id, 'PENDIENTE', prefijo, ahora);
        } else {
          await this.transicion(tx, id, 'PENDIENTE', 'PENDIENTE_PAGO', ahora, {
            tipo: 'booking.payment_pending',
            descripcion: 'Payment pending confirmation; tickets will be issued once it is approved',
          });
        }
      }, REGLAS_RESERVA.transaccion);
    } catch (error) {
      if (error instanceof ClaveEnUso) {
        const ganadora = await this.claves.leer(idClave);
        if (!ganadora) throw claveEnCurso();
        return this.repetir(ganadora, huella, idPropietario);
      }
      if (error instanceof PnrAgotado) {
        throw new ErrorNegocio(
          409,
          CodigoError.PNR_CREATION_FAILED,
          'A PNR could not be generated; retry',
          {
            cabeceras: { 'Retry-After': '1' },
          },
        );
      }
      throw error;
    }

    return { reserva: await this.leer(id), codigoHttp, repetida: false };
  }

  /** GET /bookings/{bookingId}: solo su dueño; para cualquier otro, 404. */
  async detalle(reservaId: string, idPropietario: string): Promise<Reserva> {
    const encontrada = await this.repositorio.detalle(reservaId);
    if (!encontrada || encontrada.idPropietario !== idPropietario) {
      throw reservaNoExiste(reservaId);
    }
    return { ...encontrada.reserva, boletos: await this.boletos.deReserva(reservaId) };
  }

  /**
   * GET /bookings: las reservas del usuario, de la más reciente a la más vieja. El cursor es
   * la creación y el id de la última fila de la página (opaco, en base64url). createdFrom y
   * createdTo son días UTC completos, los dos incluidos.
   */
  async listar(
    consulta: ConsultaReservasDto,
    idPropietario: string,
  ): Promise<{ filas: ResumenReserva[]; nextCursor?: string }> {
    return this.pagina(consulta, { idPropietario });
  }

  /**
   * GET /admin/bookings: lo mismo que `listar` pero de todos los clientes, y con el dueño de
   * cada fila. `correoPropietario` y `numeroVuelo` son filtros de la administración.
   */
  async listarTodas(
    consulta: ConsultaReservasDto,
    filtros: { correoPropietario?: string; numeroVuelo?: string } = {},
  ): Promise<{ filas: FilaListado[]; nextCursor?: string }> {
    return this.pagina(consulta, { idPropietario: null, ...filtros });
  }

  private async pagina(
    consulta: ConsultaReservasDto,
    alcance: Pick<FiltrosReservas, 'idPropietario' | 'correoPropietario' | 'numeroVuelo'>,
  ): Promise<{ filas: FilaListado[]; nextCursor?: string }> {
    const limite = consulta.limit ?? LIMITE_POR_DEFECTO;
    const desde = consulta.createdFrom ? fechaIsoAUtc(consulta.createdFrom) : undefined;
    const hasta = consulta.createdTo ? sumarDias(fechaIsoAUtc(consulta.createdTo)!, 1) : undefined;
    if (desde && hasta && desde >= hasta) {
      throw cuerpoInvalido('createdTo', 'must not be before createdFrom');
    }
    const filas = await this.repositorio.listar({
      ...alcance,
      pnr: consulta.pnr,
      estado: consulta.status ? ESTADO_RESERVA.aBase(consulta.status) : undefined,
      desde,
      hasta,
      despuesDe: consulta.cursor ? leerCursor(consulta.cursor) : undefined,
      limite,
    });
    if (filas.length <= limite) return { filas };
    const ultima = filas[limite - 1];
    return {
      filas: filas.slice(0, limite),
      nextCursor: codificarCursor(`${ultima.creada.toISOString()}|${ultima.id}`),
    };
  }

  /** GET /admin/bookings/{bookingId}: la reserva de cualquier cliente y su dueño. */
  async detalleAdministracion(
    reservaId: string,
  ): Promise<{ reserva: Reserva; idPropietario: string }> {
    const encontrada = await this.repositorio.detalle(reservaId);
    if (!encontrada) throw reservaNoExiste(reservaId);
    return {
      idPropietario: encontrada.idPropietario,
      reserva: { ...encontrada.reserva, boletos: await this.boletos.deReserva(reservaId) },
    };
  }

  /**
   * Una reserva que esperaba su pago (PENDIENTE_PAGO): se consulta a la Payment API y, si se
   * aprobó, se emiten los boletos; si se rechazó, la reserva FALLA y devuelve asientos y cupo.
   * Si sigue pendiente, no cambia nada. La toma con SKIP LOCKED: si otra instancia la está
   * procesando, la deja. Devuelve el estado en que quedó (o null si no la tocó).
   */
  async procesarPendiente(reservaId: string, referencia: string): Promise<estado_reserva | null> {
    const pago = await this.pagos.consultar(referencia);
    if (pago === 'PENDIENTE') return null;
    const ahora = this.reloj.ahora();
    return this.prisma.transaccionAuditada(
      async (tx) => {
        if (!(await this.repositorio.tomarSiSigue(tx, reservaId, 'PENDIENTE_PAGO'))) return null;
        await this.pagosRegistrados.resolver(
          tx,
          await this.pagosRegistrados.deEmision(tx, reservaId),
          pago,
        );
        if (pago === 'RECHAZADO') {
          await this.fallar(
            tx,
            reservaId,
            'PENDIENTE_PAGO',
            'The payment was not authorized',
            ahora,
          );
          return 'FALLIDA';
        }
        const prefijo = await this.repositorio.prefijoBoleto(tx, reservaId);
        return this.emitirBoletos(tx, reservaId, 'PENDIENTE_PAGO', prefijo, ahora);
      },
      { ...REGLAS_RESERVA.transaccion, actor: { idUsuario: null, direccionIp: null } },
    );
  }

  /**
   * Pago aprobado: EMITIENDO_BOLETOS, se emiten los boletos y CONFIRMADA. Sin prefijo de boleto
   * (la aerolínea lo perdió entre la reserva y la emisión), la emisión falla y la reserva también.
   */
  private async emitirBoletos(
    tx: TransaccionVuelos,
    reservaId: string,
    desde: estado_reserva,
    prefijo: string | null,
    ahora: Date,
  ): Promise<estado_reserva> {
    await this.transicion(tx, reservaId, desde, 'EMITIENDO_BOLETOS', ahora, {
      tipo: 'booking.ticket_issuing',
      descripcion: 'Payment approved; issuing tickets',
    });
    if (prefijo === null) {
      await this.fallar(
        tx,
        reservaId,
        'EMITIENDO_BOLETOS',
        'The airline cannot issue tickets (it has no ticket prefix)',
        ahora,
      );
      return 'FALLIDA';
    }
    const emitidos = await this.boletos.emitir(tx, reservaId, prefijo, ahora);
    await this.evento(
      tx,
      reservaId,
      'booking.ticket_issued',
      `${emitidos} ticket(s) issued`,
      ahora,
    );
    await this.transicion(tx, reservaId, 'EMITIENDO_BOLETOS', 'CONFIRMADA', ahora, {
      tipo: 'booking.confirmed',
      descripcion: 'Booking confirmed',
    });
    return 'CONFIRMADA';
  }

  /**
   * La reserva no sigue: sus boletos pendientes quedan FALLIDO con el motivo, los asientos se
   * liberan y el cupo vuelve al inventario. El hold ya está CONSUMIDA y no se reusa.
   */
  private async fallar(
    tx: TransaccionVuelos,
    reservaId: string,
    desde: estado_reserva,
    motivo: string,
    ahora: Date,
  ): Promise<void> {
    await this.boletos.fallar(tx, reservaId, motivo);
    await this.liberarAsientosYCupo(tx, reservaId, ahora);
    await this.evento(
      tx,
      reservaId,
      'booking.ticket_failed',
      `Tickets not issued: ${motivo}`,
      ahora,
    );
    await this.transicion(tx, reservaId, desde, 'FALLIDA', ahora, {
      tipo: 'booking.failed',
      descripcion: `Booking failed: ${motivo}`,
    });
  }

  /**
   * Bloquea la reserva hasta el fin de la transacción y devuelve su estado. Las operaciones de
   * postventa (cancelación, cambio de fecha) la bloquean primero: dos sobre la misma reserva se
   * esperan, y la segunda ve el estado que dejó la primera.
   */
  bloquear(tx: TransaccionVuelos, reservaId: string): Promise<estado_reserva> {
    return this.repositorio.bloquear(tx, reservaId);
  }

  /** La bloquea si sigue en ese estado; SKIP LOCKED si otro proceso la tiene (procesos periódicos). */
  tomarSiSigue(tx: TransaccionVuelos, reservaId: string, estado: estado_reserva): Promise<boolean> {
    return this.repositorio.tomarSiSigue(tx, reservaId, estado);
  }

  /** Libera los asientos asignados y devuelve al inventario el cupo de sus itinerarios vigentes. */
  async liberarAsientosYCupo(tx: TransaccionVuelos, reservaId: string, ahora: Date): Promise<void> {
    await this.repositorio.liberarAsientos(tx, reservaId, ahora);
    await this.repositorio.devolverCupo(tx, reservaId);
  }

  /** Los asientos físicos de esas salidas y si están ocupados (con el inventario ya bloqueado). */
  asientosDeSalidas(tx: TransaccionVuelos, salidas: readonly string[]): Promise<AsientoDeSalida[]> {
    return this.repositorio.asientosDeSalidas(tx, salidas);
  }

  asignarAsientos(
    tx: TransaccionVuelos,
    reservaId: string,
    asientos: ReadonlyArray<{ codigoPasajero: string; salidaId: string; asientoId: bigint }>,
    ahora: Date,
  ): Promise<void> {
    return this.repositorio.asignarAsientos(tx, reservaId, asientos, ahora);
  }

  /** Libera los asientos de la reserva en esos vuelos (fecha_liberacion; nada se borra). */
  liberarAsientos(
    tx: TransaccionVuelos,
    reservaId: string,
    salidas: readonly string[],
    ahora: Date,
  ): Promise<void> {
    return this.repositorio.liberarAsientos(tx, reservaId, ahora, salidas);
  }

  /**
   * Vuelve a emitir los boletos (cambio de fecha): los EMITIDO pasan a ANULADO y cada pasajero
   * recibe uno nuevo, con un cupón por cada vuelo de los itinerarios vigentes. Sin prefijo de
   * boleto, 409 TICKET_ISSUANCE_FAILED (y la transacción se deshace).
   */
  async reemitirBoletos(tx: TransaccionVuelos, reservaId: string, ahora: Date): Promise<number> {
    const prefijo = await this.repositorio.prefijoBoleto(tx, reservaId);
    if (prefijo === null) {
      throw new ErrorNegocio(
        409,
        CodigoError.TICKET_ISSUANCE_FAILED,
        'The airline cannot issue tickets (it has no ticket prefix)',
      );
    }
    await this.boletos.anular(tx, reservaId);
    await this.boletos.crearPendientes(tx, reservaId, ahora);
    return this.boletos.emitir(tx, reservaId, prefijo, ahora);
  }

  /** Cambia el estado (UPDATE condicionado) y lo deja en el historial con su evento. */
  async transicion(
    tx: TransaccionVuelos,
    reservaId: string,
    desde: estado_reserva,
    hacia: estado_reserva,
    ahora: Date,
    evento: { tipo: TipoEventoReserva; descripcion: string },
  ): Promise<void> {
    if (!(await this.repositorio.cambiarEstado(tx, reservaId, desde, hacia))) {
      // No debería pasar: la reserva está bloqueada por esta transacción
      throw new Error(`La reserva no estaba en ${desde}`);
    }
    await this.evento(tx, reservaId, evento.tipo, evento.descripcion, ahora, [desde, hacia]);
  }

  /** Un evento sin cambio de estado (o con él), en el historial de la reserva. */
  evento(
    tx: TransaccionVuelos,
    reservaId: string,
    tipo: TipoEventoReserva,
    descripcion: string,
    fecha: Date,
    estados?: [estado_reserva | null, estado_reserva],
  ): Promise<void> {
    return this.eventos.registrar(tx, reservaId, {
      tipo,
      descripcion,
      fecha,
      ...(estados ? { transicion: { anterior: estados[0], nuevo: estados[1] } } : {}),
    });
  }

  /** El cobro del total congelado del hold (ver Cobros: 409 o 422 si no sigue). */
  private autorizarPago(referencia: string, hold: HoldParaReservar): Promise<EstadoPago> {
    const total = hold.itinerarios.reduce(
      (suma, it) => suma.plus(it.base).plus(it.impuestos),
      new Prisma.Decimal(0),
    );
    return this.cobros.autorizar({
      referencia,
      concepto: 'EMISION',
      moneda: hold.moneda,
      monto: total,
    });
  }

  /** La respuesta de una clave ya usada: la misma reserva, como está hoy, con el status original. */
  private async repetir(
    previa: ClaveGuardada,
    huella: string,
    idPropietario: string,
  ): Promise<ResultadoReserva> {
    if (previa.huella !== huella) {
      throw new ErrorNegocio(
        422,
        CODIGO_SIN_EQUIVALENTE,
        'This Idempotency-Key was already used with a different request body',
        { invalidParams: [{ name: 'Idempotency-Key', reason: 'already used with another body' }] },
      );
    }
    const guardada = previa.respuesta as { bookingId?: string } | null;
    if ((previa.codigoHttp !== 201 && previa.codigoHttp !== 202) || !guardada?.bookingId) {
      throw claveEnCurso();
    }
    return {
      reserva: await this.detalle(guardada.bookingId, idPropietario),
      codigoHttp: previa.codigoHttp,
      repetida: true,
    };
  }

  private async leer(reservaId: string): Promise<Reserva> {
    const encontrada = await this.repositorio.detalle(reservaId);
    return { ...encontrada!.reserva, boletos: await this.boletos.deReserva(reservaId) };
  }
}

/** El cursor de GET /bookings: `creación|id` en base64url. Otro texto es 400. */
function leerCursor(cursor: string): { creada: Date; id: string } {
  const [creada, id, ...resto] = (decodificarCursor(cursor) ?? '').split('|');
  const fecha = new Date(creada);
  if (resto.length > 0 || Number.isNaN(fecha.getTime()) || !esUuid(id)) throw cursorInvalido();
  return { creada: fecha, id };
}

/** No debería pasar: la clave se guarda con su respuesta en la misma transacción. */
const claveEnCurso = () =>
  new ErrorNegocio(
    409,
    CODIGO_SIN_EQUIVALENTE,
    'A request with this Idempotency-Key is in progress',
    {
      cabeceras: { 'Retry-After': '1' },
    },
  );

/**
 * Todos los vuelos del hold se siguen vendiendo: PROGRAMADO o DEMORADO y todavía en el futuro.
 * Uno que ya salió es 409 FLIGHT_ALREADY_DEPARTED; uno cancelado o cerrado, 409
 * OFFER_NO_LONGER_AVAILABLE.
 */
function validarSalidas(hold: HoldParaReservar, ahora: Date): void {
  for (const salida of hold.itinerarios.flatMap((it) => it.salidas)) {
    if (salida.salida <= ahora) {
      throw new ErrorNegocio(
        409,
        CodigoError.FLIGHT_ALREADY_DEPARTED,
        `Segment ${salida.id} has already departed`,
      );
    }
    if (!ESTADOS_VENDIBLES.includes(salida.estado)) {
      throw new ErrorNegocio(
        409,
        CodigoError.OFFER_NO_LONGER_AVAILABLE,
        `Segment ${salida.id} is no longer sold`,
      );
    }
  }
}

/** Las salidas del hold con su cabina, en el orden de bloqueo (salida, cabina). */
function salidasConCabina(hold: HoldParaReservar): SalidaConCabina[] {
  return hold.itinerarios
    .flatMap((it) => it.salidas.map((s) => ({ id: s.id, cabina: it.cabina })))
    .sort(
      (a, b) =>
        a.id.localeCompare(b.id) ||
        ORDEN_CABINAS.indexOf(a.cabina) - ORDEN_CABINAS.indexOf(b.cabina),
    );
}

/**
 * SHA-256 (hexadecimal) del cuerpo ya validado y normalizado, con las claves en un orden fijo.
 * El orden de los pasajeros cuenta (decide la asignación de asientos). Solo se guarda el hash:
 * los datos personales no van a clave_idempotencia.
 */
function huellaDe(solicitud: SolicitudReservaDto): string {
  const canonica = {
    holdId: solicitud.holdId.toLowerCase(),
    passengers: solicitud.passengers.map((p) => ({
      passengerId: p.passengerId,
      passengerType: p.passengerType,
      associatedAdultId: p.associatedAdultId ?? null,
      firstName: p.firstName,
      lastName: p.lastName,
      documentType: p.documentType,
      documentNumber: p.documentNumber,
      nationality: p.nationality,
      documentExpiryDate: p.documentExpiryDate ?? null,
      birthDate: p.birthDate,
      gender: p.gender,
      contact: { email: p.contact.email, phone: p.contact.phone },
      assignedSeats: (p.assignedSeats ?? []).map((a) => ({
        segmentId: a.segmentId.toLowerCase(),
        seatNumber: a.seatNumber,
      })),
      extraBaggage: (p.extraBaggage ?? []).map((e) => ({
        itineraryId: e.itineraryId,
        quantity: e.quantity,
      })),
    })),
    payment: { paymentReference: solicitud.payment.paymentReference },
  };
  return createHash('sha256').update(JSON.stringify(canonica)).digest('hex');
}
