import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** components.schemas.MoneyAmount del contrato: montos en texto, nunca como número. */
export class MontoDto {
  @ApiProperty({ example: 'USD', pattern: '^[A-Z]{3}$' })
  currency: string;

  @ApiPropertyOptional({ example: '75.40' })
  baseFare?: string;

  @ApiPropertyOptional({ example: '15.08', description: 'IVA y tasas aeroportuarias' })
  taxes?: string;

  @ApiProperty({ example: '90.48' })
  total: string;
}
