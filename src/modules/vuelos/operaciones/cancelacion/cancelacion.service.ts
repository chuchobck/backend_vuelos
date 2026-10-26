import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { correlacionActual } from '../../../../common/contexto/correlation-id';
import { CodigoError, CODIGO_SIN_EQUIVALENTE } from '../../../../common/errores/codigo-error';
import { CodigoErrorV2 } from '../../../../common/errores/codigo-error-v2';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { Reloj } from '../../../../common/reloj';
import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';
import {
  ClaveGuardada,
  IdClave,
  IdempotenciaRepository,
} from '../../compartido/idempotencia.repository';
import {
  EstadoReembolso,
  ReembolsoPedido,
  SERVICIO_PAGOS,
  ServicioPagos,
} from '../../compartido/pagos/servicio-pagos';
import { BoletoService } from '../boleto/boleto.service';
import { exigirConfirmada, exigirSinDespegar } from '../reserva/reglas-postventa';
import { Reserva } from '../reserva/reserva.modelo';
import { ReservaService } from '../reserva/reserva.service';
import { Cotizacion } from './cancelacion.modelo';
import {
  CancelacionPendiente,
  CancelacionRepository,
  CodigoMotivo,
  CotizacionGuardada,
  LineaReembolsable,
} from './cancelacion.repository';
import { SolicitudCancelacionDto } from './dto/cancelacion.dto';
import { claveConOtroCuerpo, cuerpoInvalido } from '../../compartido/errores';

/** Reglas de la cancelación. */
export const REGLAS_CANCELACION = {
  /** Vigencia de una cotización si CANCELLATION_QUOTE_TTL_MINUTES no dice otra cosa. */
  vigenciaCotizacionPorDefectoMinutos: 15,
  /** Cuánto se recuerda una Idempotency-Key de POST .../cancel. */
  vigenciaClaveHoras: 24,
};

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
/** Los procesos periódicos escriben sin usuario. */
const SISTEMA = { idUsuario: null, direccionIp: null };

/** reasonCode del contrato v2 (CancelBookingRequest). */
export type MotivoCancelacionV2 =
  'CUSTOMER_REQUEST' | 'SAGA_COMPENSATION' | 'FLIGHT_CANCELLED' | 'OTHER';

/** reasonCode → cotizacion_cancelacion.codigo_motivo. */
export const CODIGO_MOTIVO: Readonly<Record<MotivoCancelacionV2, CodigoMotivo>> = {
  CUSTOMER_REQUEST: 'SOLICITUD_CLIENTE',
  SAGA_COMPENSATION: 'COMPENSACION_SAGA',
  FLIGHT_CANCELLED: 'VUELO_CANCELADO',
  OTHER: 'OTRO',
};

/** POST .../cancel de la fachada v2: quoteId opcional en una compensación o un vuelo cancelado. */
export interface SolicitudCancelacionV2 {
  quoteId?: string;
  reasonCode: MotivoCancelacionV2;
  reason?: string;
}

/** Los reasonCode que no piden quoteId: el servidor cotiza sin penalidad. */
const SIN_COTIZACION: readonly MotivoCancelacionV2[] = ['SAGA_COMPENSATION', 'FLIGHT_CANCELLED'];

export interface ResultadoCancelacion {
  reserva: Reserva;
  codigoHttp: 200 | 202;
  repetida: boolean;
}

/** La otra petición con la misma clave ganó: se repite su respuesta. */
class ClaveEnUso extends Error {}

const yaCancelada = (id: string) =>
  new ErrorNegocio(409, CodigoError.ALREADY_CANCELLED, `Booking ${id} is already cancelled`);
const CIEN = new Prisma.Decimal(100);
/** El code v2 de una reserva que no está CONFIRMADA al cotizar o cancelar. */
const NO_CANCELABLE = CodigoErrorV2.BOOKING_NOT_CANCELLABLE;

