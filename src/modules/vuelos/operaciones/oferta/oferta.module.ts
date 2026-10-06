import { Module } from '@nestjs/common';
import { OfertaController } from './oferta.controller';
import { OfertaRepository } from './oferta.repository';
import { OfertaService } from './oferta.service';

/** /offers/{offerId}/seatmap (contrato). El hold va en retencion, bajo /offers/hold. */
@Module({
  controllers: [OfertaController],
  providers: [OfertaService, OfertaRepository],
})
export class OfertaModule {}
