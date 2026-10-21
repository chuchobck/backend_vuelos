import { ConsoleLogger } from '@nestjs/common';
import { obtenerContexto } from '../contexto/contexto-peticion';
import { camposDeTraza } from '../../observabilidad/trazas';

/**
 * El logger de Nest con el X-Request-Id y la traza (traceId y spanId) de la petición en curso en
 * cada línea, venga de donde venga (un service, Prisma, el filtro de errores, una corrida de un
 * proceso periódico):
 *
 *   [Nest] 1234  - 10/05/2026, 3:00:00 PM     LOG [HTTP] [8d1f...] [traceId=4bf9... spanId=00f0...] GET /flights/v1/health 200 3.1ms
 *
 * El span es el activo (el de una operación de negocio, si hay uno); si ya no hay contexto de
 * OpenTelemetry (la línea de acceso se escribe al terminar la respuesta), el SERVER de la petición.
 * Fuera de una petición o una corrida (arranque) imprime igual que ConsoleLogger.
 */
export class LoggerPorPeticion extends ConsoleLogger {
  protected formatContext(contexto: string): string {
    const peticion = obtenerContexto();
    const activa = camposDeTraza();
    const traza = activa.traceId !== undefined ? activa : peticion?.traza;
    let linea = super.formatContext(contexto);
    if (peticion?.requestId !== undefined) linea += `[${peticion.requestId}] `;
    if (traza?.traceId !== undefined) linea += `[traceId=${traza.traceId} spanId=${traza.spanId}] `;
    return linea;
  }
}
