import { Module } from '@nestjs/common';
import { IdempotenciaRepository } from '../../compartido/idempotencia.repository';
import { PagosModule } from '../../compartido/pagos/pagos.module';
import { BoletoModule } from '../boleto/boleto.module';
import { ReservaModule } from '../reserva/reserva.module';
import { CancelacionController } from './cancelacion.controller';
import { CancelacionRepository } from './cancelacion.repository';
import { CancelacionService } from './cancelacion.service';

/**
 * Cotización y cancelación de una reserva (cotizacion_cancelacion, sin controller propio de
 * la tabla). Se apoya en la reserva para el dueño, el estado, los asientos y el cupo, en los
 * boletos para anularlos y en ServicioPagos para el reembolso.
 */
@Module({
  imports: [ReservaModule, BoletoModule, PagosModule],
  controllers: [CancelacionController],
  providers: [CancelacionService, CancelacionRepository, IdempotenciaRepository],
  exports: [CancelacionService],
})
export class CancelacionModule {}
