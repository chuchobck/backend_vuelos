import { Routes } from '@nestjs/core';
import { FachadaV2Module } from './v2.module';

/** Base de la fachada v2, sin el prefijo global (`flights`) ni la versión en la URL. */
export const RUTA_V2 = 'api/v2/vuelos';

/** Todas las rutas del contrato v2 cuelgan de /api/v2/vuelos (ver configurar-app.ts). */
export const v2Routes: Routes = [{ path: RUTA_V2, module: FachadaV2Module }];
