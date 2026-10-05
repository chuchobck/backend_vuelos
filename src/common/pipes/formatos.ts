import { ArgumentMetadata } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { CodigoError } from '../errores/codigo-error';
import { ErrorNegocio } from '../errores/error-negocio';

/** Aeropuerto IATA: 3 letras mayúsculas (ck_aeropuerto_codigo_iata). */
export const REGEX_IATA_AEROPUERTO = /^[A-Z]{3}$/;

/** Aerolínea IATA: 2 caracteres, letras mayúsculas o dígitos (ck_aerolinea_codigo_iata). */
export const REGEX_IATA_AEROLINEA = /^[A-Z0-9]{2}$/;

/** País ISO 3166-1 alfa-2: 2 letras mayúsculas (ck_pais_codigo_iso2). */
export const REGEX_PAIS_ISO2 = /^[A-Z]{2}$/;

/** País ISO 3166-1 alfa-3: 3 letras mayúsculas (ck_pais_codigo_iso3). */
export const REGEX_PAIS_ISO3 = /^[A-Z]{3}$/;

const REGEX_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

export function esUuid(valor: unknown): valor is string {
  return typeof valor === 'string' && isUUID(valor);
}

/**
 * `YYYY-MM-DD` que existe en el calendario. Devuelve la fecha a medianoche UTC, como llega
 * un `date` de la base, o `undefined` si el texto no es una fecha válida. Se calcula en UTC
 * para que la zona horaria del servidor no corra el día.
 */
export function fechaIsoAUtc(valor: unknown): Date | undefined {
  if (typeof valor !== 'string') return undefined;
  const partes = REGEX_FECHA.exec(valor);
  if (partes === null) return undefined;

  const [anio, mes, dia] = [Number(partes[1]), Number(partes[2]), Number(partes[3])];
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  // Date.UTC "corrige" el 30 de febrero al 2 de marzo: si el día cambió, la fecha no existía.
  const existe =
    fecha.getUTCFullYear() === anio &&
    fecha.getUTCMonth() === mes - 1 &&
    fecha.getUTCDate() === dia;
  return existe ? fecha : undefined;
}

/** 400 VALIDATION_FAILED nombrando el parámetro de ruta o de query que falló. */
export function rechazarParametro(metadata: ArgumentMetadata, razon: string): never {
  const nombre = metadata.data ?? 'value';
  throw new ErrorNegocio(400, CodigoError.VALIDATION_FAILED, `${nombre}: ${razon}`, {
    invalidParams: [{ name: nombre, reason: razon }],
  });
}
