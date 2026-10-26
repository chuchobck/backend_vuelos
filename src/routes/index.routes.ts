import { Routes } from '@nestjs/core';
import { administradoresRoutes } from '../modules/auth/administradores/administradores.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { saludRoutes } from '../modules/salud/salud.routes';
import { v2Routes } from '../modules/vuelos/v2/v2.routes';
import { vuelosRoutes } from '../modules/vuelos/vuelos.routes';

/** Prefijo global: es la base del `servers` del contrato (.../flights/v1). */
export const PREFIJO_GLOBAL = 'flights';

/** Versión por defecto de todo controller; una v2 se agrega con @Version('2'). */
export const VERSION_POR_DEFECTO = '1';

/**
 * Rutas de la fachada del contrato v2 (/api/v2/vuelos/...): fuera del prefijo global y sin la
 * versión en la URL (sus controllers son VERSION_NEUTRAL). Formato de setGlobalPrefix({ exclude }).
 */
export const RUTAS_FUERA_DEL_PREFIJO = ['api/v2/(.*)'];

/**
 * Única tabla de rutas de la API. Junta los *.routes.ts de cada módulo; los controllers
 * no llevan prefijo propio. Toda ruta queda en /flights/v1/<path>, salvo las del contrato v2,
 * que quedan en /api/v2/vuelos/<path>.
 */
export const rutas: Routes = [
  ...saludRoutes,
  ...authRoutes,
  ...administradoresRoutes,
  ...vuelosRoutes,
  ...v2Routes,
];
