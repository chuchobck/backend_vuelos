import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { CODIGO_SIN_EQUIVALENTE } from '../errores/codigo-error';
import { ErrorNegocio } from '../errores/error-negocio';

export const CABECERA_IDEMPOTENCIA = 'Idempotency-Key';

/** Un uuid en su forma canónica (8-4-4-4-12 hexadecimales), de cualquier versión. */
const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * La cabecera Idempotency-Key (format: uuid en el contrato), en minúsculas. Si falta o no es
 * un uuid, 400 VALIDATION_FAILED con invalidParams. El valor recibido no se repite en el
 * error: puede ser cualquier cosa que mandó el cliente.
 *
 *   crear(@ClaveIdempotencia() clave: string) {}
 *
 * Qué hace la operación con la clave lo decide su service (la clave se guarda en la misma
 * transacción que el cambio que protege).
 */
export const ClaveIdempotencia = createParamDecorator(
  (_dato: unknown, contexto: ExecutionContext) => {
    const valor = contexto.switchToHttp().getRequest<Request>().headers['idempotency-key'];
    if (typeof valor !== 'string' || !FORMATO_UUID.test(valor)) {
      const razon = valor === undefined ? 'is required' : 'must be a UUID';
      throw new ErrorNegocio(400, CODIGO_SIN_EQUIVALENTE, `${CABECERA_IDEMPOTENCIA}: ${razon}`, {
        invalidParams: [{ name: CABECERA_IDEMPOTENCIA, reason: razon }],
      });
    }
    return valor.toLowerCase();
  },
);
