import { Module } from '@nestjs/common';
import { CancelacionModule } from '../../operaciones/cancelacion/cancelacion.module';
import { ReservaModule } from '../../operaciones/reserva/reserva.module';
import { ReservaAdminController } from './reserva-admin.controller';
import { ReservaAdminRepository } from './reserva-admin.repository';
import { ReservaAdminService } from './reserva-admin.service';

@Module({
  imports: [ReservaModule, CancelacionModule],
  controllers: [ReservaAdminController],
  providers: [ReservaAdminService, ReservaAdminRepository],
})
export class ReservaAdminModule {}
