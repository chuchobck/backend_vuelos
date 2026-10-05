import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RUTA_SWAGGER = 'api/docs';
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
} as const;

const DESCRIPCIONES_PROPIAS: Partial<Record<keyof typeof ETIQUETAS, string>> = {
  salud: 'Fuera del contrato: chequeo de vida para Render',
};

/** Swagger UI en /api/docs y el OpenAPI en JSON en /api/docs-json. */
export function configurarSwagger(app: INestApplication): void {
  const constructor = new DocumentBuilder()
    .setTitle(TITULO)
    .setDescription(
      'Implementación del contrato GDS Flight Core API v1.5.0.0 para vuelos nacionales de Ecuador.',
    )
    .setVersion(VERSION_CONTRATO)
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer');

  for (const [clave, nombre] of Object.entries(ETIQUETAS)) {
    constructor.addTag(nombre, DESCRIPCIONES_PROPIAS[clave as keyof typeof ETIQUETAS]);
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
