import { INestApplication } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Prisma } from '../src/generated/prisma/client';
import { BorradoFisicoProhibidoError } from '../src/prisma/extensiones/bloqueo-borrado-fisico';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';

const RAIZ_CATALOGO = join(__dirname, '..', 'src', 'modules', 'vuelos', 'catalogo');

/** Tablas que maneja el catálogo, cabeceras y detalles. */
const TABLAS: Prisma.ModelName[] = [
  'pais',
  'ciudad',
  'aeropuerto',
  'aerolinea',
  'modelo_aeronave',
  'familia_tarifa',
  'mapa_asientos_cabecera',
  'mapa_asientos_detalle',
  'asiento',
  'vuelo',
  'vuelo_programado',
  'inventario_cabina',
  'tarifa_cabecera',
  'tarifa_detalle',
];

function archivos(directorio: string): string[] {
  return readdirSync(directorio).flatMap((nombre) => {
    const ruta = join(directorio, nombre);
    return statSync(ruta).isDirectory() ? archivos(ruta) : [ruta];
  });
}

/**
 * El catálogo da de baja con UPDATE y nunca borra. Se comprueba por tres lados: el código no
 * llama a ninguna forma de borrado, la extensión de Prisma sigue cortando delete y deleteMany
 * en todas sus tablas, y la auditoría no tiene ninguna ELIMINACION de esas tablas.
 */
describe('Catálogo: ningún DELETE físico', () => {
  it('el código del catálogo no borra ni usa SQL crudo sin parámetros', () => {
    const prohibidos = [
      /\.delete\(/,
      /\.deleteMany\(/,
      /\bDELETE\s+FROM\b/i,
      /\$executeRawUnsafe|\$queryRawUnsafe/,
      /\bTRUNCATE\b/i,
    ];
    const hallazgos = archivos(RAIZ_CATALOGO)
      .filter((ruta) => ruta.endsWith('.ts'))
      .flatMap((ruta) => {
        const texto = readFileSync(ruta, 'utf8');
        return prohibidos
          .filter((patron) => patron.test(texto))
          .map((p) => `${relative(RAIZ_CATALOGO, ruta)}: ${p}`);
      });
    expect(hallazgos).toEqual([]);
  });

  describe('contra la base', () => {
    let app: INestApplication;
    let prisma: PrismaService;

    beforeAll(async () => {
      app = await crearApp();
      prisma = app.get(PrismaService);
    });
    afterAll(async () => {
      await app.close();
    });

    it.each(TABLAS)('la extensión corta delete y deleteMany sobre %s', async (tabla) => {
      // Cada delegado de Prisma tiene delete y deleteMany; el filtro imposible no toca nada
      const delegado = prisma.db[tabla] as unknown as {
        delete(args: object): Promise<unknown>;
        deleteMany(args: object): Promise<unknown>;
      };
      await expect(delegado.deleteMany({ where: {} })).rejects.toBeInstanceOf(
        BorradoFisicoProhibidoError,
      );
      await expect(delegado.delete({ where: { id: -1 } })).rejects.toBeInstanceOf(
        BorradoFisicoProhibidoError,
      );
    });

    it('la auditoría no tiene ninguna fila ELIMINACION de las tablas del catálogo', async () => {
      const [{ cantidad }] = await prisma.db.$queryRaw<Array<{ cantidad: number }>>`
        SELECT count(*)::int AS cantidad FROM vuelos.auditoria
         WHERE operacion = 'ELIMINACION' AND nombre_tabla = ANY(${TABLAS}::text[])`;
      expect(cantidad).toBe(0);
    });
  });
});
