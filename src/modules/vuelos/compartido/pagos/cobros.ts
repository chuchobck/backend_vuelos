import { Inject, Injectable } from '@nestjs/common';
import { CodigoError } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { PagosRepository } from './pagos.repository';
import { CobroEsperado, SERVICIO_PAGOS, ServicioPagos } from './servicio-pagos';

/**
 * Cobrar con una paymentReference, igual en todas las operaciones (reserva, equipaje, cambio
 * de fecha), antes de abrir la transacción: una referencia ya usada en otra operación es 409;
 * una que la Payment API no reconoce o que rechazó es 422 y la operación no se hace. Aprobado
 * o pendiente, la operación sigue. Los errores nombran el campo, nunca la referencia.
 */
@Injectable()
export class Cobros {
  constructor(
    @Inject(SERVICIO_PAGOS) private readonly pagos: ServicioPagos,
    private readonly registrados: PagosRepository,
  ) {}

  async autorizar(cobro: CobroEsperado): Promise<'APROBADO' | 'PENDIENTE'> {
    if (await this.registrados.referenciaUsada(cobro.referencia)) {
      throw new ErrorNegocio(
        409,
        CodigoError.PAYMENT_REFERENCE_INVALID,
        'payment.paymentReference: was already used for another operation',
      );
    }
    const estado = await this.pagos.autorizar(cobro);
    if (estado === 'INVALIDO') {
      throw new ErrorNegocio(
        422,
        CodigoError.PAYMENT_REFERENCE_INVALID,
        'payment.paymentReference: is not a payment of the Payment API',
        { invalidParams: [{ name: 'payment.paymentReference', reason: 'unknown payment' }] },
      );
    }
    if (estado === 'RECHAZADO') {
      throw new ErrorNegocio(
        422,
        CodigoError.PAYMENT_NOT_AUTHORIZED,
        'The payment was not authorized by the Payment API',
      );
    }
    return estado;
  }
}
