import { Module } from '@nestjs/common';
import { BoletoModule } from '../operaciones/boleto/boleto.module';
import { BusquedaModule } from '../operaciones/busqueda/busqueda.module';
import { CambioFechaModule } from '../operaciones/cambio-fecha/cambio-fecha.module';
import { CancelacionModule } from '../operaciones/cancelacion/cancelacion.module';
import { CheckinModule } from '../operaciones/checkin/checkin.module';
import { EquipajeModule } from '../operaciones/equipaje/equipaje.module';
import { EstadoVueloModule } from '../operaciones/estado-vuelo/estado-vuelo.module';
import { OfertaModule } from '../operaciones/oferta/oferta.module';
import { PaseAbordarModule } from '../operaciones/pase-abordar/pase-abordar.module';
import { ReservaModule } from '../operaciones/reserva/reserva.module';
import { RetencionModule } from '../operaciones/retencion/retencion.module';
import { FachadaV2Repository } from './fachada-v2.repository';
import { FachadaV2Service } from './fachada-v2.service';
import { PostventaV2Controller } from './postventa.v2.controller';
import { ReservasV2Controller } from './reservas.v2.controller';
import { SaludV2Repository } from './salud/salud-v2.repository';
import { SaludV2Service } from './salud/salud-v2.service';
import { VuelosV2Controller } from './vuelos.v2.controller';

/**
 * La fachada del contrato v2 (RDA2) en /api/v2/vuelos: tres controllers, uno por microservicio
 * de respuesta del contrato (MS.Vuelos, MS.Reservas, MS.Postventa), sobre los mismos services
 * de v1. Las rutas están en v2.routes.ts; /flights/v1 no cambia.
 */
@Module({
  imports: [
    BusquedaModule,
    OfertaModule,
    EstadoVueloModule,
    RetencionModule,
    ReservaModule,
    BoletoModule,
    CheckinModule,
    PaseAbordarModule,
    EquipajeModule,
    CambioFechaModule,
    CancelacionModule,
  ],
  controllers: [VuelosV2Controller, ReservasV2Controller, PostventaV2Controller],
  providers: [FachadaV2Service, FachadaV2Repository, SaludV2Service, SaludV2Repository],
})
export class FachadaV2Module {}
