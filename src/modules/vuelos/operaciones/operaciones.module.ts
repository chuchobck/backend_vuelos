import { Module } from '@nestjs/common';
import { BusquedaModule } from './busqueda/busqueda.module';

/** Operaciones del contrato (fases 5 a 10). Las rutas cuelgan de /flights/v1 directamente. */
@Module({ imports: [BusquedaModule] })
export class OperacionesModule {}
