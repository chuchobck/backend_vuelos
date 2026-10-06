import { Module } from '@nestjs/common';
import { BusquedaModule } from './busqueda/busqueda.module';
import { OfertaModule } from './oferta/oferta.module';

/** Operaciones del contrato (fases 5 a 10). Las rutas cuelgan de /flights/v1 directamente. */
@Module({ imports: [BusquedaModule, OfertaModule] })
export class OperacionesModule {}
