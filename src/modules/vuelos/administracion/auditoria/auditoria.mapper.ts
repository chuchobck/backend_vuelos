import { operacion_auditoria, Prisma } from '../../../../generated/prisma/client';
import { aInstante } from '../../compartido/formatos-salida';
import { FilaAuditoria } from './auditoria.repository';
import { censurar, ValorJson } from './censura';
import { EventoAuditoriaDto, ListaAuditoriaDto, OperacionAuditoria } from './dto/auditoria.dto';

/** Los ENUM de la base están en español; la API habla en inglés, como el resto de /admin. */
const OPERACION: Record<operacion_auditoria, OperacionAuditoria> = {
  INSERCION: 'INSERT',
  ACTUALIZACION: 'UPDATE',
  ELIMINACION: 'DELETE',
};

export const operacionABase = (operacion: OperacionAuditoria): operacion_auditoria =>
  (Object.keys(OPERACION) as operacion_auditoria[]).find((k) => OPERACION[k] === operacion)!;

/** before/after siempre pasan por `censurar`: es la única salida de datos de la tabla. */
function datos(valor: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (valor === null) return null;
  const censurado = censurar(valor as ValorJson);
  return typeof censurado === 'object' && censurado !== null && !Array.isArray(censurado)
    ? censurado
    : { value: censurado };
}

export function aEventoAuditoria(fila: FilaAuditoria): EventoAuditoriaDto {
  return {
    id: fila.id.toString(),
    occurredAt: aInstante(fila.fecha),
    table: fila.tabla,
    operation: OPERACION[fila.operacion],
    recordId: fila.idRegistro,
    userId: fila.idUsuario,
    ipAddress: fila.direccionIp,
    before: datos(fila.anteriores),
    after: datos(fila.nuevos),
  };
}

export function aListaAuditoria(pagina: {
  filas: FilaAuditoria[];
  nextCursor?: string;
}): ListaAuditoriaDto {
  const items = pagina.filas.map(aEventoAuditoria);
  return pagina.nextCursor === undefined ? { items } : { items, nextCursor: pagina.nextCursor };
}
