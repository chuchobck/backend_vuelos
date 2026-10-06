import { Module } from '@nestjs/common';
import { ReservaModule } from '../reserva/reserva.module';
import { CancelacionController } from './cancelacion.controller';
import { CancelacionRepository } from './cancelacion.repository';
import { CancelacionService } from './cancelacion.service';

/**
 * Cotización y cancelación de una reserva (cotizacion_cancelacion, sin controller propio de
 * la tabla). Se apoya en la reserva para el dueño, el estado, los asientos y el cupo.
 */
@Module({
  imports: [ReservaModule],
  controllers: [CancelacionController],
  providers: [CancelacionService, CancelacionRepository],
  exports: [CancelacionService],
})
export class CancelacionModule {}
