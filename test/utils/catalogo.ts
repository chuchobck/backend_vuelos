import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { crearUsuario, iniciarSesion } from './auth';
import { crearApp, OpcionesCrearApp } from './crear-app';

export const ADMIN = '/flights/v1/admin';

export interface AppCatalogo {
  app: INestApplication;
  prisma: PrismaService;
  /** Petición con el token del administrador. */
  admin: (metodo: Metodo, ruta: string, cuerpo?: object) => request.Test;
  /** Petición con el token de un cliente (sin flights:admin). */
  cliente: (metodo: Metodo, ruta: string, cuerpo?: object) => request.Test;
  /** Petición sin token. */
  anonimo: (metodo: Metodo, ruta: string, cuerpo?: object) => request.Test;
  /** `sub` del administrador, para comprobar la auditoría. */
  idAdmin: string;
  cerrar: () => Promise<void>;
}

type Metodo = 'get' | 'post' | 'patch' | 'delete';

/**
 * La API con un administrador y un cliente de prueba. Las pruebas del catálogo hacen cientos
 * de peticiones: el límite global se sube solo en esta app.
 */
export async function crearAppCatalogo(opciones: OpcionesCrearApp = {}): Promise<AppCatalogo> {
  const limiteAnterior = process.env.RATE_LIMIT_MAX;
  process.env.RATE_LIMIT_MAX = '100000';
  const app = await crearApp([], opciones);
  if (limiteAnterior === undefined) delete process.env.RATE_LIMIT_MAX;
  else process.env.RATE_LIMIT_MAX = limiteAnterior;

  const administrador = await crearUsuario(app, { administrador: true });
  const tokenAdmin = (await iniciarSesion(app, administrador)).access_token;
  const tokenCliente = (await iniciarSesion(app, await crearUsuario(app))).access_token;

  const peticion = (token?: string) => (metodo: Metodo, ruta: string, cuerpo?: object) => {
    let prueba = request(app.getHttpServer())[metodo](ruta);
    if (token) prueba = prueba.set('Authorization', `Bearer ${token}`);
    return cuerpo === undefined ? prueba : prueba.send(cuerpo);
  };

  return {
    app,
    prisma: app.get(PrismaService),
    admin: peticion(tokenAdmin),
    cliente: peticion(tokenCliente),
    anonimo: peticion(),
    idAdmin: administrador.id,
    cerrar: () => app.close(),
  };
}

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALFANUM = `${LETRAS}0123456789`;

function azar(alfabeto: string, largo: number): string {
  let texto = '';
  for (let i = 0; i < largo; i++) texto += alfabeto[Math.floor(Math.random() * alfabeto.length)];
  return texto;
}

/**
 * Un código natural que no exista todavía. Las pruebas no borran (lo que crean queda dado de
 * baja), así que cada corrida necesita códigos nuevos; `./db/reset.sh` los libera.
 */
async function codigoLibre(
  existe: (codigo: string) => Promise<boolean>,
  generar: () => string,
): Promise<string> {
  for (let intento = 0; intento < 200; intento++) {
    const codigo = generar();
    if (!(await existe(codigo))) return codigo;
  }
  throw new Error('No quedan códigos libres: corre ./db/reset.sh');
}

export const codigos = {
  pais: (p: PrismaService) =>
    codigoLibre(
      async (c) => (await p.db.pais.count({ where: { codigo_iso2: c } })) > 0,
      () => azar(LETRAS, 2),
    ),
  paisIso3: (p: PrismaService) =>
    codigoLibre(
      async (c) => (await p.db.pais.count({ where: { codigo_iso3: c } })) > 0,
      () => azar(LETRAS, 3),
    ),
  aeropuerto: (p: PrismaService) =>
    codigoLibre(
      async (c) => (await p.db.aeropuerto.count({ where: { codigo_iata: c } })) > 0,
      () => azar(LETRAS, 3),
    ),
  aerolinea: (p: PrismaService) =>
    codigoLibre(
      async (c) => (await p.db.aerolinea.count({ where: { codigo_iata: c } })) > 0,
      () => azar(ALFANUM, 2),
    ),
  prefijoBoleto: (p: PrismaService) =>
    codigoLibre(
      async (c) => (await p.db.aerolinea.count({ where: { prefijo_boleto: c } })) > 0,
      () => azar('0123456789', 3),
    ),
  modelo: (p: PrismaService) =>
    codigoLibre(
      async (c) => (await p.db.modelo_aeronave.count({ where: { codigo_iata: c } })) > 0,
      () => azar(ALFANUM, 3),
    ),
};

/** Un sufijo para nombres que deben ser únicos (ciudad por país, mapa por aerolínea y modelo). */
export const sufijo = () => azar(LETRAS, 6);

/** Un instante dentro de `dias` días, a la hora UTC indicada, en ISO 8601 con Z. */
export function enDias(dias: number, hora: number, minuto = 0): string {
  const fecha = new Date();
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  fecha.setUTCHours(hora, minuto, 0, 0);
  return fecha.toISOString();
}
