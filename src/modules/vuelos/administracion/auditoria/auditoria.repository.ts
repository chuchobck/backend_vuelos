import { Injectable } from '@nestjs/common';
import { operacion_auditoria, Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';

export interface FiltrosAuditoria {
  tabla?: string;
  operacion?: operacion_auditoria;
  idRegistro?: string;
  idUsuario?: string;
  desde?: Date;
  /** Exclusivo: el día siguiente al `to` pedido. */
  hasta?: Date;
  despuesDe?: { fecha: Date; id: bigint };
  limite: number;
}

/** Un evento de la tabla auditoria tal como está (sin censurar: eso lo hace el service). */
export interface FilaAuditoria {
  id: bigint;
  fecha: Date;
  tabla: string;
  operacion: operacion_auditoria;
  idRegistro: string;
  idUsuario: string | null;
  direccionIp: string | null;
  anteriores: Prisma.JsonValue | null;
  nuevos: Prisma.JsonValue | null;
}

/**
 * Lectura de `auditoria` (es de solo inserción: este repository nunca la escribe). Orden
 * estable de más reciente a más viejo, por fecha del evento y id. Los filtros por tabla y
 * registro usan ix_auditoria_registro; el de usuario, ix_auditoria_usuario; el de fechas,
 * ix_auditoria_fecha_evento.
 */
@Injectable()
export class AuditoriaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** `limite + 1` filas, para saber si hay otra página. */
  async listar(filtros: FiltrosAuditoria): Promise<FilaAuditoria[]> {
    const y: Prisma.auditoriaWhereInput[] = [];
    if (filtros.tabla) y.push({ nombre_tabla: filtros.tabla });
    if (filtros.operacion) y.push({ operacion: filtros.operacion });
    if (filtros.idRegistro) y.push({ id_registro: filtros.idRegistro });
    if (filtros.idUsuario) y.push({ id_usuario: filtros.idUsuario });
    if (filtros.desde) y.push({ fecha_evento: { gte: filtros.desde } });
    if (filtros.hasta) y.push({ fecha_evento: { lt: filtros.hasta } });
    if (filtros.despuesDe) {
      const { fecha, id } = filtros.despuesDe;
      y.push({ OR: [{ fecha_evento: { lt: fecha } }, { fecha_evento: fecha, id: { lt: id } }] });
    }
    const filas = await this.prisma.db.auditoria.findMany({
      where: { AND: y },
      orderBy: [{ fecha_evento: 'desc' }, { id: 'desc' }],
      take: filtros.limite + 1,
      select: {
        id: true,
        fecha_evento: true,
        nombre_tabla: true,
        operacion: true,
        id_registro: true,
        id_usuario: true,
        direccion_ip: true,
        datos_anteriores: true,
        datos_nuevos: true,
      },
    });
    return filas.map((f) => ({
      id: f.id,
      fecha: f.fecha_evento,
      tabla: f.nombre_tabla,
      operacion: f.operacion,
      idRegistro: f.id_registro,
      idUsuario: f.id_usuario,
      direccionIp: f.direccion_ip,
      anteriores: f.datos_anteriores,
      nuevos: f.datos_nuevos,
    }));
  }
}
