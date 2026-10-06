import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Pasajeros que ocupan asiento (adultos, jóvenes y niños) por búsqueda. El contrato no fija
 * un máximo; es el de la base para una retención (ck_retencion_cabecera_maximo).
 */
export const MAXIMO_PASAJEROS_CON_ASIENTO = 9;

/**
 * components.schemas.PassengerBreakdown. Los valores por defecto son los del contrato. Además
 * de sus mínimos, la base exige a lo sumo 9 pasajeros con asiento y no más infantes que
 * adultos (cada infante viaja en brazos de un adulto); se valida en el service. El ejemplo
 * (un adulto) es el de la guía de Swagger: coincide con el único pasajero del ejemplo de reserva.
 */
export class PasajerosDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAXIMO_PASAJEROS_CON_ASIENTO)
  adults?: number = 1;

  @ApiPropertyOptional({ example: 0, minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAXIMO_PASAJEROS_CON_ASIENTO)
  youths?: number = 0;

  @ApiPropertyOptional({ example: 0, minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAXIMO_PASAJEROS_CON_ASIENTO)
  children?: number = 0;

  @ApiPropertyOptional({ example: 0, minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAXIMO_PASAJEROS_CON_ASIENTO)
  infants?: number = 0;
}
