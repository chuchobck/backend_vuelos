import { Module } from '@nestjs/common';
import { EstadoVueloController } from './estado-vuelo.controller';
import { EstadoVueloRepository } from './estado-vuelo.repository';
import { EstadoVueloService } from './estado-vuelo.service';

/** GET /flights/{flightNumber}/status (contrato), público. Solo lectura. */
@Module({
  controllers: [EstadoVueloController],
  providers: [EstadoVueloService, EstadoVueloRepository],
})
export class EstadoVueloModule {}
