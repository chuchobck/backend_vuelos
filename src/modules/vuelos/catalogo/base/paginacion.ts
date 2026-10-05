import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Como `limit` de GET /bookings en el contrato: 10 por defecto y 50 como máximo. */
export const LIMITE_POR_DEFECTO = 10;
export const LIMITE_MAXIMO = 50;

/** `true` y `false` llegan como texto en la query; cualquier otro valor lo rechaza @IsBoolean. */
export const booleanoDeQuery = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * Parámetros comunes de toda lista del catálogo. Cada entidad la extiende con sus filtros.
 * La paginación sigue la de GET /bookings del contrato: `limit` y `cursor` en la query y
 * `{ nextCursor, items }` en la respuesta.
 */
export class ConsultaCatalogoDto {
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

  @ApiPropertyOptional({ default: false, description: 'Incluye los dados de baja' })
  @IsOptional()
  @Transform(booleanoDeQuery)
  @IsBoolean()
  includeInactive?: boolean;
}

/** Una página de la lista, ya en el formato de la API. Sin `nextCursor`, no hay más. */
export interface Pagina<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * El cursor es la clave pública de la última fila de la página (un código o un uuid) en
 * base64url: opaco para el cliente y sin el id interno, que nunca sale de la API.
 */
export function codificarCursor(clave: string): string {
  return Buffer.from(clave, 'utf8').toString('base64url');
}

export function decodificarCursor(cursor: string): string | undefined {
  const clave = Buffer.from(cursor, 'base64url').toString('utf8');
  // Un texto que no era base64url no vuelve igual al codificarlo: no es un cursor de la API
  return clave !== '' && codificarCursor(clave) === cursor ? clave : undefined;
}
