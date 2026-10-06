import { Injectable } from '@nestjs/common';
import { CodigoError } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { esUuid } from '../../../../common/pipes/formatos';
import { TransaccionVuelos } from '../../../../prisma/prisma.service';
import { noExiste } from '../../compartido/errores';
import { Boleto } from './boleto.modelo';
import { BoletoRepository, NumeroBoletoAgotado } from './boleto.repository';

/**
 * Boletos de una reserva: los crea pendientes, los emite y los da por fallidos dentro de la
 * transacción de la reserva, y los lee para GET /bookings/{bookingId}/tickets, solo para el
 * dueño de la reserva: para cualquier otro, la reserva no existe (404).
 */
@Injectable()
export class BoletoService {
  constructor(private readonly repositorio: BoletoRepository) {}

  crearPendientes(tx: TransaccionVuelos, reservaId: string, ahora: Date): Promise<void> {
    return this.repositorio.crearPendientes(tx, reservaId, ahora);
  }

  /** Emite los boletos pendientes con el prefijo de la aerolínea. Devuelve cuántos emitió. */
  async emitir(
    tx: TransaccionVuelos,
    reservaId: string,
    prefijo: string,
    ahora: Date,
  ): Promise<number> {
    try {
      return await this.repositorio.emitir(tx, reservaId, prefijo, ahora);
    } catch (error) {
      if (error instanceof NumeroBoletoAgotado) {
        throw new ErrorNegocio(
          409,
          CodigoError.TICKET_ISSUANCE_FAILED,
          'A ticket number could not be assigned; retry',
          { cabeceras: { 'Retry-After': '1' } },
        );
      }
      throw error;
    }
  }

  fallar(tx: TransaccionVuelos, reservaId: string, motivo: string): Promise<void> {
    return this.repositorio.fallar(tx, reservaId, motivo);
  }

  /** EMITIDO → ANULADO: la reserva se canceló y los boletos ya no sirven para volar. */
  anular(tx: TransaccionVuelos, reservaId: string): Promise<number> {
    return this.repositorio.cambiarEstado(tx, reservaId, 'EMITIDO', 'ANULADO');
  }

  /**
   * ANULADO → REEMBOLSADO: el reembolso de la cancelación se aprobó. Solo los boletos de los
   * itinerarios vigentes; los anulados antes por un cambio de fecha siguen ANULADO.
   */
  marcarReembolsados(tx: TransaccionVuelos, reservaId: string): Promise<number> {
    return this.repositorio.reembolsarVigentes(tx, reservaId);
  }

  deReserva(reservaId: string): Promise<Boleto[]> {
    return this.repositorio.deReserva(reservaId);
  }

  /** GET /bookings/{bookingId}/tickets. */
  async consultar(reservaId: string, idPropietario: string): Promise<Boleto[]> {
    await this.comprobarDueno(reservaId, idPropietario);
    return this.repositorio.deReserva(reservaId);
  }

  /**
   * GET /bookings/{bookingId}/tickets/{ticketId}. El contrato no le da formato a ticketId: uno
   * que no es uuid no puede existir y es 404, como uno que no es de esa reserva.
   */
  async consultarUno(reservaId: string, boletoId: string, idPropietario: string): Promise<Boleto> {
    await this.comprobarDueno(reservaId, idPropietario);
    const [boleto] = esUuid(boletoId) ? await this.repositorio.deReserva(reservaId, boletoId) : [];
    if (!boleto) throw noExiste(`Ticket ${boletoId} was not found in booking ${reservaId}`);
    return boleto;
  }

  private async comprobarDueno(reservaId: string, idPropietario: string): Promise<void> {
    if ((await this.repositorio.propietarioDeReserva(reservaId)) !== idPropietario) {
      throw noExiste(`Booking ${reservaId} was not found`);
    }
  }
}
