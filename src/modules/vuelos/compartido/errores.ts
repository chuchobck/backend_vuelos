import { CODIGO_SIN_EQUIVALENTE } from '../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../common/errores/error-negocio';

/**
 * Errores comunes del catálogo y de las operaciones del contrato. El contrato no trae un
 * `code` para estos casos: usan el de respaldo y el status dice qué pasó. Los textos llegan
 * al cliente, en inglés y sin datos internos.
 */

/** 400: el cuerpo es válido campo por campo pero se contradice (una fila repetida, por ejemplo). */
export const cuerpoInvalido = (campo: string, detalle: string) =>
  new ErrorNegocio(400, CODIGO_SIN_EQUIVALENTE, `${campo}: ${detalle}`, {
    invalidParams: [{ name: campo, reason: detalle }],
  });

/** 404 con un detalle propio. */
export const noExiste = (detalle: string) => new ErrorNegocio(404, CODIGO_SIN_EQUIVALENTE, detalle);
