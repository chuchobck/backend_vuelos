import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { FechaIso } from '../../../compartido/dto/validadores';

/** Una lista de auditoría es larga: 20 por defecto y hasta 100 por página. */
export const LIMITE_AUDITORIA_POR_DEFECTO = 20;
export const LIMITE_AUDITORIA_MAXIMO = 100;

export const OPERACIONES_AUDITORIA = ['INSERT', 'UPDATE', 'DELETE'] as const;
export type OperacionAuditoria = (typeof OPERACIONES_AUDITORIA)[number];

export class EventoAuditoriaDto {
  @ApiProperty({ example: '1523', description: 'Número del evento, como texto (es un bigint)' })
  id: string;

  @ApiProperty({ format: 'date-time' })
  occurredAt: string;

  @ApiProperty({ example: 'aerolinea', description: 'Tabla donde ocurrió el cambio' })
  table: string;

  @ApiProperty({ enum: OPERACIONES_AUDITORIA })
  operation: OperacionAuditoria;

  @ApiProperty({ description: 'Valor de la columna id de la fila afectada' })
  recordId: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'El `sub` de quien hizo el cambio; null si lo hizo un proceso interno',
  })
  userId: string | null;

  @ApiProperty({ nullable: true, type: String, example: '203.0.113.7' })
  ipAddress: string | null;

  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'En UPDATE, solo las columnas que cambiaron con su valor previo; en DELETE, la fila ' +
      'completa. Los valores sensibles salen como "[REDACTED]".',
  })
  before: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'En UPDATE, las mismas columnas con su valor nuevo; en INSERT, la fila completa.',
  })
  after: Record<string, unknown> | null;
}

export class ListaAuditoriaDto {
  @ApiPropertyOptional({ description: 'Pásalo como `cursor` para la siguiente página' })
  nextCursor?: string;

  @ApiProperty({ type: [EventoAuditoriaDto] })
  items: EventoAuditoriaDto[];
}

const aMayusculas = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toUpperCase() : value;

/** Query de GET /admin/audit-log. Los filtros se combinan con AND. */
export class ConsultaAuditoriaDto {
  @ApiPropertyOptional({ example: 'aerolinea', description: 'Nombre de la tabla auditada' })
  @IsOptional()
  @IsString()
  @MaxLength(63)
  @Matches(/^[a-z_]+$/, { message: 'table must be a table name (lowercase letters and _)' })
  table?: string;

  @ApiPropertyOptional({ enum: OPERACIONES_AUDITORIA })
  @IsOptional()
  @Transform(aMayusculas)
  @IsIn(OPERACIONES_AUDITORIA, {
    message: `operation must be one of: ${OPERACIONES_AUDITORIA.join(', ')}`,
  })
  operation?: OperacionAuditoria;

  @ApiPropertyOptional({ description: 'Valor de la columna id de la fila afectada' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[^\s]+$/, { message: 'recordId must not contain spaces' })
  recordId?: string;

  @ApiPropertyOptional({ description: 'El `sub` (uuid) de quien hizo el cambio' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[^\s]+$/, { message: 'userId must not contain spaces' })
  userId?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Desde ese día (UTC), incluido' })
  @IsOptional()
  @FechaIso()
  from?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Hasta ese día (UTC), incluido' })
  @IsOptional()
  @FechaIso()
  to?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: LIMITE_AUDITORIA_MAXIMO,
    default: LIMITE_AUDITORIA_POR_DEFECTO,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_AUDITORIA_MAXIMO)
  limit?: number;

  @ApiPropertyOptional({ description: 'El `nextCursor` de la página anterior' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'cursor is not valid' })
  cursor?: string;
}
