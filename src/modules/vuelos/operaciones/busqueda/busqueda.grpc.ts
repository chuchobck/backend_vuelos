import { GrpcMethod, Payload } from '@nestjs/microservices';
import { ControladorGrpc } from '../../../../common/decorators/controlador-grpc.decorator';
import { HuellaDispositivo } from '../../../../common/decorators/huella-dispositivo.decorator';
import { Publico } from '../../../../common/decorators/publico.decorator';
import { SERVICIO_GRPC } from '../../../../config/grpc';
import { aEnumProto } from '../../compartido/enums';
import { aRespuestaBusqueda } from './busqueda.mapper';
import { BusquedaService } from './busqueda.service';
import { RespuestaBusquedaDto } from './dto/respuesta-busqueda.dto';
import { SolicitudBusquedaDto } from './dto/solicitud-busqueda.dto';

/**
 * SearchFlights: POST /search por gRPC, con el mismo DTO, service y mapper. La huella llega en
 * la metadata x-device-fingerprint.
 */
@ControladorGrpc()
export class BusquedaGrpc {
  constructor(private readonly servicio: BusquedaService) {}

  @Publico()
  @GrpcMethod(SERVICIO_GRPC, 'SearchFlights')
  async buscar(
    @HuellaDispositivo() huella: string,
    @Payload() solicitud: SolicitudBusquedaDto,
  ): Promise<object> {
    return aMensajeBusqueda(aRespuestaBusqueda(await this.servicio.buscar(solicitud, huella)));
  }
}

/** SearchResponse → SearchFlightsResponse: solo cambian los enums. */
function aMensajeBusqueda(respuesta: RespuestaBusquedaDto): object {
  return {
    ...respuesta,
    offers: respuesta.offers.map((oferta) => ({
      ...oferta,
      itineraries: oferta.itineraries.map((itinerario) => ({
        ...itinerario,
        segments: itinerario.segments.map((segmento) => ({
          ...segmento,
          status: aEnumProto('FLIGHT_STATUS', segmento.status),
        })),
        pricingOptions: itinerario.pricingOptions.map((opcion) => ({
          ...opcion,
          cabinClass: aEnumProto('CABIN_CLASS', opcion.cabinClass),
          pricePerPassengerType: opcion.pricePerPassengerType.map((precio) => ({
            ...precio,
            passengerType: aEnumProto('PASSENGER_TYPE', precio.passengerType),
          })),
        })),
      })),
    })),
  };
}
