import { Controller, Header, HttpCode, Param, Post } from '@nestjs/common';
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
import { aCheckin } from './checkin.mapper';
import { CheckinService, REGLAS_CHECKIN } from './checkin.service';
import { CheckInRespuestaDto } from './dto/checkin.dto';

/**
 * Límite propio de POST .../check-in, aparte del global: cada intento bloquea la reserva y la
 * familia suele reintentarlo. 20 por minuto e IP.
 */
export const LIMITE_CHECKIN = { limite: 20, ventanaSegundos: 60 };

/** /bookings/{bookingId}/check-in. */
@ApiTags(ETIQUETAS.checkin)
@Controller()
export class CheckinController {
  constructor(private readonly servicio: CheckinService) {}

  @Scopes('flights:book')
  @LimiteEstricto(LIMITE_CHECKIN.limite, LIMITE_CHECKIN.ventanaSegundos)
  @Post('check-in')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Realizar check-in de la reserva',
    description:
      'Registra a todos los pasajeros en cada vuelo cuya ventana está abierta (abre ' +
      `${REGLAS_CHECKIN.aperturaPorDefectoHoras} horas antes de la salida y cierra ` +
      `${REGLAS_CHECKIN.cierrePorDefectoMinutos} minutos antes; CHECKIN_OPENS_HOURS_BEFORE y ` +
      'CHECKIN_CLOSES_MINUTES_BEFORE). Conserva el asiento ya asignado; un infante lo hace con su ' +
      'adulto y sin asiento. Es idempotente (el contrato no pide Idempotency-Key): repetirlo no ' +
      'cambia nada y devuelve el estado actual. Un vuelo que todavía no abre queda NOT_CHECKED_IN y ' +
      'uno que ya cerró, FAILED: el resultado es IN_PROGRESS. Sin ningún vuelo en ventana y sin ' +
      'check-in previo, 409.',
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiOkResponse({ type: CheckInRespuestaDto, description: 'Check-in realizado' })
  @ApiProblema(400, 'bookingId no es un uuid')
  @ApiProblema(404, 'La reserva no existe o es de otro usuario')
  @ApiProblema(
    409,
    'CHECK_IN_NOT_AVAILABLE: la reserva no está CONFIRMED, falta un boleto emitido o ningún vuelo ' +
      'está en su ventana de check-in',
  )
  @ApiProblema(
    422,
    'CHECK_IN_FAILED: un pasajero no tiene asiento o su pasaporte vence antes del vuelo',
  )
  @ApiProblema(429, `Más de ${LIMITE_CHECKIN.limite} check-in por IP en un minuto`)
  async hacer(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<CheckInRespuestaDto> {
    return aCheckin(await this.servicio.hacer(bookingId, usuario.id));
  }
}