/**
 * Cotización y cancelación de una reserva (GET .../cancellation-quote y POST .../cancel).
 *
 * Política de reembolso, con datos del catálogo (`porcentaje_penalidad_cancelacion` de la
 * familia vendida en cada itinerario): de lo pagado por el itinerario (tarifa, impuestos y
 * maletas adicionales aprobadas) se devuelve (100 − porcentaje) % y se retiene el resto. Los
 * cargos por cambio de fecha no se devuelven. Una familia con 100 % (BASIC) no devuelve nada:
 * isRefundable es refundAmount > 0. Sin cercanía a la salida: el catálogo no tiene un dato para
 * eso, y un vuelo que ya salió no se cancela (409).
 */
@Injectable()
export class CancelacionService {
  private readonly logger = new Logger(CancelacionService.name);
  private readonly vigenciaMinutos: number;

  constructor(
    private readonly repositorio: CancelacionRepository,
    private readonly reservas: ReservaService,
    private readonly boletos: BoletoService,
    private readonly claves: IdempotenciaRepository,
    @Inject(SERVICIO_PAGOS) private readonly pagos: ServicioPagos,
    private readonly prisma: PrismaService,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.vigenciaMinutos =
      config.get<number>('CANCELLATION_QUOTE_TTL_MINUTES') ??
      REGLAS_CANCELACION.vigenciaCotizacionPorDefectoMinutos;
  }

  /**
   * Una cotización nueva en cada llamada, vigente CANCELLATION_QUOTE_TTL_MINUTES. Aprovecha la
   * escritura para purgar las vencidas que nadie aceptó (sin fallar la cotización).
   *
   * `sinPenalidad` (la cancelación v2 de una compensación o de un vuelo cancelado): se devuelve
   * todo lo pagado, sin retener nada.
   */
  async cotizar(
    reservaId: string,
    idPropietario: string,
    sinPenalidad = false,
  ): Promise<Cotizacion> {
    const ahora = this.reloj.ahora();
    const reserva = await this.reservas.detalle(reservaId, idPropietario);
    exigirConfirmada(reserva, 'a cancellation', NO_CANCELABLE);
    exigirSinDespegar(reserva.itinerarios, ahora);
    if ((await this.repositorio.pagosPendientes(reserva.id)) > 0) {
      throw new ErrorNegocio(
        409,
        CODIGO_SIN_EQUIVALENTE,
        `Booking ${reserva.id} has a payment pending in the Payment API; cancel when it is resolved`,
      );
    }

    const { reembolso, penalidad } = sinPenalidad
      ? { reembolso: reserva.total.total, penalidad: new Prisma.Decimal(0) }
      : calcularReembolso(await this.repositorio.lineas(reserva.id), reserva.total.total);
    const vence = new Date(ahora.getTime() + this.vigenciaMinutos * MINUTO);
    const id = await this.prisma.transaccionAuditada((tx) =>
      this.repositorio.crear(tx, {
        reservaId: reserva.id,
        reembolso,
        penalidad,
        creada: ahora,
        vence,
      }),
    );
    try {
      await this.repositorio.purgarVencidas(ahora);
    } catch (error) {
      this.logger.warn(`No se pudieron purgar las cotizaciones vencidas: ${(error as Error).name}`);
    }
    return { id, moneda: reserva.total.moneda, reembolso, penalidad, vence };
  }

  /**
   * POST .../cancel con una cotización vigente de esta reserva:
   *
   * 1. Una transacción auditada reclama la clave, bloquea la reserva, acepta la cotización,
   *    libera asientos y cupo, anula los boletos y deja la reserva CANCELACION_PENDIENTE.
   * 2. Ya confirmada la cancelación, se pide el reembolso (si hay algo que devolver).
   * 3. Aprobado (o sin nada que devolver): otra transacción la deja CANCELADA, completa la
   *    cotización y marca los boletos REEMBOLSADO; responde 200. Pendiente: 202 y el proceso
   *    periódico la completa.
   *
   * El reembolso se pide después de confirmar la cancelación para no devolver dinero de una
   * cancelación que no ocurrió (dos cancelaciones a la vez: una sola acepta la cotización).
   */
  async cancelar(
    reservaId: string,
    solicitud: SolicitudCancelacionDto,
    idPropietario: string,
    clave: string,
  ): Promise<ResultadoCancelacion> {
    const ahora = this.reloj.ahora();
    const huella = huellaDe(reservaId, solicitud);
    const idClave: IdClave = { idPropietario, operacion: 'CANCELAR_RESERVA', clave };
    const previa = await this.claves.leer(idClave);
    if (previa && previa.vence > ahora)
      return this.repetir(previa, huella, reservaId, idPropietario);
    if (previa) await this.claves.borrarVencidas(ahora, idClave);
    return this.ejecutar({ reservaId, solicitud, idDueno: idPropietario, idClave, huella, ahora });
  }

