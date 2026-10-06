import { Module } from '@nestjs/common';
import { BusquedaModule } from './busqueda/busqueda.module';
import { CambioFechaModule } from './cambio-fecha/cambio-fecha.module';
import { CancelacionModule } from './cancelacion/cancelacion.module';
import { CheckinModule } from './checkin/checkin.module';
import { EquipajeModule } from './equipaje/equipaje.module';
import { EstadoVueloModule } from './estado-vuelo/estado-vuelo.module';
import { OfertaModule } from './oferta/oferta.module';
import { PaseAbordarModule } from './pase-abordar/pase-abordar.module';
import { PendientesPostventa } from './pendientes-postventa';
import { ReservaModule } from './reserva/reserva.module';
import { WebhookModule } from './webhook/webhook.module';
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
    CheckinModule,
    PaseAbordarModule,
    EstadoVueloModule,
    WebhookModule,
  ],
  // El proceso periódico de postventa usa los tres módulos de postventa a la vez
  providers: [PendientesPostventa],
})
export class OperacionesModule {}
