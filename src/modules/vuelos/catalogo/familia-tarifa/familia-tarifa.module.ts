import { Module } from '@nestjs/common';
import { AerolineaModule } from '../aerolinea/aerolinea.module';
import { FamiliaTarifaController } from './familia-tarifa.controller';
import { FamiliaTarifaRepository } from './familia-tarifa.repository';
import { FamiliaTarifaService } from './familia-tarifa.service';

@Module({
  imports: [AerolineaModule],
  controllers: [FamiliaTarifaController],
  providers: [FamiliaTarifaService, FamiliaTarifaRepository],
  exports: [FamiliaTarifaRepository],
})
export class FamiliaTarifaModule {}
