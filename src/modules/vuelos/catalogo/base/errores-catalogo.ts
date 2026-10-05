import { CODIGO_SIN_EQUIVALENTE } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';

/**
 * Errores de negocio del catálogo. El contrato no trae códigos para estos casos: todos usan
 * el de respaldo y el status dice qué pasó. Los textos van al cliente, en inglés.
 */

/** 404: la clave no existe (activa o no). */
export const noEncontrado = (entidad: string, clave: string) =>
  new ErrorNegocio(404, CODIGO_SIN_EQUIVALENTE, `${entidad} ${clave} was not found`);

/** 409: no se puede dar de baja porque otras filas activas la usan. */
export const enUso = (entidad: string, clave: string, usos: string[]) =>
  new ErrorNegocio(
    409,
    CODIGO_SIN_EQUIVALENTE,
    `${entidad} ${clave} cannot be deactivated: it is used by ${usos.join(', ')}`,
  );

/** 409: el estado actual no admite el cambio (una salida que ya despegó, por ejemplo). */
export const conflicto = (detalle: string) =>
  new ErrorNegocio(409, CODIGO_SIN_EQUIVALENTE, detalle);

/**
 * 422: la petición apunta a una fila que no existe o está dada de baja (o viola una regla
 * entre filas). `campo` va en invalidParams para que el cliente sepa cuál corregir.
 */
export const referenciaInvalida = (campo: string, detalle: string) =>
  new ErrorNegocio(422, CODIGO_SIN_EQUIVALENTE, detalle, {
    invalidParams: [{ name: campo, reason: detalle }],
  });

/** 400: el cursor no salió de esta lista. */
export const cursorInvalido = () =>
  new ErrorNegocio(400, CODIGO_SIN_EQUIVALENTE, 'cursor: is not a cursor of this list', {
    invalidParams: [{ name: 'cursor', reason: 'is not a cursor of this list' }],
  });
