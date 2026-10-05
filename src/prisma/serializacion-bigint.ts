/**
 * Las PK internas son bigint y Prisma las entrega como BigInt, que JSON.stringify no
 * sabe convertir (lanza TypeError). Se serializan como texto para no perder precisión
 * por encima de Number.MAX_SAFE_INTEGER. Los numeric llegan como Prisma.Decimal, que
 * ya se serializa como texto; los mappers convierten ambos al formato del contrato.
 */
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

export function habilitarBigIntEnJson(): void {
  BigInt.prototype.toJSON = function (this: bigint): string {
    return this.toString();
  };
}
