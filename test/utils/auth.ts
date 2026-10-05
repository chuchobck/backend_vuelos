import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../../src/modules/auth/auth.service';
import { EMISOR_POR_DEFECTO } from '../../src/modules/auth/seguridad/token-acceso.service';
import { TokenRespuestaDto } from '../../src/modules/auth/dto/token-respuesta.dto';
import { PrismaService } from '../../src/prisma/prisma.service';

/** Dominio reservado (RFC 2606) de las cuentas que crean las pruebas. */
export const DOMINIO_PRUEBAS = 'e2e.quinde.example';

export const CONTRASENA_PRUEBA = 'una frase de prueba bastante larga';

export interface UsuarioDePrueba {
  id: string;
  correo: string;
  contrasena: string;
}

export function correoDePrueba(): string {
  return `e2e-${randomUUID()}@${DOMINIO_PRUEBAS}`;
}

/**
 * Crea una cuenta con el service, sin pasar por HTTP: así la preparación de una prueba no
 * gasta el límite de peticiones de /auth/register. Con `administrador` le suma ese rol.
 */
export async function crearUsuario(
  app: INestApplication,
  opciones: { administrador?: boolean } = {},
): Promise<UsuarioDePrueba> {
  const correo = correoDePrueba();
  const usuario = await app
    .get(AuthService)
    .registrar({ email: correo, password: CONTRASENA_PRUEBA });
  if (opciones.administrador) {
    const prisma = app.get(PrismaService);
    await prisma.transaccionAuditada(async (tx) => {
      const rol = await tx.rol.findUniqueOrThrow({ where: { codigo: 'administrador' } });
      await tx.usuario_rol.create({ data: { usuario_id: usuario.id, rol_id: rol.id } });
    });
  }
  return { id: usuario.id, correo, contrasena: CONTRASENA_PRUEBA };
}

/** Login con el service (sin el límite de /auth/login). */
export function iniciarSesion(
  app: INestApplication,
  usuario: UsuarioDePrueba,
): Promise<TokenRespuestaDto> {
  return app
    .get(AuthService)
    .iniciarSesion({ email: usuario.correo, password: usuario.contrasena });
}

export function desactivar(app: INestApplication, usuario: UsuarioDePrueba): Promise<unknown> {
  return app
    .get(PrismaService)
    .transaccionAuditada((tx) =>
      tx.usuario.update({ where: { id: usuario.id }, data: { activo: false } }),
    );
}

/**
 * Las pruebas no pueden borrar sus cuentas (el borrado físico está prohibido): al terminar
 * las desactivan, y `./db/reset.sh` las elimina con todo lo demás.
 */
export function desactivarUsuariosDePrueba(app: INestApplication): Promise<unknown> {
  return app.get(PrismaService).transaccionAuditada((tx) =>
    tx.usuario.updateMany({
      where: { correo: { endsWith: `@${DOMINIO_PRUEBAS}` }, activo: true },
      data: { activo: false },
    }),
  );
}

/** Firma un JWT a mano, con la clave de la API salvo que se indique otra. */
export function firmarToken(
  app: INestApplication,
  claims: Record<string, unknown>,
  opciones: jwt.SignOptions & { clave?: string } = {},
): string {
  const config = app.get(ConfigService);
  const { clave = config.getOrThrow<string>('JWT_SECRET'), ...firma } = opciones;
  return jwt.sign(claims, clave, {
    algorithm: 'HS256',
    issuer: config.get<string>('JWT_ISSUER') || EMISOR_POR_DEFECTO,
    audience: config.get<string>('JWT_AUDIENCE') || EMISOR_POR_DEFECTO,
    jwtid: randomUUID(),
    ...firma,
  });
}
