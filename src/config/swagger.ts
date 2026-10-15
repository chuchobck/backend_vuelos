import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ESQUEMA_BEARER, ESQUEMA_OAUTH2 } from '../common/decorators/documentacion.decorator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuracionExterna, modoAuth } from './autenticacion';

export const RUTA_SWAGGER = 'api/docs';
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
 * del servicio de identidad.
 */
export function configurarSwagger(app: INestApplication): void {
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

  const documento = SwaggerModule.createDocument(app, constructor.build());
  SwaggerModule.setup(RUTA_SWAGGER, app, documento, {
    customSiteTitle: TITULO,
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
