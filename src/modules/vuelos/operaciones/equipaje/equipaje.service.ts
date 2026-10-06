import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CodigoError, CODIGO_SIN_EQUIVALENTE } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { Reloj } from '../../../../common/reloj';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ClaveGuardada, IdempotenciaRepository } from '../../compartido/idempotencia.repository';
import { Cobros } from '../../compartido/pagos/cobros';
import { PagosRepository } from '../../compartido/pagos/pagos.repository';
import { SERVICIO_PAGOS, ServicioPagos } from '../../compartido/pagos/servicio-pagos';
import { EventosReserva } from '../reserva/eventos-reserva';
import {
  exigirConfirmada,
  exigirSinDespegar,
  itinerarioDeLaReserva,
} from '../reserva/reglas-postventa';
import { Reserva } from '../reserva/reserva.modelo';
import { ReservaService } from '../reserva/reserva.service';
import { EquipajeAgregadoDto, SolicitudEquipajeDto } from './dto/equipaje.dto';
import { aEquipajeAgregado } from './equipaje.mapper';
import { OpcionEquipaje } from './equipaje.modelo';
import { CompraPendiente, EquipajeRepository } from './equipaje.repository';

/** Reglas del equipaje adicional. */
export const REGLAS_EQUIPAJE = {
  /** Cuánto se recuerda una Idempotency-Key de POST .../baggage. */
  vigenciaClaveHoras: 24,
};

const HORA = 60 * 60_000;

export interface ResultadoEquipaje {
  cuerpo: EquipajeAgregadoDto;
  codigoHttp: 200 | 202;
  repetida: boolean;
}

/**
 * Maletas adicionales después de emitir (GET .../baggage-options y POST .../baggage).
 *
 * - Precio de una maleta: `precio_equipaje_adicional` de la tarifa de la familia vendida, sumado
 *   sobre los vuelos del itinerario (el mismo extraCheckedBaggagePrice de la búsqueda), el de
 *   hoy, y se congela en la compra (`precio_unitario`).
 * - Máximo: `maximo_equipaje_adicional` de la familia, por pasajero e itinerario. Un infante no
 *   tiene equipaje de bodega propio: su máximo es 0.
 * - Ya comprado: las maletas con pago aprobado o pendiente; las de pago rechazado no cuentan.
 *
 * El cobro va por ServicioPagos (Cobros) con una referencia nueva: aprobado, 200; pendiente,
 * 202 y la maleta ya cuenta para el máximo (el proceso periódico confirma o rechaza el pago);
 * rechazado o inválido, 422 sin cambios.
 */
@Injectable()
export class EquipajeService {
  constructor(
    private readonly repositorio: EquipajeRepository,
    private readonly reservas: ReservaService,
    private readonly eventos: EventosReserva,
    private readonly claves: IdempotenciaRepository,
    private readonly cobros: Cobros,
    private readonly pagosRegistrados: PagosRepository,
    @Inject(SERVICIO_PAGOS) private readonly pagos: ServicioPagos,
    private readonly prisma: PrismaService,
    private readonly reloj: Reloj,
  ) {}

  /** Una opción por pasajero e itinerario vigente de la reserva. */
  async opciones(reservaId: string, idPropietario: string): Promise<OpcionEquipaje[]> {
    const reserva = await this.reservas.detalle(reservaId, idPropietario);
    exigirConfirmada(reserva, 'buying extra baggage');
    return reserva.pasajeros.flatMap((pasajero) =>
      reserva.itinerarios.map((itinerario) => ({
        codigoPasajero: pasajero.codigo,
        itinerarioId: itinerario.id,
        moneda: reserva.total.moneda,
        precio: itinerario.familia.equipajeAdicional,
        maximo: pasajero.tipo === 'INFANTE' ? 0 : itinerario.familia.maximoEquipaje,
        comprado: pasajero.equipaje
          .filter((e) => e.itinerarioId === itinerario.id)
          .reduce((suma, e) => suma + e.cantidad, 0),
      })),
    );
  }

