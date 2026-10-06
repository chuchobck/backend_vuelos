import { Module } from '@nestjs/common';
import { IdempotenciaRepository } from '../../compartido/idempotencia.repository';
import { PagosModule } from '../../compartido/pagos/pagos.module';
import { BoletoModule } from '../boleto/boleto.module';
import { RetencionModule } from '../retencion/retencion.module';
import { EventosReserva } from './eventos-reserva';
import { ReservaRepository } from './reserva.repository';
import { ReservaService } from './reserva.service';

/**
 * /bookings (contrato). Los pasajeros, asientos, pago, itinerarios e historial de la reserva no
 * tienen controller: los maneja este service. Consume el hold con RetencionService y emite los
 * boletos con BoletoService; el pago lo juzga ServicioPagos (PagosModule).
 */
@Module({
  imports: [RetencionModule, BoletoModule, PagosModule],
  providers: [ReservaService, ReservaRepository, IdempotenciaRepository, EventosReserva],
  exports: [ReservaService],
})
export class ReservaModule {}
