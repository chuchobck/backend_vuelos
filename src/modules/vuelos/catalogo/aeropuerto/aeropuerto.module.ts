import { Module } from '@nestjs/common';
import { CiudadModule } from '../ciudad/ciudad.module';
import { AeropuertoController } from './aeropuerto.controller';
import { AeropuertoRepository } from './aeropuerto.repository';
import { AeropuertoService } from './aeropuerto.service';

@Module({
  imports: [CiudadModule],
  controllers: [AeropuertoController],
  providers: [AeropuertoService, AeropuertoRepository],
  exports: [AeropuertoRepository],
})
export class AeropuertoModule {}
