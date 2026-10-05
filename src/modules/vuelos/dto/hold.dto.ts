import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsArray, ValidateNested } from 'class-validator';
import { PassengerBreakdownDto } from './search.dto';

export class ItinerarySelectionDto {
  @ApiProperty()
  @IsString()
  itineraryId: string;

  @ApiProperty({ enum: ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'] })
  @IsString()
  cabinClass: string;

  @ApiProperty()
  @IsString()
  fareBrand: string;
}

export class HoldRequestDto {
  @ApiProperty()
  @IsString()
  offerId: string;

  @ApiProperty({ type: [ItinerarySelectionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItinerarySelectionDto)
  itinerarySelections: ItinerarySelectionDto[];

  @ApiProperty()
  @ValidateNested()
  @Type(() => PassengerBreakdownDto)
  passengersBreakdown: PassengerBreakdownDto;
}
