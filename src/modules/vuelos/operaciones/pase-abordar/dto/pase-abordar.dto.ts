import { ApiProperty } from '@nestjs/swagger';
import { TIPO_CODIGO_BARRAS, TipoCodigoBarrasContrato } from '../../../compartido/enums';

/** Los DTO copian components.schemas del contrato, con sus mismos nombres. */

/** components.schemas.BoardingPass. */
export class PaseAbordarDto {
  @ApiProperty({ example: 'PAX1' })
  passengerId: string;

  @ApiProperty({ format: 'uuid', description: 'segmentId del vuelo' })
  segmentId: string;

  @ApiProperty({ example: '10A' })
  seat: string;

  @ApiProperty({
    example: '3',
    nullable: true,
    description: 'Por cabina: 1 ejecutiva o primera, 2 económica premium, 3 económica',
  })
  boardingGroup: string | null;

  @ApiProperty({
    example: '010',
    nullable: true,
    description: 'La fila del asiento con tres dígitos',
  })
  boardingPosition: string | null;

  @ApiProperty({
    example: 'Q1|K7M2QX|0451331201527|LA1400|20261020|UIOGYE|10A|001|9F2C41B7A0D3',
    description:
      'PNR, boleto, vuelo, fecha, ruta, asiento y orden, con una firma. Sin datos personales',
  })
  barcode: string;

  @ApiProperty({ enum: TIPO_CODIGO_BARRAS.valores, example: 'PDF417' })
  barcodeType: TipoCodigoBarrasContrato;
}

/** components.schemas.BoardingPassListResponse. */
export class ListaPasesDto {
  @ApiProperty({ format: 'uuid' })
  bookingId: string;

  @ApiProperty({ type: [PaseAbordarDto] })
  boardingPasses: PaseAbordarDto[];
}
