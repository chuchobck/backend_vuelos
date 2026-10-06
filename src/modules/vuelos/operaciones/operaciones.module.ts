import { Module } from '@nestjs/common';
import { BusquedaModule } from './busqueda/busqueda.module';
import { OfertaModule } from './oferta/oferta.module';
import { ReservaModule } from './reserva/reserva.module';
import { RetencionModule } from './retencion/retencion.module';

/** Operaciones del contrato (fases 5 a 10). Las rutas cuelgan de /flights/v1 directamente. */
// RetencionModule antes que OfertaModule: Nest registra las rutas en el orden de los módulos.
@Module({ imports: [BusquedaModule, RetencionModule, OfertaModule, ReservaModule] })
export class OperacionesModule {}