  async agregar(
    reservaId: string,
    solicitud: SolicitudEquipajeDto,
    idPropietario: string,
    clave: string,
  ): Promise<ResultadoEquipaje> {
    const ahora = this.reloj.ahora();
    const huella = huellaDe(reservaId, solicitud);
    const idClave = { idPropietario, operacion: 'AGREGAR_EQUIPAJE' as const, clave };
    const previa = await this.claves.leer(idClave);
    if (previa && previa.vence > ahora) return repetir(previa, huella);
    if (previa) await this.claves.borrarVencidas(ahora, idClave);

    try {
      return await this.agregarNueva(reservaId, solicitud, idPropietario, idClave, huella, ahora);
    } catch (error) {
      // Otra petición con la misma clave pudo ganar mientras esta esperaba al pasajero
      if (error instanceof ErrorNegocio && error.status === 409) {
        const ganadora = await this.claves.leer(idClave);
        if (ganadora) return repetir(ganadora, huella);
      }
      throw error;
    }
  }

  private async agregarNueva(
    reservaId: string,
    solicitud: SolicitudEquipajeDto,
    idPropietario: string,
    idClave: { idPropietario: string; operacion: 'AGREGAR_EQUIPAJE'; clave: string },
    huella: string,
    ahora: Date,
  ): Promise<ResultadoEquipaje> {
    const reserva = await this.reservas.detalle(reservaId, idPropietario);
    exigirConfirmada(reserva, 'buying extra baggage');
    const itinerario = itinerarioDeLaReserva(reserva, solicitud.itineraryId, 'itineraryId');
    exigirSinDespegar([itinerario], ahora);
    const pasajero = pasajeroDeLaReserva(reserva, solicitud.passengerId);
    const maximo = pasajero.tipo === 'INFANTE' ? 0 : itinerario.familia.maximoEquipaje;
    const yaComprado = pasajero.equipaje
      .filter((e) => e.itinerarioId === itinerario.id)
      .reduce((suma, e) => suma + e.cantidad, 0);
    exigirCupoDeMaletas(solicitud.quantity, maximo, yaComprado);

    const precio = itinerario.familia.equipajeAdicional;
    const referencia = solicitud.payment.paymentReference;
    const pago = await this.cobros.autorizar({
      referencia,
      concepto: 'EQUIPAJE_ADICIONAL',
      moneda: reserva.total.moneda,
      monto: precio.times(solicitud.quantity),
    });
    const codigoHttp = pago === 'APROBADO' ? 200 : 202;

    return this.prisma.transaccionAuditada(async (tx) => {
      // El pasajero bloqueado: otra compra suya espera y cuenta las maletas de esta
      const pasajeroId = await this.repositorio.bloquearPasajero(tx, reserva.id, pasajero.codigo);
      const lineaId = await this.repositorio.lineaVigente(tx, reserva.id, itinerario.id);
      if (pasajeroId === null || lineaId === null) throw new Error('La reserva cambió');
      const compradas = await this.repositorio.compradas(tx, pasajeroId, lineaId);
      exigirCupoDeMaletas(solicitud.quantity, maximo, compradas);

      const cuerpo = aEquipajeAgregado({
        codigoPasajero: pasajero.codigo,
        itinerarioId: itinerario.id,
        total: compradas + solicitud.quantity,
      });
      const reclamada = await this.claves.reclamar(tx, {
        ...idClave,
        huella,
        codigoHttp,
        respuesta: { ...cuerpo },
        creada: ahora,
        vence: new Date(ahora.getTime() + REGLAS_EQUIPAJE.vigenciaClaveHoras * HORA),
      });
      if (!reclamada) throw claveEnUso();

      const pagoId = await this.pagosRegistrados.registrar(tx, {
        reservaId: reserva.id,
        referencia,
        concepto: 'EQUIPAJE_ADICIONAL',
        estado: pago,
        fecha: ahora,
      });
      await this.repositorio.registrar(tx, {
        pasajeroId,
        lineaId,
        pagoId,
        cantidad: solicitud.quantity,
        precioUnitario: precio,
        fecha: ahora,
      });
      await this.eventos.registrar(tx, reserva.id, {
        tipo: pago === 'APROBADO' ? 'booking.baggage_added' : 'booking.baggage_pending',
        descripcion:
          pago === 'APROBADO'
            ? `${solicitud.quantity} extra bag(s) added for passenger ${pasajero.codigo}`
            : `${solicitud.quantity} extra bag(s) for passenger ${pasajero.codigo}: payment pending`,
        fecha: ahora,
      });
      return { cuerpo, codigoHttp, repetida: false };
    });
  }

