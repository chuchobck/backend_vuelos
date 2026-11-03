import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { clase_cabina, Prisma } from '../../../generated/prisma/client';
import { correlacionActual } from '../../../common/contexto/correlation-id';
import { Reloj } from '../../../common/reloj';
import { stockBookingActivo } from '../../../config/stock-booking';
import { TransaccionVuelos } from '../../../prisma/prisma.service';

/** Una clave del empuje a Booking: la cabina de una salida. */
export interface ClaveStock {
  salidaId: string;
  cabina: clase_cabina;
}

/** Con qué se ejecuta la orden: una transacción en curso, o el cliente normal (la sincronización). */
export type EjecutorOrdenes = Pick<TransaccionVuelos, '$executeRaw'>;

/**
 * Deja una orden de empuje por cada fila de `origen` (columnas `salida_id uuid`, `cabina text`).
 * Es un upsert: si la clave ya tenía una orden, la junta (coalesce) en ella, la vuelve PENDIENTE
 * y sube su `version`, de modo que el trabajador no dé por mandado un valor que ya cambió. No toca
 * el arrendamiento: si hay un envío en curso de esa clave, termina primero y la orden nueva va después.
 *
 * Las claves entran ordenadas (salida, cabina): dos transacciones que registran las mismas claves
 * toman las filas en el mismo orden y no se cruzan.
 */
export async function registrarOrdenes(
  ejecutor: EjecutorOrdenes,
  origen: Prisma.Sql,
  ahora: Date,
  correlacion: string | null,
): Promise<number> {
  return ejecutor.$executeRaw`
    INSERT INTO vuelos.orden_stock_booking AS o
           (vuelo_programado_id, clase_cabina, estado, version, intentos, proximo_intento,
            correlation_id, solicitado_en)
    SELECT p.salida_id, p.cabina::vuelos.clase_cabina, 'PENDIENTE', 1, 0, ${ahora}::timestamptz,
           ${correlacion}::text, ${ahora}::timestamptz
      FROM (${origen}) p
     ORDER BY p.salida_id, p.cabina
    ON CONFLICT (vuelo_programado_id, clase_cabina) DO UPDATE
       SET estado = 'PENDIENTE',
           version = o.version + 1,
           intentos = 0,
           proximo_intento = EXCLUDED.proximo_intento,
           correlation_id = EXCLUDED.correlation_id,
           solicitado_en = EXCLUDED.solicitado_en,
           ultimo_codigo_http = NULL,
           ultimo_error = NULL,
           enviado_en = NULL`;
}

/**
 * Lo que usa quien mueve el cupo (inventario_cabina) para que Booking se entere: registra, en la
 * MISMA transacción del cambio, la orden de empuje de cada cabina tocada. No manda nada ni espera a
 * Booking: StockBookingWorker lo hace después de confirmar, leyendo el cupo actual.
 *
 * Con BOOKING_STOCK_ENABLED=false no hace nada (ni escribe, ni consulta), así que apagado cuesta cero.
 * Toda operación que cambie `inventario_cabina`, o haga una salida vendible o no, llama aquí.
 */
@Injectable()
export class OrdenesStock {
  readonly activo: boolean;

  constructor(
    config: ConfigService,
    private readonly reloj: Reloj,
  ) {
    this.activo = stockBookingActivo(config);
  }

  /** Las cabinas que se tocaron, ya conocidas (un hold, un cambio de fecha, un ajuste del catálogo). */
  async registrar(tx: EjecutorOrdenes, claves: readonly ClaveStock[]): Promise<void> {
    if (!this.activo || claves.length === 0) return;
    await this.guardar(
      tx,
      Prisma.sql`SELECT DISTINCT * FROM unnest(${claves.map((c) => c.salidaId)}::uuid[],
                                              ${claves.map((c) => c.cabina)}::text[])
                   AS c(salida_id, cabina)`,
    );
  }

  /** Todas las cabinas de una salida (se cancela, se reactiva, cambia de horario). */
  async registrarSalida(tx: EjecutorOrdenes, salidaId: string): Promise<void> {
    if (!this.activo) return;
    await this.guardar(
      tx,
      Prisma.sql`SELECT ic.vuelo_programado_id AS salida_id, ic.clase_cabina::text AS cabina
                   FROM vuelos.inventario_cabina ic
                  WHERE ic.vuelo_programado_id = ${salidaId}::uuid`,
    );
  }

  /** Las cabinas de las salidas de una retención (se devolvió su cupo: se liberó o venció). */
  async registrarRetencion(tx: EjecutorOrdenes, retencionId: string): Promise<void> {
    if (!this.activo) return;
    await this.guardar(
      tx,
      Prisma.sql`SELECT DISTINCT i.vuelo_programado_id AS salida_id, f.clase_cabina::text AS cabina
                   FROM vuelos.retencion_detalle d
                   JOIN vuelos.itinerario_detalle i ON i.itinerario_id = d.itinerario_id
                   JOIN vuelos.familia_tarifa f     ON f.id = d.familia_tarifa_id
                  WHERE d.retencion_id = ${retencionId}::uuid`,
    );
  }

  /** Las cabinas de las salidas vigentes de una reserva (se devolvió su cupo). */
  async registrarReserva(tx: EjecutorOrdenes, reservaId: string): Promise<void> {
    if (!this.activo) return;
    await this.guardar(
      tx,
      Prisma.sql`SELECT DISTINCT i.vuelo_programado_id AS salida_id, f.clase_cabina::text AS cabina
                   FROM vuelos.reserva_detalle_itinerario r
                   JOIN vuelos.itinerario_detalle i ON i.itinerario_id = r.itinerario_id
                   JOIN vuelos.familia_tarifa f     ON f.id = r.familia_tarifa_id
                  WHERE r.reserva_id = ${reservaId}::uuid AND r.vigente`,
    );
  }

  private async guardar(tx: EjecutorOrdenes, origen: Prisma.Sql): Promise<void> {
    await registrarOrdenes(tx, origen, this.reloj.ahora(), correlacionActual() ?? null);
  }
}
