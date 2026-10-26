import { INestApplication, Logger, Type } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ESQUEMA_BEARER, ESQUEMA_OAUTH2 } from '../common/decorators/documentacion.decorator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuracionExterna, modoAuth } from './autenticacion';

export const RUTA_SWAGGER = 'api/docs';
/** Swagger de la fachada del contrato v2, aparte del de v1. */
export const RUTA_SWAGGER_V2 = 'api/v2/docs';
/** Versión de la API (la de package.json); el contrato que implementa es el 1.5.0.0. */
export const VERSION_API = '1.1.0';
const VERSION_CONTRATO = '1.5.0.0';
const TITULO = 'Quinde · API de Vuelos';

/** Etiquetas de Swagger: las 7 del contrato, en su orden, y las propias del proyecto. */
export const ETIQUETAS = {
  busqueda: 'Búsqueda y Catálogo',
  retencion: 'Bloqueo de Cupos (Hold)',
  reservas: 'Reservas y Emisión',
  postventa: 'Postventa (Maletas, Fechas y Cancelaciones)',
  checkin: 'Check-in y Boarding Pass',
  estadoVuelos: 'Estado de Vuelos',
  webhooks: 'Webhooks',
  salud: 'Salud',
  auth: 'Auth',
  adminPais: 'Admin · País',
  adminCiudad: 'Admin · Ciudad',
  adminAeropuerto: 'Admin · Aeropuerto',
  adminAerolinea: 'Admin · Aerolínea',
  adminModeloAeronave: 'Admin · Modelo de aeronave',
  adminFamiliaTarifa: 'Admin · Familia tarifaria',
  adminMapaAsientos: 'Admin · Mapa de asientos',
  adminVuelo: 'Admin · Vuelo',
  adminVueloProgramado: 'Admin · Vuelo programado',
  adminTarifa: 'Admin · Tarifa',
  adminAuditoria: 'Admin · Auditoría',
  adminUsuarios: 'Admin · Administradores',
  adminReservas: 'Admin · Reservas',
} as const;

/** Descripción común de las etiquetas del catálogo: no son parte del contrato. */
const DESCRIPCION_ADMIN =
  'Fuera del contrato: administración (scope flights:admin). DELETE da de baja (activo = false), no borra.';

const DESCRIPCIONES_PROPIAS: Partial<Record<keyof typeof ETIQUETAS, string>> = {
  salud: 'Fuera del contrato: chequeo de vida para Render',
  auth: 'Fuera del contrato: proveedor de identidad simulado (RDA1) que emite los JWT',
};

/**
 * Scopes del esquema OAuth2Security del contrato, con sus descripciones, más `flights:admin`
 * (propio del proyecto, para /admin).
 */
const SCOPES_OAUTH2 = {
  'flights:read': 'Leer reservas',
  'flights:hold': 'Bloquear inventario',
  'flights:book': 'Comprar y alterar reserva',
  'flights:cancel': 'Cancelar reservas',
  'flights:webhooks': 'Gestionar webhooks',
  'flights:admin':
    'Administrar catálogo, auditoría, administradores y reservas (propio del proyecto, no está en el contrato)',
};

/** Etiquetas de las rutas que solo se montan con AUTH_MODE=local (src/app.module.ts). */
const ETIQUETAS_SOLO_LOCAL: ReadonlySet<keyof typeof ETIQUETAS> = new Set([
  'auth',
  'adminUsuarios',
]);

/**
 * Swagger UI en /api/docs y el OpenAPI en JSON en /api/docs-json. Refleja AUTH_MODE: con
 * external no están /auth ni /admin/users (ni sus etiquetas), y el esquema bearer pide un token
 * del servicio de identidad. Es el documento de v1: `excluir` deja fuera los módulos de otro
 * documento (la fachada v2, en /api/v2/docs).
 */
