import { Module } from '@nestjs/common';
import { IdempotenciaRepository } from '../../compartido/idempotencia.repository';
import { PagosModule } from '../../compartido/pagos/pagos.module';
import { ReservaModule } from '../reserva/reserva.module';
import { EquipajeController } from './equipaje.controller';
import { EquipajeRepository } from './equipaje.repository';
import { EquipajeService } from './equipaje.service';

/**
 * Equipaje adicional de una reserva (reserva_detalle_equipaje, sin controller propio de la
 * tabla). Se apoya en la reserva (dueño, estado, itinerarios) y en PagosModule para cobrar.
 */
@Module({
  imports: [ReservaModule, PagosModule],
  controllers: [EquipajeController],
  providers: [EquipajeService, EquipajeRepository, IdempotenciaRepository],
  exports: [EquipajeService, EquipajeRepository],
})
export class EquipajeModule {}
