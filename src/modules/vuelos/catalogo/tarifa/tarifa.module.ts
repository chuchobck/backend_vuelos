import { Module } from '@nestjs/common';
import { FamiliaTarifaModule } from '../familia-tarifa/familia-tarifa.module';
import { VueloProgramadoModule } from '../vuelo-programado/vuelo-programado.module';
import { TarifaController } from './tarifa.controller';
import { TarifaRepository } from './tarifa.repository';
import { TarifaService } from './tarifa.service';

/** Los precios por tipo de pasajero (tarifa_detalle) no tienen controller: van con la tarifa. */
@Module({
  imports: [VueloProgramadoModule, FamiliaTarifaModule],
  controllers: [TarifaController],
  providers: [TarifaService, TarifaRepository],
})
export class TarifaModule {}
