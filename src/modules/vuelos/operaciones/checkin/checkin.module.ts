import { Module } from '@nestjs/common';
import { ReservaModule } from '../reserva/reserva.module';
import { CheckinController } from './checkin.controller';
import { CheckinRepository } from './checkin.repository';
import { CheckinService } from './checkin.service';

/**
 * Check-in de una reserva (checkin, sin controller propio de la tabla). Se apoya en la reserva
 * para el dueño, el estado, los boletos y el historial.
 */
@Module({
  imports: [ReservaModule],
  controllers: [CheckinController],
  providers: [CheckinService, CheckinRepository],
  exports: [CheckinService, CheckinRepository],
})
export class CheckinModule {}
