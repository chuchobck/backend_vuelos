import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';

/** Las consultas de GET /api/v2/vuelos/health: una ida y vuelta mínima y dos conteos. */
@Injectable()
export class SaludV2Repository {
  constructor(private readonly prisma: PrismaService) {}

  /** Lanza si no hay conexión. */
  async consultarBase(): Promise<void> {
    await this.prisma.db.$queryRaw`SELECT 1`;
  }

  /** Holds que siguen reteniendo cupo a esa hora (RETENIDA y sin vencer). */
  async holdsActivos(ahora: Date): Promise<number> {
    const [fila] = await this.prisma.db.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total
        FROM vuelos.retencion_cabecera
       WHERE estado = 'RETENIDA' AND fecha_expiracion > ${ahora}::timestamptz`;
    return fila.total;
  }

  /**
   * Salidas no canceladas cuya fecha local de salida es hoy en Ecuador continental: la fecha de
   * `ahora` en America/Guayaquil, como la de `fecha_salida`.
   */
  async vuelosDeHoy(ahora: Date): Promise<number> {
    const [fila] = await this.prisma.db.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total
        FROM vuelos.vuelo_programado
       WHERE fecha_salida = (${ahora}::timestamptz AT TIME ZONE 'America/Guayaquil')::date
         AND estado::text <> 'CANCELADO'`;
    return fila.total;
  }
}
