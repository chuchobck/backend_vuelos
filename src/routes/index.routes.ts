import { Routes } from '@nestjs/core';
import { saludRoutes } from '../modules/salud/salud.routes';
import { vuelosRoutes } from '../modules/vuelos/vuelos.routes';

/** Prefijo global: es la base del `servers` del contrato (.../flights/v1). */
export const PREFIJO_GLOBAL = 'flights';

/** Versión por defecto de todo controller; una v2 se agrega con @Version('2'). */
export const VERSION_POR_DEFECTO = '1';

/**
 * Única tabla de rutas de la API. Junta los *.routes.ts de cada módulo; los controllers
 * no llevan prefijo propio. Toda ruta queda en /flights/v1/<path>.
 */
export const rutas: Routes = [...saludRoutes, ...vuelosRoutes];
