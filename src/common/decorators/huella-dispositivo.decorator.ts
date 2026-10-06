import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { CODIGO_SIN_EQUIVALENTE } from '../errores/codigo-error';
import { ErrorNegocio } from '../errores/error-negocio';

export const CABECERA_HUELLA = 'X-Device-Fingerprint';

/**
 * De 8 a 128 caracteres de un alfabeto seguro para log y base: letras, dígitos y . _ : + / = -
 * (cubre hexadecimal, base64, base64url y uuid). Sin espacios ni caracteres de control.
 */
const FORMATO_HUELLA = /^[A-Za-z0-9._:+/=-]{8,128}$/;

/**
 * La cabecera X-Device-Fingerprint, obligatoria en POST /search (contrato). Si falta o no
 * cumple el formato, 400 VALIDATION_FAILED. El valor nunca se repite en el error ni se
 * registra en el log: identifica un dispositivo.
 *
 *   buscar(@HuellaDispositivo() huella: string) {}
 */
export const HuellaDispositivo = createParamDecorator(
  (_dato: unknown, contexto: ExecutionContext) => {
    const valor = contexto.switchToHttp().getRequest<Request>().headers['x-device-fingerprint'];
    if (typeof valor !== 'string' || !FORMATO_HUELLA.test(valor)) {
      const razon =
        valor === undefined
          ? 'is required'
          : 'must be 8 to 128 characters: letters, digits or . _ : + / = -';
      throw new ErrorNegocio(400, CODIGO_SIN_EQUIVALENTE, `${CABECERA_HUELLA}: ${razon}`, {
        invalidParams: [{ name: CABECERA_HUELLA, reason: razon }],
      });
    }
    return valor;
  },
);
