import { Module } from '@nestjs/common';
import { TableroSalidasController } from './tablero-salidas.controller';
import { TableroSalidasRepository } from './tablero-salidas.repository';
import { TableroSalidasService } from './tablero-salidas.service';

/** GET /airports/{iataCode}/departures (fase F1, fuera del contrato), público. Solo lectura. */
@Module({
  controllers: [TableroSalidasController],
  providers: [TableroSalidasService, TableroSalidasRepository],
})
export class TableroSalidasModule {}
