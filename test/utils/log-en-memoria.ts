import { LoggerService } from '@nestjs/common';

/** Todo lo que la API escribe en el log mientras corre una suite, para revisarlo al final. */
export class LogEnMemoria implements LoggerService {
  readonly lineas: string[] = [];

  log(mensaje: unknown, ...resto: unknown[]) {
    this.guardar('LOG', mensaje, resto);
  }
  warn(mensaje: unknown, ...resto: unknown[]) {
    this.guardar('WARN', mensaje, resto);
  }
  error(mensaje: unknown, ...resto: unknown[]) {
    this.guardar('ERROR', mensaje, resto);
  }
  debug(mensaje: unknown, ...resto: unknown[]) {
    this.guardar('DEBUG', mensaje, resto);
  }
  verbose(mensaje: unknown, ...resto: unknown[]) {
    this.guardar('VERBOSE', mensaje, resto);
  }

  texto(): string {
    return this.lineas.join('\n');
  }

  private guardar(nivel: string, mensaje: unknown, resto: unknown[]) {
    const extra = resto.map((r) => (r instanceof Error ? `${r.message} ${r.stack}` : String(r)));
    this.lineas.push([nivel, String(mensaje), ...extra].join(' '));
  }
}
