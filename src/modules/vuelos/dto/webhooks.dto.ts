import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsArray } from 'class-validator';

export class WebhookSubscriptionDto {
  @ApiProperty({ format: 'uri' })
  @IsString()
  url: string;

  @ApiProperty({
    type: [String],
    enum: [
      'booking.confirmed',
      'booking.failed',
      'booking.changed',
      'booking.cancelled',
      'booking.baggage_added',
      'hold.expired',
      'flight.schedule_changed',
      'flight.cancelled',
      'booking.ticket_issuing',
      'booking.ticket_issued',
      'booking.ticket_failed',
      'booking.checked_in',
    ],
  })
  @IsArray()
  events: string[];

  @ApiProperty()
  @IsString()
  secret: string;
}
