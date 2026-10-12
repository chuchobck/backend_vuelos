import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ROL_ADMINISTRADOR } from '../scopes';

export interface FilaAdministrador {
  id: string;
  correo: string;
  activo: boolean;
  fechaCreacion: Date;
}

/** Por qué no se pudo dar de baja a un administrador. */
export type ResultadoBaja =
  'dado-de-baja' | 'ya-estaba-de-baja' | 'no-existe' | 'es-el-mismo' | 'es-el-ultimo';

const ES_ADMINISTRADOR: Prisma.usuarioWhereInput = {
  usuario_rol: { some: { activo: true, rol: { codigo: ROL_ADMINISTRADOR, activo: true } } },
};

const SELECCION = { id: true, correo: true, activo: true, fecha_creacion: true } as const;

/**
 * Administradores = usuarios con el rol `administrador` asignado y vigente. Las escrituras van
 * por transaccionAuditada: el actor es el administrador que hace la petición. El alta usa
 * AuthRepository.crearUsuario (no se duplica); aquí solo la lista y la baja.
 */
@Injectable()
export class AdministradoresRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** `limite + 1` filas (más reciente primero, con el id como desempate) para saber si hay más. */
  async listar(filtros: {
    incluirInactivos: boolean;
    despuesDe?: { creada: Date; id: string };
    limite: number;
  }): Promise<FilaAdministrador[]> {
    const y: Prisma.usuarioWhereInput[] = [ES_ADMINISTRADOR];
    if (!filtros.incluirInactivos) y.push({ activo: true });
    if (filtros.despuesDe) {
      const { creada, id } = filtros.despuesDe;
      y.push({
        OR: [{ fecha_creacion: { lt: creada } }, { fecha_creacion: creada, id: { lt: id } }],
      });
    }
    const filas = await this.prisma.db.usuario.findMany({
      where: { AND: y },
      orderBy: [{ fecha_creacion: 'desc' }, { id: 'desc' }],
      take: filtros.limite + 1,
      select: SELECCION,
    });
    return filas.map(aFila);
  }

  /**
   * Da de baja a un administrador (usuario.activo = false) y revoca sus tokens de refresco,
   * en una sola transacción. Antes bloquea las filas de los administradores activos, en orden
   * de id: dos bajas simultáneas se esperan en vez de dejar al sistema sin administradores.
   */
  baja(id: string, idSolicitante: string): Promise<ResultadoBaja> {
    return this.prisma.transaccionAuditada(async (tx) => {
      const activos = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT u.id
          FROM vuelos.usuario u
          JOIN vuelos.usuario_rol ur ON ur.usuario_id = u.id AND ur.activo
          JOIN vuelos.rol r          ON r.id = ur.rol_id AND r.activo
         WHERE r.codigo = ${ROL_ADMINISTRADOR} AND u.activo
         ORDER BY u.id
           FOR UPDATE OF u`;

      const objetivo = await tx.usuario.findFirst({
        where: { AND: [{ id }, ES_ADMINISTRADOR] },
        select: { id: true, activo: true },
      });
      if (!objetivo) return 'no-existe';

      const ahora = new Date();
      const revocar = () =>
        tx.token_refresco.updateMany({
          where: { usuario_id: id, fecha_revocacion: null },
          data: { fecha_revocacion: ahora, motivo_revocacion: 'USUARIO_INACTIVO' },
        });
      // Repetir la baja no cambia nada (salvo revocar lo que haya quedado vigente)
      if (!objetivo.activo) {
        await revocar();
        return 'ya-estaba-de-baja';
      }
      if (id === idSolicitante) return 'es-el-mismo';
      if (activos.filter((a) => a.id !== id).length === 0) return 'es-el-ultimo';

      await tx.usuario.update({ where: { id }, data: { activo: false } });
      await revocar();
      return 'dado-de-baja';
    });
  }
}

function aFila(fila: {
  id: string;
  correo: string;
  activo: boolean;
  fecha_creacion: Date;
}): FilaAdministrador {
  return {
    id: fila.id,
    correo: fila.correo,
    activo: fila.activo,
    fechaCreacion: fila.fecha_creacion,
  };
}
