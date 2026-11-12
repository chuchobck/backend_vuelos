import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import { Publico } from '../../../../common/decorators/publico.decorator';
import { CodigoIataAeropuertoPipe } from '../../../../common/pipes/codigo-iata.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ConsultaSalidasDto, SalidasPublicasDto } from './dto/tablero-salidas.dto';
import { aSalidasPublicas } from './tablero-salidas.mapper';
import { TableroSalidasService } from './tablero-salidas.service';

/**
 * Límite propio de la pantalla de salidas: la puede llamar cualquiera y una pantalla la repite.
 * 60 por minuto e IP, como el estado de un vuelo, aparte del global de 100.
 */
export const LIMITE_SALIDAS_PUBLICAS = { limite: 60, ventanaSegundos: 60 };

/** /airports/{iataCode}/departures: la pantalla pública de salidas. */
@ApiTags(ETIQUETAS.salidasPublicas)
@Controller()
export class TableroSalidasController {
  constructor(private readonly servicio: TableroSalidasService) {}

  @Publico()
  @LimiteEstricto(LIMITE_SALIDAS_PUBLICAS.limite, LIMITE_SALIDAS_PUBLICAS.ventanaSegundos)
  @Get(':iataCode/departures')
  // Estados, horas estimadas y puertas cambian: ninguna caché debe guardarlos
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Salidas de un aeropuerto en una fecha local',
    description:
      'Pública. Para una pantalla de vuelos: número de vuelo, aerolínea, destino, hora programada y ' +
      'estimada en hora LOCAL del aeropuerto (con su desplazamiento), estado y, si existen, terminal ' +
      'y puerta. Incluye las salidas canceladas. Por hora programada, de 50 en 50 (hasta 100) con ' +
      '`nextCursor`. No trae datos de reservas, cupos ni pasajeros.',
  })
  @ApiParam({ name: 'iataCode', example: 'UIO', description: 'Aeropuerto de salida (3 letras)' })
  @ApiOkResponse({ type: SalidasPublicasDto, description: 'Una página de salidas' })
  @ApiProblema(400, 'iataCode, date, limit o cursor inválidos')
  @ApiProblema(404, 'No hay un aeropuerto activo con ese código')
  @ApiProblema(
    429,
    `Más de ${LIMITE_SALIDAS_PUBLICAS.limite} consultas por IP en un minuto (con Retry-After)`,
  )
  async salidas(
    @Param('iataCode', CodigoIataAeropuertoPipe) iataCode: string,
    @Query() consulta: ConsultaSalidasDto,
  ): Promise<SalidasPublicasDto> {
    return aSalidasPublicas(await this.servicio.consultar(iataCode, consulta));
  }
}
