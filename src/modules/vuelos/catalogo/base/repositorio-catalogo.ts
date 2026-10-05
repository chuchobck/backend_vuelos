import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';

/** Cliente con el que se consulta: el normal o el de una transacción en curso. */
export type Ejecutor = TransaccionVuelos;

/** Filtros que comparten todas las listas del catálogo. */
export interface FiltroCatalogo {
  incluirInactivos: boolean;
}

/**
 * Base de los repositories del catálogo. Cada entidad implementa sus consultas con Prisma
 * (tipadas, sin casts) y la base pone lo común: la transacción auditada y el filtro de
 * activos. Solo los repositories usan Prisma.
 *
 * `Fila` es la fila tal como la necesita el mapper; `clave` es su identificador público
 * (un código natural o un uuid), nunca el id bigint interno.
 */
export abstract class RepositorioCatalogo<Fila, Filtro extends FiltroCatalogo = FiltroCatalogo> {
  constructor(protected readonly prisma: PrismaService) {}

  /** La clave pública de la fila: va en la URL y en el cursor. */
  abstract claveDe(fila: Fila): string;

  /** La fila con esa clave, activa o no; null si no existe. */
  abstract buscar(clave: string, db?: Ejecutor): Promise<Fila | null>;

  /**
   * Hasta `cantidad` filas que cumplen el filtro, en el orden estable de la entidad y
   * después de `despuesDe` (la última fila de la página anterior), o desde el principio.
   */
  abstract listar(filtro: Filtro, despuesDe: Fila | null, cantidad: number): Promise<Fila[]>;

  abstract estaActiva(fila: Fila): boolean;

  /** Baja o alta lógica: un UPDATE, nunca un DELETE. */
  abstract fijarActivo(fila: Fila, activo: boolean, tx: Ejecutor): Promise<void>;

  /** Toda escritura del catálogo: la auditoría registra al usuario y la IP de la petición. */
  enTransaccion<T>(trabajo: (tx: Ejecutor) => Promise<T>): Promise<T> {
    return this.prisma.transaccionAuditada(trabajo);
  }

  /** `activo = true`, salvo que la lista pida también los dados de baja. */
  protected soloActivos(filtro: FiltroCatalogo): { activo?: true } {
    return filtro.incluirInactivos ? {} : { activo: true };
  }
}
