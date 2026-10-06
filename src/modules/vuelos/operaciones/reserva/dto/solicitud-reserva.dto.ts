import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { REGEX_PAIS_ISO2 } from '../../../../../common/pipes/formatos';
import { CorreoNormalizado } from '../../../../../common/sanitizacion/correo.decorator';
import { TextoLimpio } from '../../../../../common/sanitizacion/texto-limpio.decorator';
import { MAXIMO_PASAJEROS_CON_ASIENTO } from '../../../compartido/dto/pasajeros.dto';
import { FechaIso } from '../../../compartido/dto/validadores';
import {
  GENERO,
  GeneroContrato,
  TIPO_DOCUMENTO,
  TIPO_PASAJERO,
  TipoDocumentoContrato,
  TipoPasajeroContrato,
} from '../../../compartido/enums';
import { MAXIMO_TRAMOS } from '../../busqueda/dto/solicitud-busqueda.dto';

/** Los DTO de esta petición copian components.schemas del contrato, con sus mismos nombres. */

/** passengerId y associatedAdultId: los elige el cliente; solo son únicos dentro de la reserva. */
export const REGEX_CODIGO_PASAJERO = /^[A-Za-z0-9_-]{1,20}$/;
/** Nombres: letras (con tildes), espacios, apóstrofo, punto y guion; sin dígitos. */
const REGEX_NOMBRE = /^\p{L}[\p{L}\p{M} '.-]*$/u;
/** ck_reserva_detalle_pasajero_documento, después de quitar espacios y guiones. */
export const REGEX_DOCUMENTO = /^[A-Z0-9]{5,20}$/;
/** ck_reserva_detalle_pasajero_telefono, después de quitar espacios, guiones y paréntesis. */
const REGEX_TELEFONO = /^\+?[0-9]{7,15}$/;
/** El número de asiento del contrato: fila y letra (12A). */
export const REGEX_NUMERO_ASIENTO = /^[1-9][0-9]{0,2}[A-Z]$/;
/** paymentReference: el formato que acepta cualquier referencia; su valor lo juzga ServicioPagos. */
export const REGEX_REFERENCIA_PAGO = /^[A-Za-z0-9_.:-]{8,64}$/;
/** Hasta 9 pasajeros con asiento y un infante por adulto. */
export const MAXIMO_PASAJEROS = MAXIMO_PASAJEROS_CON_ASIENTO * 2;

const TIPOS_DOCUMENTO = TIPO_DOCUMENTO.valores;

/** Quita espacios, guiones y paréntesis: `+593 99-123 4567` y `+593991234567` son el mismo. */
const sinSeparadores =
  (mayusculas: boolean) =>
  ({ value }: { value: unknown }): unknown => {
    if (typeof value !== 'string') return value;
    const limpio = value.replace(/[\s().-]/g, '');
    return mayusculas ? limpio.toUpperCase() : limpio;
  };

export class ContactoPasajeroDto {
  @ApiProperty({ example: 'ana.perez@example.com' })
  @CorreoNormalizado()
  email: string;

  @ApiProperty({ example: '+593991234567', description: 'De 7 a 15 dígitos, con + opcional' })
  @Transform(sinSeparadores(false))
  @IsString()
  @Matches(REGEX_TELEFONO, { message: '$property must have 7 to 15 digits, with an optional +' })
  phone: string;
}

/** Asiento elegido en un segmento (PassengerItem.assignedSeats). */
export class AsientoElegidoDto {
  @ApiProperty({ format: 'uuid', description: 'segmentId de un segmento del hold' })
  @IsUUID('all', { message: '$property must be a UUID' })
  segmentId: string;

  @ApiProperty({ example: '12A', pattern: REGEX_NUMERO_ASIENTO.source })
  @IsString()
  @Matches(REGEX_NUMERO_ASIENTO, { message: '$property must be a row and a letter (12A)' })
  seatNumber: string;
}

/** PassengerItem.extraBaggage. Al crear la reserva debe ir vacío: se compra después. */
export class EquipajeExtraDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  itineraryId: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  quantity: number;
}

/** components.schemas.PassengerItem. */
export class PasajeroReservaDto {
  @ApiProperty({ example: 'PAX1', pattern: REGEX_CODIGO_PASAJERO.source })
  @IsString()
  @Matches(REGEX_CODIGO_PASAJERO, {
    message: '$property must be 1 to 20 letters, digits, _ or -',
  })
  passengerId: string;

