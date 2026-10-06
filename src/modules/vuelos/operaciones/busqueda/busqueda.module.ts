import { Module } from '@nestjs/common';
import { BusquedaController } from './busqueda.controller';
import { BusquedaRepository } from './busqueda.repository';
import { BusquedaService } from './busqueda.service';

/** POST /search (contrato). Las ofertas e itinerarios que guarda no tienen controller propio. */
@Module({
  controllers: [BusquedaController],
  providers: [BusquedaService, BusquedaRepository],
  exports: [BusquedaService],
})
export class BusquedaModule {}