  /**
   * Una compra con pago PENDIENTE (proceso periódico): aprobado, queda confirmada; rechazado,
   * deja de contar (el pago queda RECHAZADO; nada se borra). Si sigue pendiente, no la toca.
   */
  async procesarPendiente(compra: CompraPendiente): Promise<'APROBADO' | 'RECHAZADO' | null> {
    const pago = await this.pagos.consultar(compra.referencia);
    if (pago === 'PENDIENTE') return null;
    const ahora = this.reloj.ahora();
    return this.prisma.transaccionAuditada(
      async (tx) => {
        if (!(await this.repositorio.tomarPendiente(tx, compra.pagoId))) return null;
        await this.pagosRegistrados.resolver(tx, compra.pagoId, pago);
        const { codigoPasajero, cantidad } = await this.repositorio.deCompra(tx, compra.pagoId);
        await this.eventos.registrar(tx, compra.reservaId, {
          tipo: pago === 'APROBADO' ? 'booking.baggage_added' : 'booking.baggage_rejected',
          descripcion:
            pago === 'APROBADO'
              ? `${cantidad} extra bag(s) added for passenger ${codigoPasajero}`
              : `${cantidad} extra bag(s) for passenger ${codigoPasajero} not added: payment not authorized`,
          fecha: ahora,
        });
        return pago;
      },
      { actor: { idUsuario: null, direccionIp: null } },
    );
  }
}

function pasajeroDeLaReserva(reserva: Reserva, codigo: string) {
  const pasajero = reserva.pasajeros.find((p) => p.codigo === codigo);
  if (!pasajero) {
    throw new ErrorNegocio(
      422,
      CODIGO_SIN_EQUIVALENTE,
      'passengerId: is not a passenger of this booking',
      { invalidParams: [{ name: 'passengerId', reason: 'is not a passenger of this booking' }] },
    );
  }
  return pasajero;
}

/** 409 BAGGAGE_LIMIT_EXCEEDED si la compra pasa el máximo de la familia. */
function exigirCupoDeMaletas(cantidad: number, maximo: number, compradas: number): void {
  if (compradas + cantidad > maximo) {
    throw new ErrorNegocio(
      409,
      CodigoError.BAGGAGE_LIMIT_EXCEEDED,
      `At most ${maximo} extra bag(s) for this passenger on this itinerary; ` +
        `${compradas} already bought`,
    );
  }
}

function repetir(previa: ClaveGuardada, huella: string): ResultadoEquipaje {
  if (previa.huella !== huella) {
    throw new ErrorNegocio(
      422,
      CODIGO_SIN_EQUIVALENTE,
      'This Idempotency-Key was already used with a different request body',
      { invalidParams: [{ name: 'Idempotency-Key', reason: 'already used with another body' }] },
    );
  }
  if ((previa.codigoHttp !== 200 && previa.codigoHttp !== 202) || previa.respuesta === null) {
    throw claveEnUso();
  }
  const guardada = previa.respuesta as unknown as EquipajeAgregadoDto;
  return {
    cuerpo: {
      passengerId: guardada.passengerId,
      itineraryId: guardada.itineraryId,
      totalBaggage: guardada.totalBaggage,
    },
    codigoHttp: previa.codigoHttp,
    repetida: true,
  };
}

/** La otra petición con la misma clave ganó; quien llama vuelve a leer la clave (409). */
const claveEnUso = () =>
  new ErrorNegocio(
    409,
    CODIGO_SIN_EQUIVALENTE,
    'A request with this Idempotency-Key is in progress',
    {
      cabeceras: { 'Retry-After': '1' },
    },
  );

/** SHA-256 de la reserva y el cuerpo, con las claves en un orden fijo. */
function huellaDe(reservaId: string, s: SolicitudEquipajeDto): string {
  const canonica = {
    bookingId: reservaId.toLowerCase(),
    passengerId: s.passengerId,
    itineraryId: s.itineraryId.toLowerCase(),
    quantity: s.quantity,
    payment: { paymentReference: s.payment.paymentReference },
  };
  return createHash('sha256').update(JSON.stringify(canonica)).digest('hex');
}
