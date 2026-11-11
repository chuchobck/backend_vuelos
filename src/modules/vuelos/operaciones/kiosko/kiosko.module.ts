import { Module } from '@nestjs/common';
import { CheckinModule } from '../checkin/checkin.module';
import { PaseAbordarModule } from '../pase-abordar/pase-abordar.module';
import { ReservaModule } from '../reserva/reserva.module';
import { ComparadorApellidos } from './apellido';
import { KioskoController } from './kiosko.controller';
import { KioskoRepository } from './kiosko.repository';
import { KioskoService } from './kiosko.service';
import { SesionKiosko } from './sesion-kiosko';

/**
 * Kiosko de check-in sin cuenta (fase F1, fuera del contrato). No tiene reglas de negocio
 * propias: busca la reserva, abre una sesión limitada a ella y llama a los services de la
 * reserva, del check-in y de los pases.
 */
@Module({
  imports: [ReservaModule, CheckinModule, PaseAbordarModule],
  controllers: [KioskoController],
  providers: [KioskoService, KioskoRepository, SesionKiosko, ComparadorApellidos],
})
export class KioskoModule {}