export function configurarSwagger(app: INestApplication, excluir: Type[] = []): void {
  const config = app.get(ConfigService);
  const externo = modoAuth(config) === 'external';
  const constructor = new DocumentBuilder()
    .setTitle(TITULO)
    .setDescription(
      `Implementación del contrato GDS Flight Core API v${VERSION_CONTRATO} para vuelos nacionales de Ecuador.`,
    )
    .setVersion(VERSION_API)
    // El que funciona en el botón Authorize: el access_token de POST /flights/v1/auth/login o,
    // con AUTH_MODE=external, uno del servicio de identidad
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: externo
          ? `Pega un access_token del servicio de identidad (${configuracionExterna(config).emisor}): ` +
            'el de su login, o el de /oauth2/token para un cliente máquina a máquina'
          : 'Pega el access_token de POST /flights/v1/auth/login (vence en 15 minutos)',
      },
      ESQUEMA_BEARER,
    )
    // El del contrato, copiado tal cual (mismo nombre, flujos y tokenUrl) para que cada
    // operación declare sus scopes como en contracts/vuelos-openapi.yaml. Apunta al
    // proveedor de identidad externo, que en RDA1 no existe: aquí no sirve para autorizar.
    .addOAuth2(
      {
        type: 'oauth2',
        description:
          'Esquema del contrato (proveedor de identidad externo, no disponible en RDA1). ' +
          'Muestra los scopes de cada operación; para probar la API usa "bearer".',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://auth.booking-hub.com/oauth2/authorize',
            tokenUrl: 'https://auth.booking-hub.com/oauth2/token',
            scopes: SCOPES_OAUTH2,
          },
          clientCredentials: {
            tokenUrl: 'https://auth.booking-hub.com/oauth2/token',
            scopes: SCOPES_OAUTH2,
          },
        },
      },
      ESQUEMA_OAUTH2,
    );

  // Render define RENDER_EXTERNAL_URL (https://<servicio>.onrender.com): el documento publicado
  // apunta al dominio de producción. En local no existe y Swagger UI usa el origen de la página.
  const urlExterna = process.env.RENDER_EXTERNAL_URL;
  if (urlExterna) constructor.addServer(urlExterna.replace(/\/$/, ''), 'Este despliegue');

  for (const [clave, nombre] of Object.entries(ETIQUETAS)) {
    if (externo && ETIQUETAS_SOLO_LOCAL.has(clave as keyof typeof ETIQUETAS)) continue;
    const descripcion = clave.startsWith('admin')
      ? DESCRIPCION_ADMIN
      : DESCRIPCIONES_PROPIAS[clave as keyof typeof ETIQUETAS];
    constructor.addTag(nombre, descripcion);
  }

  const documento = SwaggerModule.createDocument(app, constructor.build(), {
    include: modulosSalvo(app, excluir),
  });
  SwaggerModule.setup(RUTA_SWAGGER, app, documento, {
    customSiteTitle: TITULO,
    customfavIcon: iconoComoDataUri(),
    swaggerOptions: { persistAuthorization: true },
  });
}

/** Todos los módulos de la app menos esos (el `include` de un documento de Swagger). */
function modulosSalvo(app: INestApplication, excluir: Type[]): Type[] {
  return [...app.get(ModulesContainer).values()]
    .map((modulo) => modulo.metatype as Type)
    .filter((metatype) => !excluir.includes(metatype));
}

/**
 * Swagger de la fachada del contrato v2 (contracts/vuelos-openapi-v2.yaml) en /api/v2/docs, con
 * el JSON en /api/v2/docs-json: solo las rutas de /api/v2/vuelos.
 */
export function configurarSwaggerV2(app: INestApplication, modulo: Type): void {
  const config = app.get(ConfigService);
  const externo = modoAuth(config) === 'external';
  const constructor = new DocumentBuilder()
    .setTitle(`${TITULO} · Contrato v2`)
    .setDescription(
      'Fachada del contrato de Vuelos v2 (RDA2) para Booking Prototipo, sobre los mismos services ' +
        'que /flights/v1. Booking entra con un token de partner (client_credentials de identity, ' +
        'claim client_id) y manda el usuario final en X-User-Id. Diferencias con v1: ' +
        'docs/V2-DIFERENCIAS.md.',
    )
    .setVersion('2.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: externo
          ? `Un access_token de ${configuracionExterna(config).emisor}: el de /oauth2/token para el ` +
            'partner (client_credentials) o el de un login'
          : 'Con AUTH_MODE=local no hay partners: el access_token de POST /flights/v1/auth/login',
      },
      ESQUEMA_BEARER,
    )
    .addOAuth2(
      {
        type: 'oauth2',
        description: 'PartnerOAuth2 del contrato v2: el token de servicio que emite identity',
        flows: {
          clientCredentials: {
            tokenUrl: externo
              ? `${configuracionExterna(config).emisor}/oauth2/token`
              : 'https://identity.quinde.example/oauth2/token',
            scopes: SCOPES_OAUTH2,
          },
        },
      },
      ESQUEMA_OAUTH2,
    );
  const urlExterna = process.env.RENDER_EXTERNAL_URL;
  if (urlExterna) constructor.addServer(urlExterna.replace(/\/$/, ''), 'Este despliegue');

  const documento = SwaggerModule.createDocument(app, constructor.build(), { include: [modulo] });
  SwaggerModule.setup(RUTA_SWAGGER_V2, app, documento, {
    customSiteTitle: `${TITULO} · v2`,
    customfavIcon: iconoComoDataUri(),
    swaggerOptions: { persistAuthorization: true },
  });
}

/** docs/logo-icono.svg incrustado como data URI, para no servir archivos estáticos. */
function iconoComoDataUri(): string | undefined {
  try {
    const svg = readFileSync(join(process.cwd(), 'docs', 'logo-icono.svg'));
    return `data:image/svg+xml;base64,${svg.toString('base64')}`;
  } catch {
    new Logger('Swagger').warn('No se encontró docs/logo-icono.svg; Swagger queda sin ícono');
    return undefined;
  }
}