  @ApiProperty({ enum: TIPO_PASAJERO.valores, example: 'ADULT' })
  @IsIn(TIPO_PASAJERO.valores, {
    message: `$property must be one of: ${TIPO_PASAJERO.valores.join(', ')}`,
  })
  passengerType: TipoPasajeroContrato;

  @ApiPropertyOptional({ description: 'passengerId del adulto que lleva al infante' })
  @IsOptional()
  @IsString()
  @Matches(REGEX_CODIGO_PASAJERO, {
    message: '$property must be 1 to 20 letters, digits, _ or -',
  })
  associatedAdultId?: string;

  @ApiProperty({ example: 'Ana' })
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(60)
  @Matches(REGEX_NOMBRE, { message: "$property must contain only letters, spaces, . ' or -" })
  firstName: string;

  @ApiProperty({ example: 'Pérez' })
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(60)
  @Matches(REGEX_NOMBRE, { message: "$property must contain only letters, spaces, . ' or -" })
  lastName: string;

  @ApiProperty({ enum: TIPOS_DOCUMENTO, example: 'NATIONAL_ID' })
  @IsIn(TIPOS_DOCUMENTO, { message: `$property must be one of: ${TIPOS_DOCUMENTO.join(', ')}` })
  documentType: TipoDocumentoContrato;

  @ApiProperty({
    example: '1710034065',
    description:
      'Sin espacios ni guiones (se quitan); la cédula ecuatoriana lleva su dígito verificador',
  })
  @Transform(sinSeparadores(true))
  @IsString()
  @Matches(REGEX_DOCUMENTO, { message: '$property must be 5 to 20 letters or digits' })
  documentNumber: string;

  @ApiProperty({ example: 'EC', description: 'País ISO 3166-1 alfa-2' })
  @IsString()
  @Matches(REGEX_PAIS_ISO2, { message: '$property must be an ISO 3166-1 alpha-2 country code' })
  nationality: string;

  @ApiPropertyOptional({
    example: '2031-05-20',
    format: 'date',
    description: 'Obligatoria con PASSPORT',
  })
  @IsOptional()
  @FechaIso()
  documentExpiryDate?: string;

  @ApiProperty({ example: '1990-04-15', format: 'date' })
  @FechaIso()
  birthDate: string;

  @ApiProperty({ enum: GENERO.valores, example: 'F' })
  @IsIn(GENERO.valores, { message: `$property must be one of: ${GENERO.valores.join(', ')}` })
  gender: GeneroContrato;

  @ApiProperty({ type: ContactoPasajeroDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ContactoPasajeroDto)
  contact: ContactoPasajeroDto;

  @ApiPropertyOptional({
    type: [AsientoElegidoDto],
    example: [],
    description:
      'Opcional: sin asiento elegido, la API asigna el primero libre de la cabina. Para elegir: { segmentId, seatNumber } con el segmentId del hold y un asiento libre del seatmap',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAXIMO_TRAMOS * 2)
  @ValidateNested({ each: true })
  @Type(() => AsientoElegidoDto)
  assignedSeats?: AsientoElegidoDto[];

  @ApiPropertyOptional({
    type: [EquipajeExtraDto],
    example: [],
    description: 'Debe ir vacío: el equipaje adicional se compra con POST /bookings/{id}/baggage',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAXIMO_TRAMOS)
  @ValidateNested({ each: true })
  @Type(() => EquipajeExtraDto)
  extraBaggage?: EquipajeExtraDto[];
}

/** components.schemas.PaymentReference. */
export class ReferenciaPagoDto {
  @ApiProperty({
    example: 'PAY-OK-7F3A9C21',
    description:
      'Referencia de la Payment API (simulada): PAY-OK-… aprobado, PAY-PEND-… pendiente, PAY-REJ-… rechazado',
  })
  @IsString()
  @Matches(REGEX_REFERENCIA_PAGO, {
    message: '$property must be 8 to 64 letters, digits or _ . : -',
  })
  paymentReference: string;
}

/** components.schemas.BookingRequest. El dueño sale del JWT, nunca del cuerpo. */
export class SolicitudReservaDto {
  @ApiProperty({ format: 'uuid', description: 'holdId de POST /offers/hold' })
  @IsUUID('all', { message: '$property must be a UUID' })
  holdId: string;

  @ApiProperty({ type: [PasajeroReservaDto], minItems: 1, maxItems: MAXIMO_PASAJEROS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAXIMO_PASAJEROS)
  @ValidateNested({ each: true })
  @Type(() => PasajeroReservaDto)
  passengers: PasajeroReservaDto[];

  @ApiProperty({ type: ReferenciaPagoDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ReferenciaPagoDto)
  payment: ReferenciaPagoDto;
}
