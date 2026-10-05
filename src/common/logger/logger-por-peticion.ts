import { ConsoleLogger } from '@nestjs/common';
import { obtenerContexto } from '../contexto/contexto-peticion';

/**
 * El logger de Nest con el X-Request-Id de la petición en curso en cada línea, venga de donde
 * venga (un service, Prisma, el filtro de errores):
 *
 *   [Nest] 1234  - 10/05/2026, 3:00:00 PM     LOG [HTTP] [8d1f...] GET /flights/v1/health 200 3.1ms
 *
 * Fuera de una petición (arranque, tareas) imprime igual que ConsoleLogger.
 */
export class LoggerPorPeticion extends ConsoleLogger {
  protected formatContext(contexto: string): string {
    const requestId = obtenerContexto()?.requestId;
    const base = super.formatContext(contexto);
    return requestId === undefined ? base : `${base}[${requestId}] `;
  }
}
