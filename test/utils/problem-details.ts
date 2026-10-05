import { CodigoError } from '../../src/common/errores/codigo-error';

const CAMPOS_DEL_CONTRATO = ['type', 'title', 'status', 'detail', 'code', 'invalidParams'];

/**
 * Comprueba que el cuerpo cumple components.schemas.ProblemDetails del contrato:
 * campos obligatorios, ningún campo extra y `code` dentro de la lista cerrada.
 */
export function esperarProblemDetails(respuesta: {
  status: number;
  type: string;
  body: Record<string, unknown>;
}): void {
  expect(respuesta.type).toBe('application/problem+json');
  expect(Object.keys(respuesta.body).filter((c) => !CAMPOS_DEL_CONTRATO.includes(c))).toEqual([]);
  expect(typeof respuesta.body.type).toBe('string');
  expect(typeof respuesta.body.title).toBe('string');
  expect(respuesta.body.status).toBe(respuesta.status);
  expect(Object.values(CodigoError)).toContain(respuesta.body.code);
}
