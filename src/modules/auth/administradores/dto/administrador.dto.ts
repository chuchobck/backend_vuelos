import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
import {
  booleanoDeQuery,
  LIMITE_MAXIMO,
  LIMITE_POR_DEFECTO,
} from '../../../vuelos/catalogo/base/paginacion';
import { RegistroDto } from '../../dto/credenciales.dto';

export class AdministradorRespuestaDto {
  @ApiProperty({ format: 'uuid', description: 'Es el `sub` de sus tokens y el id en la URL' })
  id: string;

  @ApiProperty({ example: 'admin2@quinde.example' })
  email: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ example: true, description: 'false si el administrador fue dado de baja' })
  active: boolean;
}

export class ListaAdministradoresDto {
  @ApiPropertyOptional({ description: 'Pásalo como `cursor` para la siguiente página' })
  nextCursor?: string;

  @ApiProperty({ type: [AdministradorRespuestaDto] })
  items: AdministradorRespuestaDto[];
}

/**
 * POST /admin/users: las mismas reglas y normalización que POST /auth/register (correo válido
 * en minúsculas, contraseña de 12 a 128). No hay campo de rol: lo fija el servidor, y el
 * ValidationPipe global rechaza con 400 cualquier campo que el DTO no declare.
 */
export class CrearAdministradorDto extends RegistroDto {}

export class ConsultaAdministradoresDto {
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

  @ApiPropertyOptional({ default: false, description: 'Incluye los administradores dados de baja' })
  @IsOptional()
  @Transform(booleanoDeQuery)
  @IsBoolean()
  includeInactive?: boolean;
}
