import {
  Controller,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  applyDecorators,
} from '@nestjs/common';
import { InterceptorContextoGrpc } from '../contexto/contexto-grpc.interceptor';
import { FiltroErroresGrpc } from '../filters/errores-grpc.filter';
import { GuardSoloPublicoGrpc } from '../guards/solo-publico-grpc.guard';
import { crearPipeValidacion } from '../pipes/validacion.pipe';

/**
 * Un controlador gRPC (los `<entidad>.grpc.ts`): `@Controller()` más lo que en HTTP es global y
 * en gRPC no corre, porque el microservicio no hereda la configuración de la app HTTP
 * (src/config/grpc.ts):
 *
 * - GuardSoloPublicoGrpc: sin token en gRPC, solo se atienden las RPC con @Publico().
 * - InterceptorContextoGrpc: el request id de la metadata en el contexto y en el log.
 * - FiltroErroresGrpc: un error sale como status gRPC con el ProblemDetails de REST.
 * - El pipe de validación de REST.
 *
 * Sin límite de peticiones: el puerto es interno y su único cliente es el BFF, que pone los
 * límites por usuario (ver docs/GRPC.md).
 *
 *   @ControladorGrpc()
 *   export class EstadoVueloGrpc {
 *     @Publico()
 *     @GrpcMethod(SERVICIO_GRPC, 'GetFlightStatus')
 *     estado(@Payload('date', FechaPipe) date: Date) {}
 *   }
 */
export function ControladorGrpc(): ClassDecorator {
  return applyDecorators(
    Controller(),
    UseGuards(GuardSoloPublicoGrpc),
    UseInterceptors(InterceptorContextoGrpc),
    UseFilters(FiltroErroresGrpc),
    UsePipes(crearPipeValidacion()),
  );
}
