import { Controller, UseFilters, UsePipes, applyDecorators } from '@nestjs/common';
import { FiltroErroresGrpc } from '../filters/errores-grpc.filter';
import { crearPipeValidacion } from '../pipes/validacion.pipe';

/**
 * Un controlador gRPC (los `<entidad>.grpc.ts`): `@Controller()` más lo que en HTTP es global y
 * en gRPC no corre, porque el microservicio no hereda la configuración de la app HTTP
 * (src/config/grpc.ts). Así la entrada se valida con el mismo pipe que en REST y un error sale
 * como un status gRPC con el ProblemDetails de REST en la metadata (FiltroErroresGrpc).
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
    UseFilters(FiltroErroresGrpc),
    UsePipes(crearPipeValidacion()),
  );
}
