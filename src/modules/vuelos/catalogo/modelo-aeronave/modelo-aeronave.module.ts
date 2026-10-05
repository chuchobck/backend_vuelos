import { Module } from '@nestjs/common';
import { ModeloAeronaveController } from './modelo-aeronave.controller';
import { ModeloAeronaveRepository } from './modelo-aeronave.repository';
import { ModeloAeronaveService } from './modelo-aeronave.service';

@Module({
  controllers: [ModeloAeronaveController],
  providers: [ModeloAeronaveService, ModeloAeronaveRepository],
  exports: [ModeloAeronaveRepository],
})
export class ModeloAeronaveModule {}
