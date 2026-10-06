import { Module } from '@nestjs/common';
import { AerolineaModule } from '../aerolinea/aerolinea.module';
import { AeropuertoModule } from '../aeropuerto/aeropuerto.module';
import { VueloController } from './vuelo.controller';
import { VueloRepository } from './vuelo.repository';
import { VueloService } from './vuelo.service';

@Module({
  imports: [AerolineaModule, AeropuertoModule],
  controllers: [VueloController],
  providers: [VueloService, VueloRepository],
  exports: [VueloRepository],
})
export class VueloModule {}
