import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import {
  REGEX_IATA_AEROLINEA,
  REGEX_IATA_AEROPUERTO,
  REGEX_IATA_MODELO,
  REGEX_NUMERO_VUELO,
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

/** Modelo de aeronave IATA: 3 caracteres, mayúsculas o dígitos (320, AT7). */
@Injectable()
export class CodigoModeloAeronavePipe implements PipeTransform<unknown, string> {
  transform(valor: unknown, metadata: ArgumentMetadata): string {
    if (typeof valor !== 'string' || !REGEX_IATA_MODELO.test(valor)) {
      rechazarParametro(metadata, 'must be a 3-character uppercase IATA aircraft code');
    }
    return valor as string;
  }
}

/** Número de vuelo: aerolínea IATA más la parte numérica sin ceros a la izquierda (AV1234). */
@Injectable()
export class NumeroVueloPipe implements PipeTransform<unknown, string> {
  transform(valor: unknown, metadata: ArgumentMetadata): string {
    if (typeof valor !== 'string' || !REGEX_NUMERO_VUELO.test(valor)) {
      rechazarParametro(metadata, 'must be a flight number such as AV1234');
    }
    return valor as string;
  }
}
