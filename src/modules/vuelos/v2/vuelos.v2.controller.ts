import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import {
  CABECERA_HUELLA,
  HuellaDispositivo,
} from '../../../common/decorators/huella-dispositivo.decorator';
import {
  LimiteEstricto,
  SinLimiteDePeticiones,
} from '../../../common/decorators/limite-peticiones.decorator';
import { OperacionContrato } from '../../../common/decorators/operacion.decorator';
import { Publico } from '../../../common/decorators/publico.decorator';
import { NumeroVueloPipe } from '../../../common/pipes/codigo-iata.pipe';
import { FechaPipe } from '../../../common/pipes/fecha.pipe';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { LIMITE_BUSQUEDA } from '../operaciones/busqueda/busqueda.controller';
import { aRespuestaBusqueda } from '../operaciones/busqueda/busqueda.mapper';
import { BusquedaService } from '../operaciones/busqueda/busqueda.service';
import { RespuestaBusquedaDto } from '../operaciones/busqueda/dto/respuesta-busqueda.dto';
import { SolicitudBusquedaDto } from '../operaciones/busqueda/dto/solicitud-busqueda.dto';
import { EstadoVueloDto } from '../operaciones/estado-vuelo/dto/estado-vuelo.dto';
import { LIMITE_ESTADO_VUELO } from '../operaciones/estado-vuelo/estado-vuelo.controller';
import { aEstadoVuelo } from '../operaciones/estado-vuelo/estado-vuelo.mapper';
import { EstadoVueloService } from '../operaciones/estado-vuelo/estado-vuelo.service';
import { LIMITE_MAPA_ASIENTOS } from '../operaciones/oferta/oferta.controller';
import { ApiProblemaV2, ETIQUETAS_V2 } from './documentacion-v2';
import { MapaAsientosV2Dto } from './dto/respuestas-v2.dto';
import { FachadaV2Service } from './fachada-v2.service';
import { SaludV2Dto } from './salud/dto/salud-v2.dto';
import { SaludV2Service } from './salud/salud-v2.service';

/**
 * MS.Vuelos del contrato v2: salud del nodo, búsqueda, mapa de asientos y estado de vuelo. Las
 * cuatro son públicas (sin token) y usan los mismos services, límites y reglas que v1.
 */
@Controller({ version: VERSION_NEUTRAL })
export class VuelosV2Controller {
  constructor(
    private readonly salud: SaludV2Service,
    private readonly busqueda: BusquedaService,
    private readonly fachada: FachadaV2Service,
    private readonly estados: EstadoVueloService,
  ) {}

  @Publico()
  // El Monitor de Nodos de Booking sondea seguido desde la misma IP: un 429 daría el nodo por caído
  @SinLimiteDePeticiones()
  @OperacionContrato('getHealth')
  @Get('health')
  @Header('Cache-Control', 'no-store')
  @ApiTags(ETIQUETAS_V2.telemetria)
  @ApiOperation({
    operationId: 'getHealth',
    summary: 'Salud y telemetría del nodo (semáforo del Monitor de Nodos de Booking)',
    description:
      'Público y sin límite. 200 si el nodo está HEALTHY o DEGRADED (identity o el notifier no ' +
      'responden) y 503 con el mismo cuerpo si está DOWN (la base no responde). Responde en ' +
      'menos de 1 s: cada dependencia tiene 400 ms y el resultado se reusa 5 s.',
  })
  @ApiOkResponse({ type: SaludV2Dto })
  @ApiServiceUnavailableResponse({ type: SaludV2Dto, description: 'Nodo caído (status DOWN)' })
  async revisarSalud(@Res({ passthrough: true }) respuesta: Response): Promise<SaludV2Dto> {
    const salud = await this.salud.revisar();
    if (salud.status === 'DOWN') respuesta.status(503);
    return salud;
  }

  @Publico()
  @LimiteEstricto(LIMITE_BUSQUEDA.limite, LIMITE_BUSQUEDA.ventanaSegundos)
  @OperacionContrato('searchFlights')
  @Post('search')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiTags(ETIQUETAS_V2.vuelos)
  @ApiOperation({
    operationId: 'searchFlights',
    summary: 'Buscar vuelos (ida, ida y vuelta, multidestino)',
    description: 'Igual que POST /flights/v1/search. Sin resultados: 200 con la lista vacía.',
  })
  @ApiHeader({ name: CABECERA_HUELLA, required: true, example: 'fp-3a7c9e21' })
  @ApiOkResponse({ type: RespuestaBusquedaDto })
  @ApiProblemaV2(400, 'Cuerpo inválido, fecha pasada o falta X-Device-Fingerprint')
  @ApiProblemaV2(429, `Más de ${LIMITE_BUSQUEDA.limite} búsquedas por IP en un minuto`)
  async buscar(
    @HuellaDispositivo() huella: string,
    @Body() solicitud: SolicitudBusquedaDto,
  ): Promise<RespuestaBusquedaDto> {
    return aRespuestaBusqueda(await this.busqueda.buscar(solicitud, huella));
  }

  @Publico()
  @LimiteEstricto(LIMITE_MAPA_ASIENTOS.limite, LIMITE_MAPA_ASIENTOS.ventanaSegundos)
  @OperacionContrato('getSeatMap')
  @Get('offers/:offerId/seatmap')
  @ApiTags(ETIQUETAS_V2.vuelos)
  @ApiOperation({
    operationId: 'getSeatMap',
    summary: 'Mapa de asientos de un segmento de la oferta',
    description:
      'El de v1 más `status` por asiento (SeatStatus): AVAILABLE, BOOKED, TICKETED o CHECKED_IN.',
  })
  @ApiQuery({ name: 'segmentId', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ type: MapaAsientosV2Dto })
  @ApiProblemaV2(400, 'offerId o segmentId no son uuid')
  @ApiProblemaV2(404, 'La oferta no existe o venció, o el segmento no es de esa oferta')
  @ApiProblemaV2(429, `Más de ${LIMITE_MAPA_ASIENTOS.limite} mapas por IP en un minuto`)
  async mapaDeAsientos(
    @Param('offerId', UuidPipe) offerId: string,
    @Query('segmentId', UuidPipe) segmentId: string,
  ): Promise<MapaAsientosV2Dto> {
    return this.fachada.mapaDeAsientos(offerId, segmentId);
  }

  @Publico()
  @LimiteEstricto(LIMITE_ESTADO_VUELO.limite, LIMITE_ESTADO_VUELO.ventanaSegundos)
  @OperacionContrato('getFlightStatus')
  @Get('flights/:flightNumber/status')
  @Header('Cache-Control', 'no-store')
  @ApiTags(ETIQUETAS_V2.vuelos)
  @ApiOperation({
    operationId: 'getFlightStatus',
    summary: 'Estado de un vuelo en su fecha local de salida',
  })
  @ApiQuery({ name: 'date', required: true, schema: { type: 'string', format: 'date' } })
  @ApiOkResponse({ type: EstadoVueloDto })
  @ApiProblemaV2(400, 'flightNumber no es como AV1234 o date falta o no es válida')
  @ApiProblemaV2(404, 'No hay un vuelo con ese número en esa fecha')
  async estadoDeVuelo(
    @Param('flightNumber', NumeroVueloPipe) flightNumber: string,
    @Query('date', FechaPipe) date: Date,
  ): Promise<EstadoVueloDto> {
    return aEstadoVuelo(await this.estados.consultar(flightNumber, date));
  }
}