  /**
   * POST /api/v2/vuelos/bookings/{bookingId}/cancel (contrato v2): lo mismo que `cancelar`, más:
   *
   * - reasonCode (CUSTOMER_REQUEST por defecto) se guarda con la cancelación (codigo_motivo);
   * - SAGA_COMPENSATION y FLIGHT_CANCELLED no piden quoteId: el servidor cotiza SIN penalidad y
   *   acepta en el acto (el contrato deja la penalidad de una compensación al acuerdo B2B, que
   *   esta fase no implementa; un vuelo cancelado no es culpa del cliente). Con quoteId, vale la
   *   cotización tal como se dio;
   * - una compensación sobre una reserva ya cancelada no es un error: responde la cancelación que
   *   ya existe (200, o 202 si sigue pendiente). Booking puede repetirla con otra clave sin miedo.
   *
   * Si la reserva la cobró Booking, el reembolso solo se calcula (ver `reembolsar`).
   */
  async cancelarV2(
    reservaId: string,
    solicitud: SolicitudCancelacionV2,
    idPropietario: string,
    clave: string,
  ): Promise<ResultadoCancelacion> {
    const ahora = this.reloj.ahora();
    const huella = huellaV2(reservaId, solicitud);
    const idClave: IdClave = { idPropietario, operacion: 'CANCELAR_RESERVA', clave };
    const previa = await this.claves.leer(idClave);
    if (previa && previa.vence > ahora)
      return this.repetir(previa, huella, reservaId, idPropietario);
    if (previa) await this.claves.borrarVencidas(ahora, idClave);

    if (solicitud.reasonCode === 'SAGA_COMPENSATION') {
      const reserva = await this.reservas.detalle(reservaId, idPropietario);
      if (reserva.estado === 'CANCELADA' || reserva.estado === 'CANCELACION_PENDIENTE') {
        return {
          reserva,
          codigoHttp: reserva.estado === 'CANCELADA' ? 200 : 202,
          repetida: false,
        };
      }
    }
    let quoteId = solicitud.quoteId;
    if (quoteId === undefined) {
      if (!SIN_COTIZACION.includes(solicitud.reasonCode)) {
        throw cuerpoInvalido(
          'quoteId',
          'is required unless reasonCode is SAGA_COMPENSATION or FLIGHT_CANCELLED',
        );
      }
      quoteId = (await this.cotizar(reservaId, idPropietario, true)).id;
    }
    return this.ejecutar({
      reservaId,
      solicitud: { quoteId, ...(solicitud.reason ? { reason: solicitud.reason } : {}) },
      idDueno: idPropietario,
      idClave,
      huella,
      ahora,
      codigoMotivo: CODIGO_MOTIVO[solicitud.reasonCode],
    });
  }

