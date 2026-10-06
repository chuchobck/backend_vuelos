import { Module } from '@nestjs/common';
import { WebhookModule } from '../../operaciones/webhook/webhook.module';
import { MapaAsientosModule } from '../mapa-asientos/mapa-asientos.module';
import { VueloModule } from '../vuelo/vuelo.module';
import { VueloProgramadoController } from './vuelo-programado.controller';
import { VueloProgramadoRepository } from './vuelo-programado.repository';
import { VueloProgramadoService } from './vuelo-programado.service';

/** Los cupos por cabina (inventario_cabina) no tienen controller: van con la salida. */
@Module({
  imports: [VueloModule, MapaAsientosModule, WebhookModule],
  controllers: [VueloProgramadoController],
  providers: [VueloProgramadoService, VueloProgramadoRepository],
  exports: [VueloProgramadoRepository],
})
export class VueloProgramadoModule {}
