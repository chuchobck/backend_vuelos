import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CODIGO_SIN_EQUIVALENTE } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { Reloj } from '../../../../common/reloj';
import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { exigirConfirmada, exigirSinDespegar } from '../reserva/reglas-postventa';
import { ReservaService } from '../reserva/reserva.service';
import { Cotizacion } from './cancelacion.modelo';
import { CancelacionRepository, LineaReembolsable } from './cancelacion.repository';

/** Reglas de la cancelación. */
export const REGLAS_CANCELACION = {
  /** Vigencia de una cotización si CANCELLATION_QUOTE_TTL_MINUTES no dice otra cosa. */
  vigenciaCotizacionPorDefectoMinutos: 15,
};

const MINUTO = 60_000;
const CIEN = new Prisma.Decimal(100);

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
   */
  async cotizar(reservaId: string, idPropietario: string): Promise<Cotizacion> {
    const ahora = this.reloj.ahora();
    const reserva = await this.reservas.detalle(reservaId, idPropietario);
    exigirConfirmada(reserva, 'a cancellation');
    exigirSinDespegar(reserva.itinerarios, ahora);
    if ((await this.repositorio.pagosPendientes(reserva.id)) > 0) {
      throw new ErrorNegocio(
        409,
        CODIGO_SIN_EQUIVALENTE,
        `Booking ${reserva.id} has a payment pending in the Payment API; cancel when it is resolved`,
      );
    }

    const { reembolso, penalidad } = calcularReembolso(
      await this.repositorio.lineas(reserva.id),
      reserva.total.total,
    );
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
