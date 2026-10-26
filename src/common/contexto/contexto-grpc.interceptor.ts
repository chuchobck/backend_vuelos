import { Metadata } from '@grpc/grpc-js';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { ejecutarEnContexto } from './contexto-peticion';
import { METADATA_CORRELACION } from './correlation-id';
import {
  contextoDeLlamada,
  LlamadaGrpc,
  METADATA_REQUEST_ID,
  registrarLlamada,
} from './contexto-grpc';

/**
 * Lo que en HTTP hacen los middlewares de contexto, para una llamada gRPC (lo pone
 * @ControladorGrpc): abre el mismo AsyncLocalStorage con el request id de la metadata, así el
 * log de los pipes, el service y Prisma lleva ese id; lo devuelve en la metadata inicial de la
 * respuesta (como X-Request-Id), junto con el x-correlation-id, y deja la línea de acceso. La de un error la deja el filtro.
 */
@Injectable()
export class InterceptorContextoGrpc implements NestInterceptor {
  intercept(contexto: ExecutionContext, siguiente: CallHandler): Observable<unknown> {
    const llamada = contexto.getArgByIndex<LlamadaGrpc>(2);
    const datos = contextoDeLlamada(llamada);

    const metadata = new Metadata();
    metadata.set(METADATA_REQUEST_ID, datos.contexto.requestId);
    metadata.set(METADATA_CORRELACION, datos.contexto.correlationId);
    llamada.sendMetadata(metadata);

    // handle() se llama dentro del contexto: Nest enlaza ahí (AsyncResource) el pipe y el handler
    return ejecutarEnContexto(datos.contexto, () => siguiente.handle()).pipe(
      tap(() => registrarLlamada(datos, 'OK')),
    );
  }
}
