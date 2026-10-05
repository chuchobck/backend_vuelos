import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  Matches,
  MaxLength,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { REGEX_PAIS_ISO2 } from '../../../../../common/pipes/formatos';
import { TextoLimpio } from '../../../../../common/sanitizacion/texto-limpio.decorator';
import { ConsultaCatalogoDto } from '../../base/paginacion';

/** Mismo formato que ck_ciudad_zona_horaria, y además una zona que Node conoce. */
const FORMATO_ZONA = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/;

export function esZonaHorariaIana(valor: unknown): boolean {
  if (typeof valor !== 'string' || !FORMATO_ZONA.test(valor)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: valor });
    return true;
  } catch {
    return false;
  }
}

function ZonaHoraria(opciones?: ValidationOptions): PropertyDecorator {
  return (objeto, propiedad) =>
    registerDecorator({
      name: 'zonaHoraria',
      target: objeto.constructor,
      propertyName: propiedad as string,
      options: opciones,
      validator: {
        validate: esZonaHorariaIana,
        defaultMessage: ({ property }) =>
          `${property} must be an IANA time zone such as America/Guayaquil`,
      },
    });
}

export class CiudadRespuestaDto {
  @ApiProperty({ format: 'uuid', description: 'Es el id en la URL' })
  id: string;

  @ApiProperty({ example: 'EC', description: 'País (ISO 3166-1 alfa-2)' })
  country: string;

  @ApiProperty({ example: 'Quito' })
  name: string;

  @ApiProperty({ example: 'America/Guayaquil', description: 'Zona horaria IANA' })
  timeZone: string;

  @ApiProperty({ example: true })
  active: boolean;
}

export class CrearCiudadDto {
  @ApiProperty({ example: 'EC' })
  @Matches(REGEX_PAIS_ISO2, { message: 'country must be a 2-letter uppercase ISO 3166-1 code' })
  country: string;

  @ApiProperty({ example: 'Latacunga', maxLength: 100 })
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'America/Guayaquil', default: 'America/Guayaquil' })
  @IsOptional()
  @ZonaHoraria()
  timeZone?: string;
}

/** El país es parte de la identidad de la ciudad: no se cambia. */
export class ActualizarCiudadDto {
  @ApiPropertyOptional({ example: 'San Francisco de Quito', maxLength: 100 })
  @TextoLimpio()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'Pacific/Galapagos' })
  @IsOptional()
  @ZonaHoraria()
  timeZone?: string;
}

export class ConsultaCiudadDto extends ConsultaCatalogoDto {
  @ApiPropertyOptional({ example: 'EC', description: 'Solo las de este país' })
  @IsOptional()
  @Matches(REGEX_PAIS_ISO2, { message: 'country must be a 2-letter uppercase ISO 3166-1 code' })
  country?: string;
}
