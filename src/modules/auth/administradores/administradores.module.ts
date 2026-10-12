import { Module } from '@nestjs/common';
import { AuthModule } from '../auth.module';
import { AdministradoresController } from './administradores.controller';
import { AdministradoresRepository } from './administradores.repository';
import { AdministradoresService } from './administradores.service';

/** /admin/users: altas, lista y bajas de administradores (fuera del contrato, `flights:admin`). */
@Module({
  imports: [AuthModule],
  controllers: [AdministradoresController],
  providers: [AdministradoresService, AdministradoresRepository],
})
export class AdministradoresModule {}
