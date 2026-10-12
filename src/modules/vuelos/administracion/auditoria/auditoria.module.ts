import { Module } from '@nestjs/common';
import { AuditoriaController } from './auditoria.controller';
import { AuditoriaRepository } from './auditoria.repository';
import { AuditoriaService } from './auditoria.service';

@Module({
  controllers: [AuditoriaController],
  providers: [AuditoriaService, AuditoriaRepository],
})
export class AuditoriaModule {}
