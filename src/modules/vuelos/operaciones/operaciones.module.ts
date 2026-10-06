import { Module } from '@nestjs/common';
import { BusquedaModule } from './busqueda/busqueda.module';
import { CambioFechaModule } from './cambio-fecha/cambio-fecha.module';
import { CancelacionModule } from './cancelacion/cancelacion.module';
import { EquipajeModule } from './equipaje/equipaje.module';
import { OfertaModule } from './oferta/oferta.module';
import { PendientesPostventa } from './pendientes-postventa';
import { ReservaModule } from './reserva/reserva.module';
import { RetencionModule } from './retencion/retencion.module';

/** Operaciones del contrato (fases 5 a 10). Las rutas cuelgan de /flights/v1 directamente. */
// RetencionModule antes que OfertaModule: Nest registra las rutas en el orden de los módulos.
@Module({
  imports: [
    BusquedaModule,
    RetencionModule,
    OfertaModule,
    ReservaModule,
    EquipajeModule,
    CancelacionModule,
    CambioFechaModule,
  ],
  // El proceso periódico de postventa usa los tres módulos de postventa a la vez
  providers: [PendientesPostventa],
})
export class OperacionesModule {}
