import { Injectable } from '@nestjs/common';
import { CodigoError } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { Reloj } from '../../../../common/reloj';
import { estado_vuelo } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { noExiste } from '../../compartido/errores';
import { aFecha } from '../../compartido/formatos-salida';
import { CodigoPase } from '../../operaciones/pase-abordar/codigo-pase';
import { ReservaService } from '../../operaciones/reserva/reserva.service';
import { Abordaje, Manifiesto, SalidaDeEmbarque } from './embarque.modelo';
import { EmbarqueRepository } from './embarque.repository';

/** Estados en los que la salida ya se fue: no se embarca a nadie más. */
const YA_SALIO: estado_vuelo[] = ['DESPEGADO', 'ATERRIZADO', 'DESVIADO'];

/**
 * Los errores del escaneo. Cada validación tiene su `code` (propios del proyecto, salvo
 * FLIGHT_ALREADY_DEPARTED). Ningún detalle lleva el nombre del pasajero, su documento, el PNR
 * ni el código escaneado: dicen qué falló, no de quién.
 */
const ERRORES = {
  formato: () =>
    new ErrorNegocio(
      400,
      CodigoError.BOARDING_PASS_MALFORMED,
      'The scanned text is not a boarding pass barcode',
      { invalidParams: [{ name: 'barcode', reason: 'is not a boarding pass barcode' }] },
    ),
  firma: () =>
    new ErrorNegocio(
      422,
      CodigoError.BOARDING_PASS_SIGNATURE_INVALID,
      'The boarding pass signature is not valid: it was not issued by this airline or it was altered',
    ),
  cancelada: (salida: SalidaDeEmbarque) =>
    new ErrorNegocio(
      409,
      CodigoError.FLIGHT_CANCELLED,
      `Flight ${salida.numeroVuelo} on ${aFecha(salida.fechaSalida)} is cancelled`,
    ),
  yaSalio: (salida: SalidaDeEmbarque) =>
    new ErrorNegocio(
      409,
      CodigoError.FLIGHT_ALREADY_DEPARTED,
      `Flight ${salida.numeroVuelo} on ${aFecha(salida.fechaSalida)} has already departed`,
    ),
  otraSalida: (vuelo: string, fecha: string) =>
    new ErrorNegocio(
      409,
      CodigoError.BOARDING_PASS_WRONG_FLIGHT,
      `This boarding pass is for flight ${vuelo} on ${fecha}, not for the departure at this gate`,
    ),
  noExiste: () =>
    new ErrorNegocio(
      404,
      CodigoError.BOARDING_PASS_NOT_FOUND,
      'The ticket of this boarding pass was not found',
    ),
  noVigente: (motivo: string) => new ErrorNegocio(409, CodigoError.BOARDING_PASS_NOT_VALID, motivo),
  sinCheckin: () =>
    new ErrorNegocio(
      409,
      CodigoError.PASSENGER_NOT_CHECKED_IN,
      'The passenger is not checked in for this flight',
    ),
  yaAbordo: (cuando: Date | null) =>
    new ErrorNegocio(
      409,
      CodigoError.ALREADY_BOARDED,
      cuando
        ? `The passenger already boarded at ${cuando.toISOString()}`
        : 'The passenger has already boarded',
    ),
};

/**
 * Embarque de una salida (fase F1, fuera del contrato; `flights:admin`).
 *
 * `escanear` valida el código de un pase en este orden y con un `code` por cada cosa: formato,
 * firma (la misma de `CodigoPase`, que lo emitió), la salida existe, no está cancelada ni se
 * fue, el pase es de ESA salida, el boleto existe y es de ese PNR, reserva y boleto vigentes, el
 * pasajero tiene check-in, el código es el del pase emitido y no abordó ya. Si pasa, marca el
 * abordaje con la hora del `Reloj`.
 *
 * Carreras: la transacción bloquea primero la reserva (como la cancelación y el cambio de
 * fecha: ninguna de las dos corre en medio) y el abordaje es un UPDATE condicionado a que
 * `fecha_abordaje` siga NULL. De dos escaneos a la vez, el segundo recibe ALREADY_BOARDED.
 *
 * No mueve cupo (sin `OrdenesStock`) ni publica eventos (no hay un tipo de evento de abordaje:
 * sus esquemas son del notifier). El rastro es la auditoría de `checkin`, con el agente.
 */
