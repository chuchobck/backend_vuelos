import { GrpcMethod, Payload } from '@nestjs/microservices';
import { ControladorGrpc } from '../../../../common/decorators/controlador-grpc.decorator';
import { Publico } from '../../../../common/decorators/publico.decorator';
import { NumeroVueloPipe } from '../../../../common/pipes/codigo-iata.pipe';
import { FechaPipe } from '../../../../common/pipes/fecha.pipe';
import { SERVICIO_GRPC } from '../../../../config/grpc';
import { aEnumProto } from '../../compartido/enums';
import { aEstadoVuelo } from './estado-vuelo.mapper';
import { EstadoVueloService } from './estado-vuelo.service';

/**
 * GetFlightStatus: GET /flights/{flightNumber}/status por gRPC, con los mismos pipes, service y
 * mapper.
 */
@ControladorGrpc()
export class EstadoVueloGrpc {
  constructor(private readonly servicio: EstadoVueloService) {}

  @Publico()
  @GrpcMethod(SERVICIO_GRPC, 'GetFlightStatus')
  async estado(
    @Payload('flightNumber', NumeroVueloPipe) flightNumber: string,
    @Payload('date', FechaPipe) date: Date,
  ): Promise<object> {
    const estado = aEstadoVuelo(await this.servicio.consultar(flightNumber, date));
    // FlightStatus → GetFlightStatusResponse: solo cambia el enum
    return { ...estado, status: aEnumProto('FLIGHT_STATUS', estado.status) };
  }
}
