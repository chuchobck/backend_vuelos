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
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import { Scopes } from '../../../../common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../../../common/decorators/usuario-actual.decorator';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { LIMITE_CONSULTAS } from '../reserva/reserva.controller';
import { CABECERA_REPETIDA } from '../retencion/retencion.controller';
import { EquipajeAgregadoDto, OpcionEquipajeDto, SolicitudEquipajeDto } from './dto/equipaje.dto';
import { aOpcionEquipaje } from './equipaje.mapper';
import { EquipajeService, REGLAS_EQUIPAJE } from './equipaje.service';

/**
 * Límite propio de POST .../baggage, aparte del global: cada compra cobra y bloquea al
 * pasajero. 10 por minuto e IP alcanza para comprar maletas de toda una familia.
 */
export const LIMITE_EQUIPAJE = { limite: 10, ventanaSegundos: 60 };

/** /bookings/{bookingId}/baggage-options y /baggage. */
@ApiTags(ETIQUETAS.postventa)
@Controller()
export class EquipajeController {
  constructor(private readonly servicio: EquipajeService) {}

  @Scopes('flights:read')
  @Get('baggage-options')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Opciones de equipaje post-emisión',
    description:
      'Por pasajero e itinerario: el precio de hoy de una maleta adicional (sumado sobre los vuelos ' +
      'del itinerario), el máximo de la familia tarifaria (0 para infantes) y lo ya comprado.',
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiOkResponse({ type: [OpcionEquipajeDto], description: 'Tarifas y límites de maletas' })
  @ApiProblema(400, 'bookingId no es un uuid')
  @ApiProblema(404, 'La reserva no existe o es de otro usuario')
  @ApiProblema(409, 'La reserva no está CONFIRMED')
  @ApiProblema(429, LIMITE_CONSULTAS)
  async opciones(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<OpcionEquipajeDto[]> {
    return (await this.servicio.opciones(bookingId, usuario.id)).map(aOpcionEquipaje);
  }

  @Scopes('flights:book')
  @LimiteEstricto(LIMITE_EQUIPAJE.limite, LIMITE_EQUIPAJE.ventanaSegundos)
  @Post('baggage')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Agregar maleta extra post-emisión',
    description:
      'Cobra quantity × el precio de hoy con paymentReference (PAY-OK-… aprobado: 200; PAY-PEND-… ' +
      'pendiente: 202 y la maleta ya cuenta para el máximo; PAY-REJ-… rechazado: 422 sin cambios). ' +
      'La misma Idempotency-Key con el mismo cuerpo repite el resultado sin cobrar dos veces ' +
      `(${REGLAS_EQUIPAJE.vigenciaClaveHoras} horas).`,
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiHeader({
    name: CABECERA_IDEMPOTENCIA,
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({ type: EquipajeAgregadoDto, description: 'Maleta agregada' })
  @ApiAcceptedResponse({
    type: EquipajeAgregadoDto,
    description: 'Pago pendiente: la maleta queda reservada y el proceso confirma el pago después',
  })
  @ApiProblema(400, 'Cuerpo inválido o Idempotency-Key ausente')
  @ApiProblema(404, 'La reserva no existe o es de otro usuario')
  @ApiProblema(
    409,
    'BAGGAGE_LIMIT_EXCEEDED, la reserva no está CONFIRMED, el vuelo ya salió o la referencia ya se usó',
  )
  @ApiProblema(
    422,
    'El pasajero o el itinerario no son de la reserva, el pago no es válido o no se autorizó, o la ' +
      'Idempotency-Key ya se usó con otro cuerpo',
  )
  @ApiProblema(429, `Más de ${LIMITE_EQUIPAJE.limite} compras por IP en un minuto`)
  async agregar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('bookingId', UuidPipe) bookingId: string,
    @ClaveIdempotencia() clave: string,
    @Body() solicitud: SolicitudEquipajeDto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<EquipajeAgregadoDto> {
    const resultado = await this.servicio.agregar(bookingId, solicitud, usuario.id, clave);
    respuesta.status(resultado.codigoHttp);
    if (resultado.repetida) respuesta.setHeader(CABECERA_REPETIDA, 'true');
    return resultado.cuerpo;
  }
}