  /**
   * POST /admin/bookings/{bookingId}/cancel: la cancelación de la administración, con las
   * mismas reglas, reembolso, auditoría y eventos que la del dueño. Como el administrador no
   * pide una cotización antes, el servidor crea una a nombre del dueño y la acepta enseguida.
   *
   * La Idempotency-Key es del administrador (su `sub`, no el del dueño) y su huella no incluye
   * el quoteId, que cambia en cada intento: reintentar con la misma clave repite el resultado.
   * Una reserva ya cancelada (o con la cancelación en curso) es 409 ALREADY_CANCELLED, como
   * para el dueño; con la misma clave de la cancelación original, se repite su respuesta.
   */
  async cancelarComoAdministrador(
    reservaId: string,
    idAdministrador: string,
    clave: string,
    motivo?: string,
  ): Promise<ResultadoCancelacion> {
    const ahora = this.reloj.ahora();
    const { reserva, idPropietario } = await this.reservas.detalleAdministracion(reservaId);
    const huella = huellaDeAdministracion(reservaId, motivo);
    const idClave: IdClave = {
      idPropietario: idAdministrador,
      operacion: 'CANCELAR_RESERVA',
      clave,
    };
    const previa = await this.claves.leer(idClave);
    if (previa && previa.vence > ahora)
      return this.repetir(previa, huella, reservaId, idPropietario);
    if (previa) await this.claves.borrarVencidas(ahora, idClave);

    if (reserva.estado === 'CANCELADA' || reserva.estado === 'CANCELACION_PENDIENTE') {
      throw yaCancelada(reserva.id);
    }
    const cotizacion = await this.cotizar(reservaId, idPropietario);
    return this.ejecutar({
      reservaId,
      solicitud: { quoteId: cotizacion.id, ...(motivo ? { reason: motivo } : {}) },
      idDueno: idPropietario,
      idClave,
      huella,
      ahora,
    });
  }

  /**
   * El cuerpo común de la cancelación (pasos 1 a 3 de `cancelar`). `idDueno` es el dueño de la
   * reserva; `idClave` es de quien llama (el dueño o un administrador).
   */
  private async ejecutar({
    reservaId,
    solicitud,
    idDueno: idPropietario,
    idClave,
    huella,
    ahora,
    codigoMotivo = null,
  }: {
    reservaId: string;
    solicitud: SolicitudCancelacionDto;
    idDueno: string;
    idClave: IdClave;
    huella: string;
    ahora: Date;
    codigoMotivo?: CodigoMotivo | null;
  }): Promise<ResultadoCancelacion> {
    const reserva = await this.reservas.detalle(reservaId, idPropietario);
    const cotizacion = await this.repositorio.leer(solicitud.quoteId);
    try {
      validarCancelacion(reserva, cotizacion, ahora);
      if ((await this.repositorio.pagosPendientes(reserva.id)) > 0) {
        throw new ErrorNegocio(
          409,
          CODIGO_SIN_EQUIVALENTE,
          `Booking ${reserva.id} has a payment pending in the Payment API; cancel when it is resolved`,
        );
      }

      await this.prisma.transaccionAuditada(async (tx) => {
        const reclamada = await this.claves.reclamar(tx, {
          ...idClave,
          huella,
          codigoHttp: 202,
          respuesta: { bookingId: reserva.id },
          creada: ahora,
          vence: new Date(ahora.getTime() + REGLAS_CANCELACION.vigenciaClaveHoras * HORA),
        });
        if (!reclamada) throw new ClaveEnUso();

        const estado = await this.reservas.bloquear(tx, reserva.id);
        if (estado === 'CANCELADA' || estado === 'CANCELACION_PENDIENTE')
          throw yaCancelada(reserva.id);
        if (estado !== 'CONFIRMADA')
          exigirConfirmada({ ...reserva, estado }, 'a cancellation', NO_CANCELABLE);
        if (
          !(await this.repositorio.aceptar(
            tx,
            cotizacion!.id,
            ahora,
            solicitud.reason ?? null,
            codigoMotivo,
          ))
        ) {
          throw new ErrorNegocio(
            409,
            CodigoError.QUOTE_EXPIRED,
            `Quote ${cotizacion!.id} has expired or was already used; ask for a new quote`,
          );
        }
        await this.reservas.liberarAsientosYCupo(tx, reserva.id, ahora);
        await this.boletos.anular(tx, reserva.id);
        await this.reservas.transicion(
          tx,
          reserva.id,
          'CONFIRMADA',
          'CANCELACION_PENDIENTE',
          ahora,
          {
            tipo: 'booking.cancellation_pending',
            descripcion: `Cancellation accepted; refund of ${cotizacion!.reembolso.toFixed(2)} ${reserva.total.moneda} in progress`,
          },
        );
      });
    } catch (error) {
      if (error instanceof ClaveEnUso || (error instanceof ErrorNegocio && error.status === 409)) {
        const ganadora = await this.claves.leer(idClave);
        if (ganadora) return this.repetir(ganadora, huella, reservaId, idPropietario);
      }
      throw error;
    }

    const estado = await this.reembolsar(reserva.id, reserva.total.moneda, cotizacion!, (r) =>
      this.pagos.reembolsar(r),
    );
    if (estado === 'APROBADO') {
      await this.prisma.transaccionAuditada(async (tx) => {
        await this.completar(tx, reserva.id, cotizacion!, ahora);
        await this.claves.cambiarCodigo(tx, idClave, 200);
      });
    }
    return {
      reserva: await this.reservas.detalle(reserva.id, idPropietario),
      codigoHttp: estado === 'APROBADO' ? 200 : 202,
      repetida: false,
    };
  }

