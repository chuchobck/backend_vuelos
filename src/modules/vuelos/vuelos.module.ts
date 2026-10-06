import { Module } from '@nestjs/common';
import { CatalogoModule } from './catalogo/catalogo.module';

/** Agrupa los submódulos de vuelos: el catálogo (fase 4) y las operaciones del contrato. */
@Module({ imports: [CatalogoModule] })
export class VuelosModule {}
