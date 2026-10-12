import { Module } from '@nestjs/common';
import { AdministracionModule } from './administracion/administracion.module';
import { CatalogoModule } from './catalogo/catalogo.module';
import { OperacionesModule } from './operaciones/operaciones.module';

/** Agrupa los submódulos de vuelos: el catálogo (fase 4), la administración (auditoría y reservas) y las operaciones del contrato. */
@Module({ imports: [CatalogoModule, AdministracionModule, OperacionesModule] })
export class VuelosModule {}
