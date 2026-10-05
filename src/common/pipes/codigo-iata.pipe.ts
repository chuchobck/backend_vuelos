import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import {
  REGEX_IATA_AEROLINEA,
  REGEX_IATA_AEROPUERTO,
  REGEX_PAIS_ISO2,
  rechazarParametro,
} from './formatos';

/**
 * Código IATA de aeropuerto: 3 letras mayúsculas (UIO, GYE). No se pasa a mayúsculas por el
 * cliente: `uio` se rechaza.
 */
@Injectable()
export class CodigoIataAeropuertoPipe implements PipeTransform<unknown, string> {
  transform(valor: unknown, metadata: ArgumentMetadata): string {
    if (typeof valor !== 'string' || !REGEX_IATA_AEROPUERTO.test(valor)) {
      rechazarParametro(metadata, 'must be a 3-letter uppercase IATA airport code');
    }
    return valor as string;
  }
}

/** Código IATA de aerolínea: 2 caracteres, mayúsculas o dígitos (LA, 4O). */
@Injectable()
export class CodigoIataAerolineaPipe implements PipeTransform<unknown, string> {
  transform(valor: unknown, metadata: ArgumentMetadata): string {
    if (typeof valor !== 'string' || !REGEX_IATA_AEROLINEA.test(valor)) {
      rechazarParametro(metadata, 'must be a 2-character uppercase IATA airline code');
    }
    return valor as string;
  }
}

/** País ISO 3166-1 alfa-2: 2 letras mayúsculas (EC). */
@Injectable()
export class CodigoPaisPipe implements PipeTransform<unknown, string> {
  transform(valor: unknown, metadata: ArgumentMetadata): string {
    if (typeof valor !== 'string' || !REGEX_PAIS_ISO2.test(valor)) {
      rechazarParametro(metadata, 'must be a 2-letter uppercase ISO 3166-1 country code');
    }
    return valor as string;
  }
}
