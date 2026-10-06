import { Module } from '@nestjs/common';
import { AerolineaModule } from '../aerolinea/aerolinea.module';
import { ModeloAeronaveModule } from '../modelo-aeronave/modelo-aeronave.module';
import { MapaAsientosController } from './mapa-asientos.controller';
import { MapaAsientosRepository } from './mapa-asientos.repository';
import { MapaAsientosService } from './mapa-asientos.service';

/** Los asientos físicos (mapa_asientos_detalle y asiento) no tienen controller: van con el mapa. */
@Module({
  imports: [AerolineaModule, ModeloAeronaveModule],
  controllers: [MapaAsientosController],
  providers: [MapaAsientosService, MapaAsientosRepository],
  exports: [MapaAsientosRepository],
})
export class MapaAsientosModule {}
