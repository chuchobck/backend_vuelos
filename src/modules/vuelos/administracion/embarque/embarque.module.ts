import { Module } from '@nestjs/common';
import { PaseAbordarModule } from '../../operaciones/pase-abordar/pase-abordar.module';
import { ReservaModule } from '../../operaciones/reserva/reserva.module';
import { EmbarqueController } from './embarque.controller';
import { EmbarqueRepository } from './embarque.repository';
import { EmbarqueService } from './embarque.service';

/**
 * Embarque de una salida (fase F1, fuera del contrato): escanear pases y el manifiesto de la
 * puerta. Verifica los códigos con el `CodigoPase` que los emitió (PaseAbordarModule) y bloquea
 * la reserva con ReservaService, como el resto de la postventa.
 */
@Module({
  imports: [ReservaModule, PaseAbordarModule],
  controllers: [EmbarqueController],
  providers: [EmbarqueService, EmbarqueRepository],
})
export class EmbarqueModule {}
