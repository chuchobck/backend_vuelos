import { Module } from '@nestjs/common';
import { OfertaController } from './oferta.controller';
import { OfertaGrpc } from './oferta.grpc';
import { OfertaRepository } from './oferta.repository';
import { OfertaService } from './oferta.service';

/**
 * /offers/{offerId}/seatmap (contrato) y GetSeatMap (gRPC). El hold va en retencion, bajo
 * /offers/hold.
 */
@Module({
  controllers: [OfertaController, OfertaGrpc],
  providers: [OfertaService, OfertaRepository],
})
export class OfertaModule {}
