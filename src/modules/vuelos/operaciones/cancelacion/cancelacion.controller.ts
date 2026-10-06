import { Body, Controller, Get, Header, HttpCode, Param, Post, Res } from '@nestjs/common';
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
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { Scopes } from '../../../../common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../../../common/decorators/usuario-actual.decorator';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { DetalleReservaDto } from '../reserva/dto/respuesta-reserva.dto';
import { aDetalleReserva } from '../reserva/reserva.mapper';
import { LIMITE_CONSULTAS } from '../reserva/reserva.controller';
import { CABECERA_REPETIDA } from '../retencion/retencion.controller';
import { aCotizacion } from './cancelacion.mapper';
import { CancelacionService, REGLAS_CANCELACION } from './cancelacion.service';
import { CotizacionCancelacionDto, SolicitudCancelacionDto } from './dto/cancelacion.dto';

/**
 * Límite propio de POST .../cancel: cada cancelación bloquea la reserva, mueve cupo y pide un
 * reembolso. 10 por minuto e IP sobra para un cliente.
 */
export const LIMITE_CANCELACION = { limite: 10, ventanaSegundos: 60 };

/** /bookings/{bookingId}/cancellation-quote y /cancel. */
@ApiTags(ETIQUETAS.postventa)
@Controller()
export class CancelacionController {
  constructor(private readonly servicio: CancelacionService) {}

  @Scopes('flights:read')
  @Get('cancellation-quote')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Cotizar reembolso por cancelación',
    description:
      'De lo pagado por cada itinerario (tarifa, impuestos y maletas adicionales) se devuelve ' +
      '(100 − porcentaje de penalidad de su familia) %; los cargos por cambio no se devuelven. ' +
      'Cada llamada crea una cotización nueva, vigente ' +
      `${REGLAS_CANCELACION.vigenciaCotizacionPorDefectoMinutos} minutos (CANCELLATION_QUOTE_TTL_MINUTES).`,
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiOkResponse({ type: CotizacionCancelacionDto, description: 'Cotización de cancelación' })
  @ApiProblema(400, 'bookingId no es un uuid')
  @ApiProblema(404, 'La reserva no existe o es de otro usuario')
  @ApiProblema(
    409,
    'La reserva no está CONFIRMED, un vuelo ya salió o hay un pago pendiente en la Payment API',
  )
  @ApiProblema(429, LIMITE_CONSULTAS)
  async cotizar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<CotizacionCancelacionDto> {
    return aCotizacion(await this.servicio.cotizar(bookingId, usuario.id));
  }

  @Scopes('flights:cancel')
  @LimiteEstricto(LIMITE_CANCELACION.limite, LIMITE_CANCELACION.ventanaSegundos)
  @Post('cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Cancelar reserva',
    description:
      'Exige un quoteId vigente de esta reserva. Libera asientos y cupo, anula los boletos y pide el ' +
      'reembolso a la Payment API: aprobado (o nada que devolver), 200 con la reserva CANCELLED; ' +
      'pendiente, 202 en CANCELLATION_PENDING y el proceso periódico la completa. El contrato no ' +
      'define el cuerpo de estas respuestas: va el BookingDetail. La misma Idempotency-Key repite el ' +
      'resultado; otra clave sobre una reserva ya cancelada es 409.',
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiHeader({
    name: CABECERA_IDEMPOTENCIA,
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({ type: DetalleReservaDto, description: 'Cancelación exitosa' })
  @ApiAcceptedResponse({
    type: DetalleReservaDto,
    description: 'Cancelación en proceso (CANCELLATION_PENDING)',
  })
  @ApiProblema(400, 'Cuerpo inválido o Idempotency-Key ausente')
  @ApiProblema(404, 'La reserva no existe o es de otro usuario')
  @ApiProblema(
    409,
    'QUOTE_EXPIRED (cotización vencida o ya usada), ALREADY_CANCELLED, la reserva no está ' +
      'CONFIRMED, un vuelo ya salió o hay un pago pendiente',
  )
  @ApiProblema(
    422,
    'La cotización no existe o es de otra reserva, o la clave ya se usó con otro cuerpo',
  )
  @ApiProblema(429, `Más de ${LIMITE_CANCELACION.limite} cancelaciones por IP en un minuto`)
  async cancelar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('bookingId', UuidPipe) bookingId: string,
    @ClaveIdempotencia() clave: string,
    @Body() solicitud: SolicitudCancelacionDto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<DetalleReservaDto> {
    const resultado = await this.servicio.cancelar(bookingId, solicitud, usuario.id, clave);
    respuesta.status(resultado.codigoHttp);
    if (resultado.repetida) respuesta.setHeader(CABECERA_REPETIDA, 'true');
    return aDetalleReserva(resultado.reserva);
  }
}
