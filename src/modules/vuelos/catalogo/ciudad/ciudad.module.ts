import { Module } from '@nestjs/common';
import { PaisModule } from '../pais/pais.module';
import { CiudadController } from './ciudad.controller';
import { CiudadRepository } from './ciudad.repository';
import { CiudadService } from './ciudad.service';

@Module({
  imports: [PaisModule],
  controllers: [CiudadController],
  providers: [CiudadService, CiudadRepository],
  exports: [CiudadRepository],
})
export class CiudadModule {}
