import { Prisma } from '../../generated/prisma/client';

/**
 * Tablas temporales que sí se borran físicamente al vencer (ofertas, itinerarios y claves
 * de idempotencia). Cualquier otra tabla, incluida una nueva, queda bloqueada: la baja de
 * un catálogo es `activo = false` y un documento de venta cambia de estado.
 */
export const TABLAS_CON_BORRADO_FISICO: ReadonlySet<Prisma.ModelName> = new Set<Prisma.ModelName>([
  'oferta_cabecera',
  'oferta_detalle',
  'itinerario_cabecera',
  'itinerario_detalle',
  'clave_idempotencia',
]);

export class BorradoFisicoProhibidoError extends Error {
  constructor(
    readonly modelo: string,
    readonly operacion: 'delete' | 'deleteMany',
  ) {
    super(
      `${operacion} sobre "${modelo}" está prohibido: usa la eliminación lógica (activo = false) o un cambio de estado`,
    );
    this.name = 'BorradoFisicoProhibidoError';
  }
}

function exigirBorradoPermitido(modelo: string, operacion: 'delete' | 'deleteMany'): void {
  if (!TABLAS_CON_BORRADO_FISICO.has(modelo as Prisma.ModelName)) {
    throw new BorradoFisicoProhibidoError(modelo, operacion);
  }
}

/**
 * Corta `delete` y `deleteMany` antes de que lleguen a la base. No cubre los borrados
 * anidados dentro de un `update` (`{ hijos: { delete: ... } }`) ni `$executeRaw`: en esos
 * casos el freno es la revisión de código y los `ON DELETE RESTRICT` del esquema.
 */
export const bloqueoBorradoFisico = Prisma.defineExtension({
  name: 'bloqueo-borrado-fisico',
  query: {
    $allModels: {
      delete({ model, args, query }) {
        exigirBorradoPermitido(model, 'delete');
        return query(args);
      },
      deleteMany({ model, args, query }) {
        exigirBorradoPermitido(model, 'deleteMany');
        return query(args);
      },
    },
  },
});
