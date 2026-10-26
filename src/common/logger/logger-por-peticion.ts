import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { obtenerContexto } from '../contexto/contexto-peticion';
import { CONTEXTO_ACCESO } from './registro-acceso';

/**
 * El logger de Nest con el X-Request-Id de la petición en curso en cada línea y su
 * X-Correlation-Id al final de la primera, venga de donde venga (un service, Prisma, el filtro
 * de errores):
 *
 *   [Nest] 1234  - 10/05/2026, 3:00:00 PM     LOG [HTTP] [8d1f...] GET /flights/v1/health 200 3.1ms [corr=corr-123]
 *
 * La línea de acceso en JSON (contexto `Acceso`) sale sola, sin prefijo ni colores, para que un
 * colector la lea como JSON. Fuera de una petición (arranque, tareas) imprime igual que
 * ConsoleLogger.
 */
export class LoggerPorPeticion extends ConsoleLogger {
  protected formatContext(contexto: string): string {
    const requestId = obtenerContexto()?.requestId;
    const base = super.formatContext(contexto);
    return requestId === undefined ? base : `${base}[${requestId}] `;
  }

  protected formatMessage(
    nivel: LogLevel,
    mensaje: unknown,
    pid: string,
    nivelFormateado: string,
    contexto: string,
    diferencia: string,
  ): string {
    const linea = super.formatMessage(nivel, mensaje, pid, nivelFormateado, contexto, diferencia);
    const correlacion = obtenerContexto()?.correlationId;
    if (correlacion === undefined) return linea;
    // Al final de la primera línea: un stack de varias líneas no la empuja hasta el fondo
    const fin = linea.indexOf('\n');
    return `${linea.slice(0, fin)} [corr=${correlacion}]${linea.slice(fin)}`;
  }

  protected printMessages(
    mensajes: unknown[],
    contexto?: string,
    nivel?: LogLevel,
    salida?: 'stdout' | 'stderr',
  ): void {
    if (contexto !== CONTEXTO_ACCESO) return super.printMessages(mensajes, contexto, nivel, salida);
    for (const mensaje of mensajes) process.stdout.write(`${String(mensaje)}\n`);
  }
}