@Injectable()
export class EmbarqueService {
  constructor(
    private readonly repositorio: EmbarqueRepository,
    private readonly codigo: CodigoPase,
    private readonly reservas: ReservaService,
    private readonly prisma: PrismaService,
    private readonly reloj: Reloj,
  ) {}

  async escanear(salidaId: string, codigoBarras: string): Promise<Abordaje> {
    if (!this.codigo.tieneFormato(codigoBarras)) throw ERRORES.formato();
    const pase = this.codigo.verificar(codigoBarras);
    if (!pase) throw ERRORES.firma();

    const salida = await this.salida(salidaId);
    if (salida.estado === 'CANCELADO') throw ERRORES.cancelada(salida);
    if (YA_SALIO.includes(salida.estado)) throw ERRORES.yaSalio(salida);
    if (
      pase.numeroVuelo !== salida.numeroVuelo ||
      pase.fechaSalida !== aFecha(salida.fechaSalida) ||
      pase.origen !== salida.origen ||
      pase.destino !== salida.destino
    ) {
      throw ERRORES.otraSalida(pase.numeroVuelo, pase.fechaSalida);
    }

    const boleto = await this.repositorio.boleto(pase.numeroBoleto);
    if (!boleto || boleto.pnr !== pase.pnr) throw ERRORES.noExiste();

    const ahora = this.reloj.ahora();
    return this.prisma.transaccionAuditada(async (tx) => {
      await this.reservas.bloquear(tx, boleto.reservaId);
      const situacion = await this.repositorio.situacion(tx, pase.numeroBoleto, salida.id);
      if (!situacion) throw ERRORES.noExiste();
      if (situacion.estadoReserva !== 'CONFIRMADA') {
        throw ERRORES.noVigente('The booking of this boarding pass is not confirmed');
      }
      if (situacion.estadoBoleto !== 'EMITIDO' || !situacion.cuponEmitido) {
        throw ERRORES.noVigente('The ticket of this boarding pass is no longer valid');
      }
      if (!situacion.vigente) {
        throw ERRORES.noVigente('The booking no longer includes this flight');
      }
      if (situacion.checkinId === null) throw ERRORES.sinCheckin();
      if (situacion.codigoBarras !== codigoBarras || situacion.asiento !== pase.asiento) {
        throw ERRORES.noVigente('This is not the boarding pass issued for this passenger');
      }
      if (situacion.abordado) throw ERRORES.yaAbordo(situacion.abordado);
      // Solo uno de dos escaneos simultáneos encuentra la fila sin abordar
      if (!(await this.repositorio.abordar(tx, situacion.checkinId, ahora))) {
        throw ERRORES.yaAbordo(null);
      }
      const infantes = await this.repositorio.abordarInfantes(
        tx,
        situacion.pasajeroId,
        salida.id,
        ahora,
      );
      return {
        salida,
        asiento: pase.asiento,
        grupo: situacion.grupo,
        posicion: situacion.posicion,
        abordado: ahora,
        pasajero: {
          codigo: situacion.codigoPasajero,
          nombres: situacion.nombres,
          apellidos: situacion.apellidos,
        },
        infantes,
      };
    });
  }

  /** El manifiesto de la salida: conteos y una fila por asiento vendido, sin datos personales. */
  async manifiesto(salidaId: string): Promise<Manifiesto> {
    const salida = await this.salida(salidaId);
    const [asientos, infantes] = await Promise.all([
      this.repositorio.asientos(salida.id),
      this.repositorio.infantes(salida.id),
    ]);
    return { salida, asientos, infantes };
  }

  private async salida(salidaId: string): Promise<SalidaDeEmbarque> {
    const salida = await this.repositorio.salida(salidaId);
    if (!salida) throw noExiste(`Departure ${salidaId} was not found`);
    return salida;
  }
}
