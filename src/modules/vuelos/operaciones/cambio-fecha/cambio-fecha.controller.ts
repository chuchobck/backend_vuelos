import { Body, Controller, Header, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import {
  CABECERA_IDEMPOTENCIA,
  ClaveIdempotencia,
} from '../../../../common/decorators/clave-idempotencia.decorator';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import { Scopes } from '../../../../common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../../../common/decorators/usuario-actual.decorator';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { DetalleReservaDto } from '../reserva/dto/respuesta-reserva.dto';
import { aDetalleReserva } from '../reserva/reserva.mapper';
import { CABECERA_REPETIDA } from '../retencion/retencion.controller';
import { aOpcionCambio } from './cambio-fecha.mapper';
import { CambioFechaService, REGLAS_CAMBIO } from './cambio-fecha.service';
import {
  OpcionCambioDto,
  SolicitudBusquedaCambioDto,
  SolicitudCambioDto,
} from './dto/cambio-fecha.dto';

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

  @Scopes('flights:book')
  @LimiteEstricto(LIMITE_CAMBIO.limite, LIMITE_CAMBIO.ventanaSegundos)
  @Post('date-change')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Confirmar cambio de fecha',
    description:
      'Toma el cupo de los vuelos nuevos, asigna asientos (los pedidos en assignedSeats, en el orden ' +
      'de los pasajeros con asiento, o el primero libre de la cabina), devuelve el cupo y los asientos ' +
      'viejos y vuelve a emitir los boletos (los anteriores quedan VOIDED). Si totalToPay > 0 exige ' +
      'payment: PAY-OK-… aprobado, 200; PAY-PEND-… pendiente, 202 con la reserva CHANGE_PENDING y los ' +
      'vuelos nuevos tomados; PAY-REJ-… rechazado, 422 sin cambios. El contrato no define el cuerpo del ' +
      '202: va el BookingDetail. La misma Idempotency-Key repite el resultado.',
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiHeader({
    name: CABECERA_IDEMPOTENCIA,
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({ type: DetalleReservaDto, description: 'Cambio confirmado' })
  @ApiAcceptedResponse({
    type: DetalleReservaDto,
    description: 'Cambio en proceso (CHANGE_PENDING)',
  })
  @ApiProblema(400, 'Cuerpo inválido, más asientos que pasajeros o Idempotency-Key ausente')
  @ApiProblema(404, 'La reserva no existe o es de otro usuario')
  @ApiProblema(
    409,
    'La oferta ya se usó, ya no hay cupo (OFFER_NO_LONGER_AVAILABLE), el asiento está tomado ' +
      '(SEAT_TAKEN), la reserva no está CONFIRMED, un vuelo ya salió o la referencia ya se usó',
  )
  @ApiProblema(410, 'CHANGE_OFFER_EXPIRED: la oferta de cambio venció')
  @ApiProblema(
    422,
    'La oferta no es de esta reserva, falta payment, el pago no es válido o no se autorizó, un ' +
      'asiento es de otra cabina o la clave ya se usó con otro cuerpo',
  )
  @ApiProblema(429, `Más de ${LIMITE_CAMBIO.limite} cambios por IP en un minuto`)
  async confirmar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('bookingId', UuidPipe) bookingId: string,
    @ClaveIdempotencia() clave: string,
    @Body() solicitud: SolicitudCambioDto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<DetalleReservaDto> {
    const resultado = await this.servicio.confirmar(bookingId, solicitud, usuario.id, clave);
    respuesta.status(resultado.codigoHttp);
    if (resultado.repetida) respuesta.setHeader(CABECERA_REPETIDA, 'true');
    return aDetalleReserva(resultado.reserva);
  }
}
