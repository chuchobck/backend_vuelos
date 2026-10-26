import { Inject, Injectable } from '@nestjs/common';
import { CodigoError } from '../../../../common/errores/codigo-error';
import { correlacionActual } from '../../../../common/contexto/correlation-id';
import { CodigoErrorV2 } from '../../../../common/errores/codigo-error-v2';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { PagosRepository } from './pagos.repository';
import { CobroEsperado, PagoDeFachada, SERVICIO_PAGOS, ServicioPagos } from './servicio-pagos';

/**
 * Cobrar con una paymentReference, igual en todas las operaciones (reserva, equipaje, cambio
 * de fecha), antes de abrir la transacción: una referencia ya usada en otra operación es 409;
 * una que la Payment API no reconoce o que rechazó es 422 y la operación no se hace. Aprobado
 * o pendiente, la operación sigue. Los errores nombran el campo, nunca la referencia. El cobro
 * lleva el X-Correlation-Id de la petición, que la Payment API recibe sin cambios.
 *
 * Desde la fachada v2 (`fachada`), además:
 * - si llega `payment.amount`, tiene que ser el monto y la moneda del cobro: si no, 422
 *   AMOUNT_MISMATCH (antes de mirar la referencia);
 * - con BOOKING_PROTOTIPO el cobro ya lo hizo Booking: NO se llama a la Payment API; la
 *   referencia solo tiene que no haber acreditado otra operación (si no, 422
 *   PAYMENT_REFERENCE_INVALID) y la operación queda APROBADA.
 */
@Injectable()
export class Cobros {
  constructor(
    @Inject(SERVICIO_PAGOS) private readonly pagos: ServicioPagos,
    private readonly registrados: PagosRepository,
  ) {}

  async autorizar(
    cobro: CobroEsperado,
    fachada?: PagoDeFachada,
  ): Promise<'APROBADO' | 'PENDIENTE'> {
    if (fachada?.monto) exigirMismoMonto(cobro, fachada.monto);
    if (fachada?.proveedor === 'BOOKING_PROTOTIPO') {
      if (await this.registrados.referenciaUsada(cobro.referencia)) {
        throw new ErrorNegocio(
          422,
          CodigoError.PAYMENT_REFERENCE_INVALID,
          'payment.paymentReference: was already used for another operation',
          {
            invalidParams: [{ name: 'payment.paymentReference', reason: 'already used' }],
            v2: { code: CodigoErrorV2.PAYMENT_REFERENCE_INVALID },
          },
        );
      }
      return 'APROBADO';
    }
    if (await this.registrados.referenciaUsada(cobro.referencia)) {
      throw new ErrorNegocio(
        409,
        CodigoError.PAYMENT_REFERENCE_INVALID,
        'payment.paymentReference: was already used for another operation',
        // En v2 la referencia de Booking que no sirve es siempre 422 PAYMENT_REFERENCE_INVALID
        { v2: { status: 422, code: CodigoErrorV2.PAYMENT_REFERENCE_INVALID } },
      );
    }
    const estado = await this.pagos.autorizar({ ...cobro, correlationId: correlacionActual() });
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

/** payment.amount tiene que ser el cobro: la misma moneda y el mismo total, al centavo. */
function exigirMismoMonto(cobro: CobroEsperado, monto: { moneda: string; total: string }): void {
  if (monto.moneda !== cobro.moneda || !cobro.monto.equals(monto.total)) {
    throw new ErrorNegocio(
      422,
      CodigoError.AMOUNT_MISMATCH,
      `payment.amount: does not match the price of this operation (${cobro.monto.toFixed(2)} ` +
        `${cobro.moneda})`,
      { invalidParams: [{ name: 'payment.amount', reason: 'does not match the price' }] },
    );
  }
}
