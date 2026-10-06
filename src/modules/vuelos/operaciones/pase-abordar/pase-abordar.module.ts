import { Module } from '@nestjs/common';
import { ReservaModule } from '../reserva/reserva.module';
import { CodigoPase } from './codigo-pase';
import { PaseAbordarController } from './pase-abordar.controller';
import { PaseAbordarRepository } from './pase-abordar.repository';
import { PaseAbordarService } from './pase-abordar.service';

/**
 * Pases de abordar (pase_abordar, sin controller propio de la tabla). Los emite el check-in con
 * PaseAbordarService y los consulta GET /bookings/{bookingId}/boarding-passes.
 */
@Module({
  imports: [ReservaModule],
  controllers: [PaseAbordarController],
  providers: [PaseAbordarService, PaseAbordarRepository, CodigoPase],
  exports: [PaseAbordarService, CodigoPase],
})
export class PaseAbordarModule {}
