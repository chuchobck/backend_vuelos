import { Injectable } from '@nestjs/common';
import { clase_cabina } from '../../../generated/prisma/client';
import { TransaccionVuelos } from '../../../prisma/prisma.service';

/** Cuánto cambia el cupo de una cabina de una salida: negativo toma, positivo devuelve. */
export interface MovimientoDeCupo {
  salidaId: string;
  cabina: clase_cabina;
  delta: number;
}

/**
 * El cupo (inventario_cabina) de varias cabinas a la vez, en una sola sentencia: bloquea las
 * filas en orden (salida, cabina), el mismo de los holds y las reservas, y aplica cada delta
 * solo si el cupo no queda negativo (devolver nunca pasa del total). Lo usa el cambio de fecha,
 * que toma el cupo de los vuelos nuevos y devuelve el de los viejos en el mismo paso.
 */
@Injectable()
export class InventarioRepository {
  /**
   * Devuelve si se aplicaron todos. Si no (a una cabina no le alcanzó), quien llama debe
   * deshacer la transacción: lo que sí se aplicó no puede quedar.
   */
  async mover(tx: TransaccionVuelos, movimientos: MovimientoDeCupo[]): Promise<boolean> {
    const porFila = new Map<string, MovimientoDeCupo>();
    for (const m of movimientos) {
      const llave = `${m.salidaId}|${m.cabina}`;
      const previo = porFila.get(llave);
      porFila.set(llave, { ...m, delta: (previo?.delta ?? 0) + m.delta });
    }
    const filas = [...porFila.values()].filter((m) => m.delta !== 0);
    if (filas.length === 0) return true;
    const cambiadas = await tx.$executeRaw`
      WITH pedido AS (
        SELECT * FROM unnest(${filas.map((f) => f.salidaId)}::uuid[],
                             ${filas.map((f) => f.cabina)}::text[],
                             ${filas.map((f) => f.delta)}::int[]) AS p(salida_id, clase_cabina, delta)
      ), bloqueadas AS MATERIALIZED (
        SELECT ic.id, p.delta
          FROM vuelos.inventario_cabina ic
          JOIN pedido p ON p.salida_id = ic.vuelo_programado_id
                       AND p.clase_cabina = ic.clase_cabina::text
         ORDER BY ic.vuelo_programado_id, ic.clase_cabina
           FOR UPDATE OF ic
      )
      UPDATE vuelos.inventario_cabina ic
         SET cupos_disponibles = LEAST(ic.cupos_totales, ic.cupos_disponibles + b.delta)
        FROM bloqueadas b
       WHERE ic.id = b.id
         AND ic.cupos_disponibles + b.delta >= 0`;
    return cambiadas === filas.length;
  }
}