  /**
   * Una cancelación que espera su reembolso (proceso periódico): aprobado, la completa;
   * pendiente o rechazado, la deja para la siguiente corrida (un reembolso no se abandona).
   */
  async procesarPendiente(pendiente: CancelacionPendiente): Promise<boolean> {
    const cotizacion = await this.repositorio.leer(pendiente.cotizacionId);
    const estado = await this.reembolsar(pendiente.reservaId, pendiente.moneda, cotizacion!, (r) =>
      this.pagos.consultarReembolso(r),
    );
    if (estado === 'RECHAZADO') {
      this.logger.warn(`La Payment API rechazó el reembolso de la reserva ${pendiente.reservaId}`);
    }
    if (estado !== 'APROBADO') return false;
    const ahora = this.reloj.ahora();
    return this.prisma.transaccionAuditada(
      async (tx) => {
        if (!(await this.reservas.tomarSiSigue(tx, pendiente.reservaId, 'CANCELACION_PENDIENTE'))) {
          return false;
        }
        await this.completar(tx, pendiente.reservaId, cotizacion!, ahora);
        return true;
      },
      { actor: SISTEMA },
    );
  }

  /**
   * CANCELADA, cotización completada y, si se devolvió algo, boletos REEMBOLSADO. Si cobró
   * Booking, los boletos quedan ANULADO: el reembolso lo ejecuta Booking, no esta API.
   */
  private async completar(
    tx: TransaccionVuelos,
    reservaId: string,
    cotizacion: CotizacionGuardada,
    ahora: Date,
  ): Promise<void> {
    await this.repositorio.completar(tx, cotizacion.id, ahora);
    if (
      cotizacion.reembolso.greaterThan(0) &&
      (await this.repositorio.pagoDeEmision(reservaId)).proveedor !== 'BOOKING_PROTOTIPO'
    ) {
      await this.boletos.marcarReembolsados(tx, reservaId);
    }
    await this.reservas.transicion(tx, reservaId, 'CANCELACION_PENDIENTE', 'CANCELADA', ahora, {
      tipo: 'booking.cancelled',
      descripcion: cotizacion.reembolso.greaterThan(0)
        ? `Booking cancelled; ${cotizacion.reembolso.toFixed(2)} refunded`
        : 'Booking cancelled; nothing to refund',
    });
  }

  /**
   * Pide (o consulta) el reembolso. Sin nada que devolver, o si el pago lo cobró Booking
   * (BOOKING_PROTOTIPO: el reembolso lo calcula esta API y lo ejecuta Booking, contrato v2 §4),
   * no llama a la Payment API y la cancelación sigue como aprobada.
   */
  private async reembolsar(
    reservaId: string,
    moneda: string,
    cotizacion: CotizacionGuardada,
    pedir: (r: ReembolsoPedido) => Promise<EstadoReembolso>,
  ): Promise<EstadoReembolso> {
    if (!cotizacion.reembolso.greaterThan(0)) return 'APROBADO';
    const emision = await this.repositorio.pagoDeEmision(reservaId);
    if (emision.proveedor === 'BOOKING_PROTOTIPO') return 'APROBADO';
    return pedir({
      referenciaPago: emision.referencia,
      operacion: cotizacion.id,
      moneda,
      monto: cotizacion.reembolso,
      correlationId: correlacionActual(),
    });
  }

