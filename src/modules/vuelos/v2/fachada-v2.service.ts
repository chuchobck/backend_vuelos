import { Injectable } from '@nestjs/common';
import { CodigoError } from '../../../common/errores/codigo-error';
import { CodigoErrorV2 } from '../../../common/errores/codigo-error-v2';
import { ErrorNegocio } from '../../../common/errores/error-negocio';
import { ESTADO_RESERVA } from '../compartido/enums';
import { noExiste } from '../compartido/errores';
import { CancelacionRepository } from '../operaciones/cancelacion/cancelacion.repository';
import { OfertaService } from '../operaciones/oferta/oferta.service';
import { Reserva } from '../operaciones/reserva/reserva.modelo';
import { ReservaService } from '../operaciones/reserva/reserva.service';
import {
  CancelacionV2Dto,
  DetalleReservaV2Dto,
  EmisionBoletosDto,
  MapaAsientosV2Dto,
} from './dto/respuestas-v2.dto';
import { FachadaV2Repository } from './fachada-v2.repository';
import { UsuarioV2 } from './partner/usuario-v2';
import { aCancelacionV2, aDetalleReservaV2, aEmisionBoletos, aMapaAsientosV2 } from './v2.mapper';

/**
 * Lo que la fachada v2 hace además de llamar a los services de v1: el filtro por usuario final
 * de un partner, la emisión de boletos (issueTickets, que v1 no tiene como operación) y los
 * datos que v2 suma a las respuestas.
 */
@Injectable()
export class FachadaV2Service {
  constructor(
    private readonly repositorio: FachadaV2Repository,
    private readonly reservas: ReservaService,
    private readonly ofertas: OfertaService,
    private readonly cancelaciones: CancelacionRepository,
  ) {}

  /**
   * Un partner que manda X-User-Id solo ve y opera las reservas de ese usuario: otra (o una sin
   * usuario final) es 404, como una que no existe. Sin X-User-Id ve todas las suyas; que sean del
   * dueño lo comprueban los services de v1, como siempre.
   */
  async exigirAcceso(reservaId: string, usuario: UsuarioV2): Promise<void> {
    if (usuario.usuarioExterno === undefined) return;
    const acceso = await this.repositorio.accesoReserva(reservaId);
    if (
      acceso === null ||
      acceso.idPropietario !== usuario.id ||
      acceso.usuarioExterno !== usuario.usuarioExterno
    ) {
      throw noExiste(`Booking ${reservaId} was not found`);
    }
  }

  async detalle(reserva: Reserva): Promise<DetalleReservaV2Dto> {
    return aDetalleReservaV2(reserva, await this.repositorio.datosDeReserva(reserva.id));
  }

  async mapaDeAsientos(ofertaId: string, segmentoId: string): Promise<MapaAsientosV2Dto> {
    const mapa = await this.ofertas.mapaDeAsientos(ofertaId, segmentoId);
    return aMapaAsientosV2(mapa, await this.repositorio.estadosDeAsientos(mapa.salidaId));
  }

  /**
   * POST .../tickets (issueTickets). Idempotente por construcción (contrato v2):
   *
   * - CONFIRMED: los boletos ya están emitidos; 200 con `issued: 0`.
   * - PENDING_PAYMENT (cobro AIRLINE_DIRECT que la Payment API dejó pendiente): se le pregunta
   *   ahora, como haría el proceso periódico; aprobado, se emiten (`issued` = los emitidos); si
   *   sigue pendiente, 200 TICKET_ISSUING con `issued: 0`.
   * - TICKET_ISSUING: la emisión está en curso; 200 TICKET_ISSUING.
   * - Cualquier otro estado (fallida, cancelada, con un cambio pendiente): 409
   *   BOOKING_NOT_CONFIRMED.
   *
   * Con BOOKING_PROTOTIPO la reserva se emite al crearla (201 CONFIRMED): esta llamada es la que
   * Booking hace en el paso 6 de su saga y responde `issued: 0`.
   */
  async emitirBoletos(reservaId: string, usuario: UsuarioV2): Promise<EmisionBoletosDto> {
    await this.exigirAcceso(reservaId, usuario);
    let reserva = await this.reservas.detalle(reservaId, usuario.id);
    let emitidos = 0;
    if (reserva.estado === 'PENDIENTE_PAGO') {
      const { referenciaPago } = await this.repositorio.datosDeReserva(reservaId);
      const estado = await this.reservas.procesarPendiente(reservaId, referenciaPago!);
      reserva = await this.reservas.detalle(reservaId, usuario.id);
      if (estado === 'CONFIRMADA') {
        emitidos = reserva.boletos.filter((b) => b.estado === 'EMITIDO').length;
      }
    }
    if (!['CONFIRMADA', 'PENDIENTE_PAGO', 'EMITIENDO_BOLETOS'].includes(reserva.estado)) {
      throw new ErrorNegocio(
        409,
        CodigoError.BOOKING_NOT_CONFIRMED,
        `Booking ${reserva.id} is ${ESTADO_RESERVA.aContrato(reserva.estado)}; ` +
          'its tickets cannot be issued',
        { v2: { code: CodigoErrorV2.BOOKING_NOT_CONFIRMED } },
      );
    }
    return aEmisionBoletos(reserva, emitidos);
  }

  /** CancelBookingResponse de una reserva ya cancelada (o con la cancelación en curso). */
  async cancelacion(reserva: Reserva): Promise<CancelacionV2Dto> {
    const [aceptada, datos] = await Promise.all([
      this.cancelaciones.aceptadaDe(reserva.id),
      this.repositorio.datosDeReserva(reserva.id),
    ]);
    const liberados =
      aceptada?.aceptada === null || aceptada === null
        ? 0
        : await this.repositorio.asientosLiberados(reserva.id, aceptada.aceptada);
    return aCancelacionV2(reserva, aceptada!, datos, liberados);
  }
}
