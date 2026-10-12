import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CorreoNormalizado } from '../../../../../common/sanitizacion/correo.decorator';
import { TextoLimpio } from '../../../../../common/sanitizacion/texto-limpio.decorator';
import { REGEX_NUMERO_VUELO } from '../../../../../common/pipes/formatos';
import { ConsultaReservasDto } from '../../../operaciones/reserva/dto/consulta-reservas.dto';
import {
  DetalleReservaDto,
  ResumenReservaDto,
} from '../../../operaciones/reserva/dto/respuesta-reserva.dto';

/** El dueño de una reserva: el `sub` de su cuenta y su correo (null si la cuenta ya no existe). */
export class PropietarioReservaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ nullable: true, type: String, example: 'ana@example.com' })
  email: string | null;
}

/** ResumenReserva (GET /bookings) más el dueño. */
export class ResumenReservaAdminDto extends ResumenReservaDto {
  @ApiProperty({ type: PropietarioReservaDto })
  owner: PropietarioReservaDto;
}

export class ListaReservasAdminDto {
  @ApiPropertyOptional({ description: 'Se pasa como `cursor` para la página siguiente' })
  nextCursor?: string;

  @ApiProperty({ type: [ResumenReservaAdminDto] })
  items: ResumenReservaAdminDto[];
}

/** DetalleReserva (GET /bookings/{id}) más el dueño. */
export class DetalleReservaAdminDto extends DetalleReservaDto {
  @ApiProperty({ type: PropietarioReservaDto })
  owner: PropietarioReservaDto;
}

/** Query de GET /admin/bookings: la de GET /bookings más dos filtros de administración. */
export class ConsultaReservasAdminDto extends ConsultaReservasDto {
  @ApiPropertyOptional({
    example: 'ana@example.com',
    description: 'Correo exacto del cliente dueño de la reserva',
  })
  @IsOptional()
  @CorreoNormalizado()
  ownerEmail?: string;

  @ApiPropertyOptional({
    example: 'LA2410',
    description: 'Número de vuelo con aerolínea, en algún itinerario vigente de la reserva',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MaxLength(6)
  @Matches(REGEX_NUMERO_VUELO, { message: '$property must be a flight number such as AV1234' })
  flightNumber?: string;
}

/** Cuerpo de POST /admin/bookings/{id}/cancel: solo un motivo opcional. */
export class CancelarReservaAdminDto {
  @ApiPropertyOptional({ example: 'Vuelo cancelado por la aerolínea', maxLength: 500 })
  @IsOptional()
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}
