import { Metadata, ServerUnaryCall, StatusObject } from '@grpc/grpc-js';
import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { codigoGrpc } from '../errores/codigo-grpc';
import { ErrorNegocio } from '../errores/error-negocio';
import { traducirExcepcion } from '../errores/traducir-excepcion';
import { resumir } from './problem-details.filter';

/** Metadata de una respuesta de error gRPC. */
export const METADATA_ERROR = {
  /** El `code` de ProblemDetails (VALIDATION_FAILED, OFFER_NO_LONGER_AVAILABLE...). */
  codigo: 'problem-code',
  /** El status HTTP que tendría la misma petición en REST. */
  status: 'problem-status',
  /** El ProblemDetails completo en JSON (UTF-8), con `invalidParams` si los hay. */
  problema: 'problem-details-bin',
} as const;

/** Lo que admite una metadata que no es binaria: ASCII visible. */
const TEXTO_METADATA = /^[\x20-\x7e]*$/;

/**
 * El filtro de errores de los controladores gRPC (lo pone @ControladorGrpc). Traduce el error
 * con la misma función que el filtro HTTP (`traducirExcepcion`): el mismo ProblemDetails que
 * daría REST, que sale como un status gRPC (`codigoGrpc`) con el `code` en la metadata.
 *
 * El `details` del status es el `detail` del ProblemDetails (o su título): nunca el mensaje
 * interno ni el stack, que en un 5xx se quedan en el log. Las cabeceras del error en REST
 * (Retry-After) van como metadata en minúsculas.
 */
@Catch()
export class FiltroErroresGrpc implements ExceptionFilter {
  private readonly logger = new Logger('Errores');

  catch(excepcion: unknown, host: ArgumentsHost): Observable<never> {
    const llamada = host.getArgByIndex<ServerUnaryCall<unknown, unknown> | undefined>(2);
    const metodo = llamada?.getPath?.() ?? 'gRPC';
    const { problema, cabeceras, esErrorInterno, causa } = traducirExcepcion(excepcion, {
      metodo: 'gRPC',
      ruta: metodo,
      metodosPermitidos: [],
    });

    if (esErrorInterno) {
      // El stack se queda en el log; al cliente solo llega el código y el título.
      const detalle = causa instanceof Error ? (causa.stack ?? causa.message) : String(causa);
      this.logger.error(`${metodo} → ${problema.status}\n${detalle}`);
    } else {
      const origen =
        causa instanceof Error && !(causa instanceof ErrorNegocio) ? ` (${resumir(causa)})` : '';
      this.logger.debug(`${metodo} → ${problema.status} ${problema.code}${origen}`);
    }

    const metadata = new Metadata();
    metadata.set(METADATA_ERROR.codigo, problema.code);
    metadata.set(METADATA_ERROR.status, String(problema.status));
    metadata.set(METADATA_ERROR.problema, Buffer.from(JSON.stringify(problema), 'utf8'));
    for (const [nombre, valor] of Object.entries(cabeceras)) {
      if (TEXTO_METADATA.test(valor)) metadata.set(nombre.toLowerCase(), valor);
    }

    const estado: StatusObject = {
      code: codigoGrpc(problema.status),
      details: problema.detail ?? problema.title,
      metadata,
    };
    return throwError(() => estado);
  }
}
