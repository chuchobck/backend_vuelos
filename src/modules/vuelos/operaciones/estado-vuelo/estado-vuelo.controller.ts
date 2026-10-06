import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import { Publico } from '../../../../common/decorators/publico.decorator';
import { NumeroVueloPipe } from '../../../../common/pipes/codigo-iata.pipe';
import { FechaPipe } from '../../../../common/pipes/fecha.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { EstadoVueloDto } from './dto/estado-vuelo.dto';
import { aEstadoVuelo } from './estado-vuelo.mapper';
import { EstadoVueloService } from './estado-vuelo.service';

/**
 * Límite propio de la consulta pública: es una lectura liviana (una fila), pero la puede llamar
 * cualquiera y un panel de aeropuerto la repite. 60 por minuto e IP, aparte del global de 100.
 */
export const LIMITE_ESTADO_VUELO = { limite: 60, ventanaSegundos: 60 };

@ApiTags(ETIQUETAS.estadoVuelos)
@Controller()
export class EstadoVueloController {
  constructor(private readonly servicio: EstadoVueloService) {}

  @Publico()
  @LimiteEstricto(LIMITE_ESTADO_VUELO.limite, LIMITE_ESTADO_VUELO.ventanaSegundos)
  @Get(':flightNumber/status')
  // El estado cambia (demoras, cancelaciones): ninguna caché debe guardarlo
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Consultar estado de un vuelo',
    description:
      'Público. Estado operativo de la salida del vuelo en su fecha local de salida. Las horas van en ' +
      'UTC; estimatedAt, actualAt y terminal son null mientras no se conozcan. No trae datos de ' +
      'reservas ni de pasajeros.',
  })
  @ApiParam({ name: 'flightNumber', example: 'LA1400', description: 'Aerolínea (2) y número' })
  @ApiQuery({
    name: 'date',
    required: true,
    schema: { type: 'string', format: 'date' },
    example: '2026-10-20',
    description: 'Fecha local de salida en el aeropuerto de origen (YYYY-MM-DD)',
  })
  @ApiOkResponse({ type: EstadoVueloDto, description: 'Estado operativo del vuelo' })
  @ApiProblema(400, 'flightNumber no es como AV1234 o date falta o no es una fecha válida')
  @ApiProblema(404, 'No hay un vuelo con ese número en esa fecha')
  @ApiProblema(
    429,
    `Más de ${LIMITE_ESTADO_VUELO.limite} consultas por IP en un minuto (con Retry-After)`,
  )
  async estado(
    @Param('flightNumber', NumeroVueloPipe) flightNumber: string,
    @Query('date', FechaPipe) date: Date,
  ): Promise<EstadoVueloDto> {
    return aEstadoVuelo(await this.servicio.consultar(flightNumber, date));
  }
}
