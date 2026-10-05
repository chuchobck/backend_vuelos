import { Module } from '@nestjs/common';
import { PaisController } from './pais.controller';
import { PaisRepository } from './pais.repository';
import { PaisService } from './pais.service';

@Module({
  controllers: [PaisController],
  providers: [PaisService, PaisRepository],
  exports: [PaisRepository],
})
export class PaisModule {}
