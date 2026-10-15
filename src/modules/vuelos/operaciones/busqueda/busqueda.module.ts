import { Module } from '@nestjs/common';
import { BusquedaController } from './busqueda.controller';
import { BusquedaGrpc } from './busqueda.grpc';
import { BusquedaRepository } from './busqueda.repository';
import { BusquedaService } from './busqueda.service';

/**
 * POST /search (contrato) y SearchFlights (gRPC). Las ofertas e itinerarios que guarda no tienen
 * controller propio.
 */
@Module({
  controllers: [BusquedaController, BusquedaGrpc],
  providers: [BusquedaService, BusquedaRepository],
  exports: [BusquedaService],
})
export class BusquedaModule {}
