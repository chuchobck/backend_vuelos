import { PrismaService, TransaccionVuelos } from '../../src/prisma/prisma.service';

class Revertir extends Error {}

/**
 * Corre `trabajo` dentro de una transacción que SIEMPRE se revierte, aunque todo salga bien:
 * las pruebas contra la base real no dejan datos. Un error de `trabajo` sí se propaga.
 */
export async function enTransaccionRevertida(
  prisma: PrismaService,
  trabajo: (tx: TransaccionVuelos) => Promise<void>,
): Promise<void> {
  try {
    await prisma.db.$transaction(async (tx) => {
      await trabajo(tx);
      throw new Revertir();
    });
  } catch (error) {
    if (!(error instanceof Revertir)) throw error;
  }
}

/**
 * Ejecuta `accion`, que se espera que falle, y devuelve el error tal como lo entrega Prisma.
 * Usa un SAVEPOINT: en PostgreSQL un error aborta la transacción, y así la prueba puede
 * seguir con otra operación dentro de la misma transacción.
 */
export async function capturar(
  tx: TransaccionVuelos,
  accion: () => PromiseLike<unknown>,
): Promise<unknown> {
  await tx.$executeRawUnsafe('SAVEPOINT sonda');
  try {
    await accion();
  } catch (error) {
    return error;
  } finally {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sonda');
  }
  throw new Error('La operación no falló');
}

/** Igual que `capturar`, para una sentencia SQL cruda (con tablas calificadas `vuelos.`). */
export function capturarError(
  tx: TransaccionVuelos,
  sql: string,
  ...parametros: unknown[]
): Promise<unknown> {
  return capturar(tx, () => tx.$executeRawUnsafe(sql, ...parametros));
}
