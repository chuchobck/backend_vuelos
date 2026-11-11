import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import { Publico } from '../../../../common/decorators/publico.decorator';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ESQUEMA_KIOSKO, ETIQUETAS } from '../../../../config/swagger';
import { aCheckin } from '../checkin/checkin.mapper';
import { CheckInRespuestaDto } from '../checkin/dto/checkin.dto';
import { ListaPasesDto } from '../pase-abordar/dto/pase-abordar.dto';
import { aListaPases } from '../pase-abordar/pase-abordar.mapper';
import { BuscarEnKioskoDto, SesionKioskoDto } from './dto/kiosko.dto';
import { aSesionKiosko } from './kiosko.mapper';
import { KioskoService } from './kiosko.service';
import { REGLAS_KIOSKO } from './sesion-kiosko';

/**
 * Límites propios del kiosko, por IP y por ruta, aparte del global de 100. La búsqueda es la que
 * alguien usaría para adivinar un PNR o un apellido: 10 por minuto. El check-in, como el del
 * contrato (20); los pases, como una consulta pública (60).
 */
export const LIMITES_KIOSKO = {
  busqueda: { limite: 10, ventanaSegundos: 60 },
  checkin: { limite: 20, ventanaSegundos: 60 },
  pases: { limite: 60, ventanaSegundos: 60 },
};

const SESION = `\`Authorization: ${REGLAS_KIOSKO.esquema} <kioskToken>\``;

/** /kiosk: check-in sin cuenta, por PNR y apellido. */
@ApiTags(ETIQUETAS.kiosko)
@Controller()
export class KioskoController {
  constructor(private readonly servicio: KioskoService) {}

  @Publico()
  @LimiteEstricto(LIMITES_KIOSKO.busqueda.limite, LIMITES_KIOSKO.busqueda.ventanaSegundos)
  @Post('lookup')
  @HttpCode(200)
  // Lleva nombres de pasajeros y una sesión: ninguna caché debe guardarla
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Buscar una reserva por PNR y apellido',
    description:
      'Pública. Si el apellido es el de algún pasajero de la reserva (sin importar mayúsculas, ' +
      'tildes, espacios ni guiones), devuelve lo que el kiosko muestra (vuelos, horarios, asientos, ' +
      'estado de check-in por vuelo y nombres) y una sesión de ' +
      `${REGLAS_KIOSKO.duracionMinutos} minutos limitada a esa reserva. Un PNR que no existe y un ` +
      'apellido que no coincide responden el mismo 404. El PNR y el apellido van en el cuerpo, nunca ' +
      'en la URL.',
  })
  @ApiOkResponse({ type: SesionKioskoDto, description: 'La reserva y su sesión de kiosko' })
  @ApiProblema(400, 'pnr no son 6 letras o dígitos, o falta lastName')
  @ApiProblema(404, 'No hay una reserva con ese PNR y ese apellido (no se dice cuál falló)')
  @ApiProblema(
    429,
    `Más de ${LIMITES_KIOSKO.busqueda.limite} búsquedas por IP en un minuto (con Retry-After)`,
  )
  async buscar(@Body() cuerpo: BuscarEnKioskoDto): Promise<SesionKioskoDto> {
    return aSesionKiosko(await this.servicio.buscar(cuerpo.pnr, cuerpo.lastName));
  }

  @Publico()
  @LimiteEstricto(LIMITES_KIOSKO.checkin.limite, LIMITES_KIOSKO.checkin.ventanaSegundos)
  @Post('bookings/:bookingId/check-in')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiSecurity(ESQUEMA_KIOSKO)
  @ApiOperation({
    summary: 'Hacer el check-in de la reserva abierta en el kiosko',
    description:
      `Sin cuenta: exige ${SESION} con la sesión que dio la búsqueda, que solo sirve para esa ` +
      'reserva. Es el mismo check-in de POST /bookings/{bookingId}/check-in (mismas reglas, misma ' +
      'respuesta, idempotente).',
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiOkResponse({ type: CheckInRespuestaDto, description: 'Check-in realizado' })
  @ApiProblema(400, 'bookingId no es un uuid')
  @ApiProblema(401, 'KIOSK_SESSION_INVALID: la sesión falta, está alterada o venció')
  @ApiProblema(404, 'La sesión es de otra reserva')
  @ApiProblema(409, 'CHECK_IN_NOT_AVAILABLE, como en el check-in del contrato')
  @ApiProblema(422, 'CHECK_IN_FAILED, como en el check-in del contrato')
  @ApiProblema(429, `Más de ${LIMITES_KIOSKO.checkin.limite} check-in por IP en un minuto`)
  async hacerCheckin(
    @Headers('authorization') autorizacion: string | undefined,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<CheckInRespuestaDto> {
    return aCheckin(await this.servicio.hacerCheckin(autorizacion, bookingId));
  }

  @Publico()
  @LimiteEstricto(LIMITES_KIOSKO.pases.limite, LIMITES_KIOSKO.pases.ventanaSegundos)
  @Get('bookings/:bookingId/boarding-passes')
  @Header('Cache-Control', 'no-store')
  @ApiSecurity(ESQUEMA_KIOSKO)
  @ApiOperation({
    summary: 'Pases de abordar de la reserva abierta en el kiosko',
    description:
      `Sin cuenta: exige ${SESION}. Los mismos pases de GET /bookings/{bookingId}/boarding-passes ` +
      '(lista vacía sin check-in).',
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiOkResponse({ type: ListaPasesDto, description: 'Pases de abordar disponibles' })
  @ApiProblema(400, 'bookingId no es un uuid')
  @ApiProblema(401, 'KIOSK_SESSION_INVALID: la sesión falta, está alterada o venció')
  @ApiProblema(404, 'La sesión es de otra reserva')
  @ApiProblema(429, `Más de ${LIMITES_KIOSKO.pases.limite} consultas por IP en un minuto`)
  async pases(
    @Headers('authorization') autorizacion: string | undefined,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<ListaPasesDto> {
    return aListaPases(bookingId, await this.servicio.pases(autorizacion, bookingId));
  }
}
