import { Routes } from '@nestjs/core';
import { EstadoVueloModule } from './estado-vuelo.module';

/** /flights/v1/flights/{flightNumber}/status: el segundo `flights` es el del contrato. */
export const estadoVueloRoutes: Routes = [{ path: 'flights', module: EstadoVueloModule }];
