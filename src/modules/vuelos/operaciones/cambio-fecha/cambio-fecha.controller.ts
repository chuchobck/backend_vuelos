import { Body, Controller, Header, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import { Scopes } from '../../../../common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../../../common/decorators/usuario-actual.decorator';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { aOpcionCambio } from './cambio-fecha.mapper';
import { CambioFechaService, REGLAS_CAMBIO } from './cambio-fecha.service';
import { OpcionCambioDto, SolicitudBusquedaCambioDto } from './dto/cambio-fecha.dto';

/**
 * Límites propios: buscar un cambio hace las consultas de una búsqueda y guarda ofertas (20 por
 * minuto e IP, como /search); confirmarlo cobra y mueve cupo (10 por minuto e IP).
 */
export const LIMITE_BUSQUEDA_CAMBIO = { limite: 20, ventanaSegundos: 60 };
export const LIMITE_CAMBIO = { limite: 10, ventanaSegundos: 60 };

/** /bookings/{bookingId}/date-change/search y /date-change. */
@ApiTags(ETIQUETAS.postventa)
@Controller()
export class CambioFechaController {
  constructor(private readonly servicio: CambioFechaService) {}

  @Scopes('flights:read')
  @LimiteEstricto(LIMITE_BUSQUEDA_CAMBIO.limite, LIMITE_BUSQUEDA_CAMBIO.ventanaSegundos)
  @Post('date-change/search')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Buscar disponibilidad para cambio de fecha',
    description:
      'Para cada itinerario a cambiar, las salidas de la misma ruta y aerolínea en la nueva fecha con ' +
      'la misma familia tarifaria y cupo. Cada opción (un itinerario nuevo por cambio, en orden con los ' +
      'demás) trae la diferencia para todos los pasajeros: totalToPay = max(0, fareDifference + ' +
      'taxDifference) + changeFee. La opción vence a los ' +
      `${REGLAS_CAMBIO.vigenciaOfertaPorDefectoMinutos} minutos (CHANGE_OFFER_TTL_MINUTES) y no toma cupo. ` +
      `A lo sumo ${REGLAS_CAMBIO.maximoOfertas} opciones; sin opciones, 200 con la lista vacía.`,
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiOkResponse({ type: [OpcionCambioDto], description: 'Opciones de cambio' })
  @ApiProblema(400, 'Cuerpo inválido, itinerario repetido o fecha pasada o fuera del horizonte')
  @ApiProblema(404, 'La reserva no existe o es de otro usuario')
  @ApiProblema(409, 'FARE_NOT_CHANGEABLE, FLIGHT_ALREADY_DEPARTED o la reserva no está CONFIRMED')
  @ApiProblema(422, 'Un itineraryId que no es de la reserva')
  @ApiProblema(
    429,
    `Más de ${LIMITE_BUSQUEDA_CAMBIO.limite} búsquedas de cambio por IP en un minuto`,
  )
  async buscar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('bookingId', UuidPipe) bookingId: string,
    @Body() solicitud: SolicitudBusquedaCambioDto,
  ): Promise<OpcionCambioDto[]> {
    return (await this.servicio.buscar(bookingId, solicitud, usuario.id)).map(aOpcionCambio);
  }
}
