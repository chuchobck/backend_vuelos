import { MontoDto } from '../../compartido/dto/monto.dto';
import { ESTADO_RETENCION } from '../../compartido/enums';
import { aInstante, aTextoDecimal } from '../../compartido/formatos-salida';
import { EstadoRetencionDto, RetencionCreadaDto } from './dto/respuesta-retencion.dto';
import { PrecioCongelado, Retencion, RetencionCreada } from './retencion.modelo';

export function aPrecioCongelado(precio: PrecioCongelado): MontoDto {
  return {
    currency: precio.moneda,
    baseFare: aTextoDecimal(precio.base),
    taxes: aTextoDecimal(precio.impuestos),
    total: aTextoDecimal(precio.total),
  };
}

export function aRetencionCreada(retencion: RetencionCreada): RetencionCreadaDto {
  return {
    holdId: retencion.id,
    status: 'HELD',
    expiresAt: aInstante(retencion.vence),
    ttlMinutes: retencion.vigenciaMinutos,
    lockedPrice: aPrecioCongelado(retencion.precio),
  };
}

/** remainingSeconds: los segundos enteros que le quedan si sigue HELD; si no, 0. */
export function aEstadoRetencion(retencion: Retencion, ahora: Date): EstadoRetencionDto {
  const restantes =
    retencion.estado === 'RETENIDA'
      ? Math.max(0, Math.floor((retencion.vence.getTime() - ahora.getTime()) / 1000))
      : 0;
  return {
    status: ESTADO_RETENCION.aContrato(retencion.estado),
    expiresAt: aInstante(retencion.vence),
    remainingSeconds: restantes,
    lockedPrice: aPrecioCongelado(retencion.precio),
  };
}
