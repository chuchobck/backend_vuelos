import { GrpcMethod, Payload } from '@nestjs/microservices';
import { ControladorGrpc } from '../../../../common/decorators/controlador-grpc.decorator';
import { Publico } from '../../../../common/decorators/publico.decorator';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { SERVICIO_GRPC } from '../../../../config/grpc';
import { aEnumProto } from '../../compartido/enums';
import { MapaAsientosOfertaDto } from './dto/mapa-asientos-oferta.dto';
import { aMapaAsientosOferta } from './oferta.mapper';
import { OfertaService } from './oferta.service';

/** GetSeatMap: GET /offers/{offerId}/seatmap por gRPC, con los mismos pipes, service y mapper. */
@ControladorGrpc()
export class OfertaGrpc {
  constructor(private readonly servicio: OfertaService) {}

  @Publico()
  @GrpcMethod(SERVICIO_GRPC, 'GetSeatMap')
  async mapaDeAsientos(
    @Payload('offerId', UuidPipe) offerId: string,
    @Payload('segmentId', UuidPipe) segmentId: string,
  ): Promise<object> {
    return aMensajeMapa(
      aMapaAsientosOferta(await this.servicio.mapaDeAsientos(offerId, segmentId)),
    );
  }
}

/** SeatMapResponse → GetSeatMapResponse: solo cambian los enums. */
function aMensajeMapa(mapa: MapaAsientosOfertaDto): object {
  return {
    ...mapa,
    cabins: mapa.cabins.map((cabina) => ({
      ...cabina,
      cabinClass: aEnumProto('CABIN_CLASS', cabina.cabinClass),
      rows: cabina.rows.map((fila) => ({
        ...fila,
        seats: fila.seats.map((asiento) => ({
          ...asiento,
          characteristics: asiento.characteristics.map((c) => aEnumProto('SEAT_CHARACTERISTIC', c)),
        })),
      })),
    })),
  };
}
