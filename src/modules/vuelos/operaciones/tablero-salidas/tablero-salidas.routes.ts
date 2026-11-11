import { Routes } from '@nestjs/core';
import { TableroSalidasModule } from './tablero-salidas.module';

/** /flights/v1/airports/{iataCode}/departures (el catálogo de aeropuertos vive en /admin/airports). */
export const tableroSalidasRoutes: Routes = [{ path: 'airports', module: TableroSalidasModule }];
