import { Injectable } from '@nestjs/common';
import { motivo_revocacion } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Usuario con sus roles vigentes (asignación activa y rol activo). */
export interface UsuarioConRoles {
  id: string;
  correo: string;
  hashContrasena: string;
  activo: boolean;
  fechaCreacion: Date;
  roles: string[];
}

export interface TokenRefrescoGuardado {
  id: string;
  idFamilia: string;
  fechaExpiracion: Date;
  revocado: boolean;
  reemplazado: boolean;
  usuario: UsuarioConRoles;
}

export interface NuevoTokenRefresco {
  usuarioId: string;
  idFamilia: string;
  hash: string;
  fechaExpiracion: Date;
}

const CON_ROLES = {
  usuario_rol: {
    where: { activo: true, rol: { activo: true } },
    select: { rol: { select: { codigo: true } } },
  },
} as const;

type FilaUsuario = {
  id: string;
  correo: string;
  hash_contrasena: string;
  activo: boolean;
  fecha_creacion: Date;
  usuario_rol: Array<{ rol: { codigo: string } }>;
};

/** Único punto del módulo que usa Prisma. Las escrituras van por transaccionAuditada. */
@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crea el usuario y le asigna `codigoRol` en la misma transacción. Un correo repetido
   * falla por uq_usuario_correo y el filtro de errores lo responde como 409.
   */
  async crearUsuario(
    id: string,
    correo: string,
    hashContrasena: string,
    codigoRol: string,
  ): Promise<UsuarioConRoles> {
    const fila = await this.prisma.transaccionAuditada(async (tx) => {
      const rol = await tx.rol.findFirst({ where: { codigo: codigoRol, activo: true } });
      if (!rol) {
        // Error de configuración: no llega al cliente (500) y queda en el log.
        throw new Error(`Falta el rol "${codigoRol}": carga db/semilla_seguridad.sql`);
      }
      return tx.usuario.create({
        data: {
          id,
          correo,
          hash_contrasena: hashContrasena,
          usuario_rol: { create: { rol_id: rol.id } },
        },
        include: CON_ROLES,
      });
    });
    return aUsuario(fila);
  }

  async buscarPorCorreo(correo: string): Promise<UsuarioConRoles | null> {
    const fila = await this.prisma.db.usuario.findUnique({ where: { correo }, include: CON_ROLES });
    return fila ? aUsuario(fila) : null;
  }

  async buscarPorId(id: string): Promise<UsuarioConRoles | null> {
    const fila = await this.prisma.db.usuario.findUnique({ where: { id }, include: CON_ROLES });
    return fila ? aUsuario(fila) : null;
  }

  async actualizarHashContrasena(id: string, hashContrasena: string): Promise<void> {
    await this.prisma.transaccionAuditada((tx) =>
      tx.usuario.update({ where: { id }, data: { hash_contrasena: hashContrasena } }),
    );
  }

  async crearTokenRefresco(token: NuevoTokenRefresco): Promise<void> {
    await this.prisma.transaccionAuditada((tx) =>
      tx.token_refresco.create({ data: aFilaToken(token) }),
    );
  }

  async buscarTokenRefresco(hash: string): Promise<TokenRefrescoGuardado | null> {
    const fila = await this.prisma.db.token_refresco.findUnique({
      where: { hash_token: hash },
      include: { usuario: { include: CON_ROLES } },
    });
    if (!fila) return null;
    return {
      id: fila.id,
      idFamilia: fila.id_familia,
      fechaExpiracion: fila.fecha_expiracion,
      revocado: fila.fecha_revocacion !== null,
      reemplazado: fila.reemplazado_por_id !== null,
      usuario: aUsuario(fila.usuario),
    };
  }

  /**
   * Rota: crea el token nuevo y marca el anterior como reemplazado, solo si nadie lo usó
   * antes. Devuelve false si otro refresh ganó la carrera; en ese caso la transacción se
   * revierte y el token nuevo no queda.
   */
  async rotarTokenRefresco(anteriorId: string, nuevo: NuevoTokenRefresco): Promise<boolean> {
    try {
      await this.prisma.transaccionAuditada(async (tx) => {
        const creado = await tx.token_refresco.create({ data: aFilaToken(nuevo) });
        const { count } = await tx.token_refresco.updateMany({
          where: { id: anteriorId, reemplazado_por_id: null, fecha_revocacion: null },
          data: { reemplazado_por_id: creado.id },
        });
        if (count === 0) throw new CarreraDeRotacion();
      });
      return true;
    } catch (error) {
      if (error instanceof CarreraDeRotacion) return false;
      throw error;
    }
  }

  /** Revoca los tokens aún vigentes de la familia. Devuelve cuántos revocó. */
  async revocarFamilia(idFamilia: string, motivo: motivo_revocacion): Promise<number> {
    const { count } = await this.prisma.transaccionAuditada((tx) =>
      tx.token_refresco.updateMany({
        where: { id_familia: idFamilia, fecha_revocacion: null },
        data: { fecha_revocacion: new Date(), motivo_revocacion: motivo },
      }),
    );
    return count;
  }
}

class CarreraDeRotacion extends Error {}

function aUsuario(fila: FilaUsuario): UsuarioConRoles {
  return {
    id: fila.id,
    correo: fila.correo,
    hashContrasena: fila.hash_contrasena,
    activo: fila.activo,
    fechaCreacion: fila.fecha_creacion,
    roles: fila.usuario_rol.map(({ rol }) => rol.codigo),
  };
}

function aFilaToken(token: NuevoTokenRefresco) {
  return {
    usuario_id: token.usuarioId,
    id_familia: token.idFamilia,
    hash_token: token.hash,
    fecha_expiracion: token.fechaExpiracion,
  };
}
