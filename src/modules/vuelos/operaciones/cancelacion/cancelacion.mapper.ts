import { aInstante, aTextoDecimal } from '../../compartido/formatos-salida';
import { Cotizacion } from './cancelacion.modelo';
import { CotizacionCancelacionDto } from './dto/cancelacion.dto';

export function aCotizacion(cotizacion: Cotizacion): CotizacionCancelacionDto {
  return {
    quoteId: cotizacion.id,
    isRefundable: cotizacion.reembolso.greaterThan(0),
    refundAmount: aTextoDecimal(cotizacion.reembolso),
    penaltyAmount: aTextoDecimal(cotizacion.penalidad),
    currency: cotizacion.moneda,
    expiresAt: aInstante(cotizacion.vence),
  };
}