  private async repetir(
    previa: ClaveGuardada,
    huella: string,
    reservaId: string,
    idPropietario: string,
  ): Promise<ResultadoCancelacion> {
    if (previa.huella !== huella) {
      throw claveConOtroCuerpo();
    }
    const codigo = previa.codigoHttp === 200 ? 200 : 202;
    return {
      reserva: await this.reservas.detalle(reservaId, idPropietario),
      codigoHttp: codigo,
      repetida: true,
    };
  }
}

/**
 * La cotización es de esta reserva (si no, o si no existe, 422: el contrato de POST .../cancel
 * no declara 404 y quoteId es un dato del cuerpo); la reserva no está ya cancelada (409
 * ALREADY_CANCELLED) y está CONFIRMADA; la cotización no venció (409 QUOTE_EXPIRED, el único
 * error que declara el contrato) y ningún vuelo salió.
 */
function validarCancelacion(
  reserva: Reserva,
  cotizacion: CotizacionGuardada | null,
  ahora: Date,
): void {
  if (!cotizacion || cotizacion.reservaId !== reserva.id) {
    throw new ErrorNegocio(422, CODIGO_SIN_EQUIVALENTE, 'quoteId: the quote was not found', {
      invalidParams: [{ name: 'quoteId', reason: 'the quote was not found for this booking' }],
    });
  }
  if (reserva.estado === 'CANCELADA' || reserva.estado === 'CANCELACION_PENDIENTE') {
    throw yaCancelada(reserva.id);
  }
  exigirConfirmada(reserva, 'a cancellation', NO_CANCELABLE);
  if (cotizacion.aceptada !== null || cotizacion.vence < ahora) {
    throw new ErrorNegocio(
      409,
      CodigoError.QUOTE_EXPIRED,
      `Quote ${cotizacion.id} has expired or was already used; ask for a new quote`,
    );
  }
  exigirSinDespegar(reserva.itinerarios, ahora);
}

/** Sin quoteId: la administración crea una cotización nueva en cada intento. */
function huellaDeAdministracion(reservaId: string, motivo: string | undefined): string {
  const canonica = { bookingId: reservaId.toLowerCase(), reason: motivo ?? null, by: 'admin' };
  return createHash('sha256').update(JSON.stringify(canonica)).digest('hex');
}

/** La de v2: sin quoteId (una compensación no lo trae), pero con el reasonCode. */
function huellaV2(reservaId: string, s: SolicitudCancelacionV2): string {
  const canonica = {
    bookingId: reservaId.toLowerCase(),
    quoteId: s.quoteId?.toLowerCase() ?? null,
    reasonCode: s.reasonCode,
    reason: s.reason ?? null,
    v: 2,
  };
  return createHash('sha256').update(JSON.stringify(canonica)).digest('hex');
}

function huellaDe(reservaId: string, s: SolicitudCancelacionDto): string {
  const canonica = {
    bookingId: reservaId.toLowerCase(),
    quoteId: s.quoteId.toLowerCase(),
    reason: s.reason ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonica)).digest('hex');
}

/**
 * Reembolso = Σ (tarifa + impuestos + maletas aprobadas) × (100 − porcentaje) / 100 por
 * itinerario, redondeado al centavo (mitad hacia arriba); penalidad = lo pagado (grandTotal,
 * que además incluye los cargos por cambio) − reembolso.
 */
export function calcularReembolso(
  lineas: LineaReembolsable[],
  totalPagado: Prisma.Decimal,
): { reembolso: Prisma.Decimal; penalidad: Prisma.Decimal } {
  const reembolso = lineas
    .reduce(
      (suma, l) =>
        suma.plus(
          l.base
            .plus(l.impuestos)
            .plus(l.equipaje)
            .times(CIEN.minus(l.porcentajePenalidad))
            .div(CIEN),
        ),
      new Prisma.Decimal(0),
    )
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return { reembolso, penalidad: totalPagado.minus(reembolso) };
}
