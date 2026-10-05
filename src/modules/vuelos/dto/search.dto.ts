import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  IsDateString,
  IsOptional,
  Matches,
} from 'class-validator';

export class ItinerarySearchDto {
  @ApiProperty({ example: 'UIO', pattern: '^[A-Z]{3}$' })
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  origin: string;

  @ApiProperty({ example: 'JFK', pattern: '^[A-Z]{3}$' })
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  destination: string;

  @ApiProperty({ example: '2026-12-01', format: 'date' })
  @IsDateString()
  departureDate: string;
}

export class PassengerBreakdownDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  adults?: number = 1;

  @ApiPropertyOptional({ example: 0, minimum: 0, default: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  youths?: number = 0;

  @ApiPropertyOptional({ example: 0, minimum: 0, default: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  children?: number = 0;

  @ApiPropertyOptional({ example: 0, minimum: 0, default: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  infants?: number = 0;
}

export class SearchRequestDto {
  @ApiProperty({ type: [ItinerarySearchDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItinerarySearchDto)
  itineraries: ItinerarySearchDto[];

  @ApiProperty()
  @ValidateNested()
  @Type(() => PassengerBreakdownDto)
  passengers: PassengerBreakdownDto;
}

export class MoneyAmountDto {
  @ApiProperty({ example: 'USD', pattern: '^[A-Z]{3}$' })
  currency: string;
  @ApiProperty({ example: '100.00' })
  baseFare?: string;
  @ApiProperty({ example: '20.00' })
  taxes?: string;
  @ApiProperty({ example: '120.00' })
  total: string;
}

// ... other response DTOs for SearchResponse can be added here or mocked in controller directly using raw objects for brevity since they are output only for now.
