import { Injectable } from '@nestjs/common';
import { CodigoError } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { TransaccionVuelos } from '../../../../prisma/prisma.service';
import { Boleto } from './boleto.modelo';
import { BoletoRepository, NumeroBoletoAgotado } from './boleto.repository';

/**
 * Boletos de una reserva: los crea pendientes, los emite y los da por fallidos dentro de la
 * transacción de la reserva, y los lee para GET /bookings/{bookingId}/tickets. La propiedad
 * de la reserva la comprueba ReservaService antes de llamar a las lecturas.
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

  deReserva(reservaId: string): Promise<Boleto[]> {
    return this.repositorio.deReserva(reservaId);
  }

  async uno(reservaId: string, boletoId: string): Promise<Boleto | undefined> {
    const [boleto] = await this.repositorio.deReserva(reservaId, boletoId);
    return boleto;
  }
}
