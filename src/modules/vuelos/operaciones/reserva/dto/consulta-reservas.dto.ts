import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { FechaIso } from '../../../compartido/dto/validadores';
import { ESTADO_RESERVA, EstadoReservaContrato } from '../../../compartido/enums';
import { LIMITE_MAXIMO, LIMITE_POR_DEFECTO } from '../../../catalogo/base/paginacion';

/** El PNR: 6 letras o dígitos; se compara en mayúsculas. */
export const REGEX_PNR = /^[A-Z0-9]{6}$/;

/** Query de GET /bookings, con los nombres del contrato. */
export class ConsultaReservasDto {
  @ApiPropertyOptional({ example: 'K7M2QX' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsString()
  @Matches(REGEX_PNR, { message: '$property must be 6 letters or digits' })
  pnr?: string;

  @ApiPropertyOptional({ enum: ESTADO_RESERVA.valores })
  @IsOptional()
  @IsIn(ESTADO_RESERVA.valores, {
    message: `$property must be one of: ${ESTADO_RESERVA.valores.join(', ')}`,
  })
  status?: EstadoReservaContrato;

  @ApiPropertyOptional({ format: 'date', description: 'Creadas desde ese día (UTC), incluido' })
  @IsOptional()
  @FechaIso()
  createdFrom?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Creadas hasta ese día (UTC), incluido' })
  @IsOptional()
  @FechaIso()
  createdTo?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: LIMITE_MAXIMO, default: LIMITE_POR_DEFECTO })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_MAXIMO)
  limit?: number;

  @ApiPropertyOptional({ description: 'El `nextCursor` de la página anterior' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'cursor is not valid' })
  cursor?: string;
}
