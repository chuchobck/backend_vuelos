import { Module } from '@nestjs/common';
import { AerolineaController } from './aerolinea.controller';
import { AerolineaRepository } from './aerolinea.repository';
import { AerolineaService } from './aerolinea.service';

@Module({
  controllers: [AerolineaController],
  providers: [AerolineaService, AerolineaRepository],
  exports: [AerolineaRepository],
})
export class AerolineaModule {}
