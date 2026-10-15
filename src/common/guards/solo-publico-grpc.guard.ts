import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ES_PUBLICO } from '../decorators/publico.decorator';
import { noAutenticado } from '../../modules/auth/errores-auth';

/**
 * En gRPC no corre JwtAuthGuard y el servidor todavía no recibe tokens: solo atiende las RPC
 * marcadas con @Publico() (las tres lecturas públicas del contrato). Cualquier otra responde
 * UNAUTHENTICATED, así una RPC nueva que no declare su seguridad queda cerrada, como una ruta
 * HTTP sin @Publico(). Lo pone @ControladorGrpc.
 */
@Injectable()
export class GuardSoloPublicoGrpc implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(contexto: ExecutionContext): boolean {
    const esPublico = this.reflector.getAllAndOverride<boolean>(ES_PUBLICO, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (esPublico) return true;
    throw noAutenticado(
      'This RPC requires an access token, which the gRPC server does not accept yet',
    );
  }
}
