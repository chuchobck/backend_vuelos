import { Module } from '@nestjs/common';
import { EstadoVueloController } from './estado-vuelo.controller';
import { EstadoVueloGrpc } from './estado-vuelo.grpc';
import { EstadoVueloRepository } from './estado-vuelo.repository';
import { EstadoVueloService } from './estado-vuelo.service';

/** GET /flights/{flightNumber}/status (contrato) y GetFlightStatus (gRPC), públicos. Solo lectura. */
@Module({
  controllers: [EstadoVueloController, EstadoVueloGrpc],
  providers: [EstadoVueloService, EstadoVueloRepository],
})
export class EstadoVueloModule {}
