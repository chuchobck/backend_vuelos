import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import { Publico } from '../../../../common/decorators/publico.decorator';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { MapaAsientosOfertaDto } from './dto/mapa-asientos-oferta.dto';
import { aMapaAsientosOferta } from './oferta.mapper';
import { OfertaService } from './oferta.service';

/**
 * Límite propio del mapa de asientos: es más liviano que la búsqueda (solo lee), pero una
 * persona lo abre por segmento; 60 por minuto e IP, aparte del global de 100.
 */
export const LIMITE_MAPA_ASIENTOS = { limite: 60, ventanaSegundos: 60 };

@ApiTags(ETIQUETAS.busqueda)
@Controller()
export class OfertaController {
  constructor(private readonly servicio: OfertaService) {}

  @Publico()
  @LimiteEstricto(LIMITE_MAPA_ASIENTOS.limite, LIMITE_MAPA_ASIENTOS.ventanaSegundos)
  @Get(':offerId/seatmap')
  @ApiOperation({
    summary: 'Obtener mapa de asientos por segmento',
    description:
      'Asientos físicos de la aeronave del segmento, sin precios. Un asiento no está disponible si ' +
      'una reserva ya lo tiene asignado o si su cabina no se vende en esta salida (las retenciones ' +
      'toman cupo, no asientos).',
  })
  @ApiParam({ name: 'offerId', format: 'uuid', description: 'offerId de POST /search' })
  @ApiQuery({
    name: 'segmentId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description: 'segmentId de un segmento de la oferta',
  })
  @ApiOkResponse({ type: MapaAsientosOfertaDto })
  @ApiProblema(400, 'offerId o segmentId no son uuid')
  @ApiProblema(404, 'La oferta no existe o venció, o el segmento no es de esa oferta')
  @ApiProblema(
    429,
    `Más de ${LIMITE_MAPA_ASIENTOS.limite} mapas por IP en un minuto (con Retry-After)`,
  )
  async mapaDeAsientos(
    @Param('offerId', UuidPipe) offerId: string,
    @Query('segmentId', UuidPipe) segmentId: string,
  ): Promise<MapaAsientosOfertaDto> {
    return aMapaAsientosOferta(await this.servicio.mapaDeAsientos(offerId, segmentId));
  }
}
