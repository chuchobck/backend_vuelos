import {
  Body,
  Controller,
  Delete,
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
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import {
  CABECERA_IDEMPOTENCIA,
  ClaveIdempotencia,
} from '../../../common/decorators/clave-idempotencia.decorator';
import { LimiteEstricto } from '../../../common/decorators/limite-peticiones.decorator';
import { OperacionContrato } from '../../../common/decorators/operacion.decorator';
import { Scopes } from '../../../common/decorators/scopes.decorator';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { aBoleto, aListaBoletos } from '../operaciones/boleto/boleto.mapper';
import { BoletoService } from '../operaciones/boleto/boleto.service';
import { BoletoDto, ListaBoletosDto } from '../operaciones/boleto/dto/boleto.dto';
import { CheckinService } from '../operaciones/checkin/checkin.service';
import { LIMITE_CHECKIN } from '../operaciones/checkin/checkin.controller';
import { ListaPasesDto } from '../operaciones/pase-abordar/dto/pase-abordar.dto';
import { aListaPases } from '../operaciones/pase-abordar/pase-abordar.mapper';
import { PaseAbordarService } from '../operaciones/pase-abordar/pase-abordar.service';
import { LIMITE_RESERVA } from '../operaciones/reserva/reserva.controller';
import { ReservaService } from '../operaciones/reserva/reserva.service';
import { CABECERA_REPETIDA, LIMITE_RETENCION } from '../operaciones/retencion/retencion.controller';
import { RetencionService } from '../operaciones/retencion/retencion.service';
import { ApiProblemaV2, ETIQUETAS_V2 } from './documentacion-v2';
import {
  CheckInV2Dto,
  DetalleReservaV2Dto,
  EmisionBoletosDto,
  EstadoRetencionV2Dto,
  ListaReservasV2Dto,
  RetencionCreadaV2Dto,
} from './dto/respuestas-v2.dto';
import {
  ConsultaReservasV2Dto,
  LIMITE_LISTADO_V2,
  SolicitudReservaV2Dto,
  SolicitudRetencionV2Dto,
} from './dto/solicitudes-v2.dto';
import { BASE_V2 } from './enlaces';
import { aOrigenReserva, aPagoDeFachada } from './entrada-v2';
import { FachadaV2Service } from './fachada-v2.service';
import { UsuarioFachada, UsuarioV2 } from './partner/usuario-v2';
import { aCheckinV2, aEstadoRetencionV2, aListaReservasV2, aRetencionCreadaV2 } from './v2.mapper';

const CLAVE_OBLIGATORIA = {
  name: CABECERA_IDEMPOTENCIA,
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description:
    'Misma clave y mismo cuerpo: la respuesta original con Idempotent-Replayed: true (24 h); ' +
    'otro cuerpo: 409 IDEMPOTENCY_KEY_REUSED',
};
const USUARIO_FINAL = {
  name: 'X-User-Id',
  required: false,
  description: 'Usuario final de Booking. Solo cuenta con un token de partner (claim client_id)',
};

/**
 * MS.Reservas del contrato v2: hold, reservas, emisión, boletos, check-in y pases. Los services
 * son los de v1; aquí se resuelve el partner (X-User-Id), el pago de Booking y lo que v2 agrega a
 * las respuestas. Un reintento con la misma Idempotency-Key responde 200 (no 201).
 */
@ApiTags(ETIQUETAS_V2.reservas)
@Controller({ version: VERSION_NEUTRAL })
export class ReservasV2Controller {
  constructor(
    private readonly retenciones: RetencionService,
    private readonly reservas: ReservaService,
    private readonly boletos: BoletoService,
    private readonly checkins: CheckinService,
    private readonly pases: PaseAbordarService,
    private readonly fachada: FachadaV2Service,
  ) {}

  @Scopes('flights:hold')
  @LimiteEstricto(LIMITE_RETENCION.limite, LIMITE_RETENCION.ventanaSegundos)
  @OperacionContrato('createHold')
  @Post('offers/hold')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'createHold',
    summary: 'Bloquear asientos y congelar el precio',
    description:
      'Como POST /flights/v1/offers/hold, con ttlMinutes (5 a 30; sin él, HOLD_TTL_MINUTES). ' +
      'Compensación de la saga: DELETE /api/v2/vuelos/offers/hold/{holdId}.',
  })
  @ApiHeader(CLAVE_OBLIGATORIA)
  @ApiHeader(USUARIO_FINAL)
  @ApiCreatedResponse({ type: RetencionCreadaV2Dto })
  @ApiOkResponse({ type: RetencionCreadaV2Dto, description: 'Reintento con la misma clave' })
  @ApiProblemaV2(400, 'Cuerpo inválido o Idempotency-Key ausente o no uuid')
  @ApiProblemaV2(409, 'OFFER_NO_LONGER_AVAILABLE o IDEMPOTENCY_KEY_REUSED')
  @ApiProblemaV2(422, 'El itinerario o la familia no son de la oferta')
  async crearHold(
    @UsuarioFachada() usuario: UsuarioV2,
    @ClaveIdempotencia() clave: string,
    @Body() solicitud: SolicitudRetencionV2Dto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<RetencionCreadaV2Dto> {
    const { cuerpo, repetida } = await this.retenciones.crear(
      solicitud,
      usuario.id,
      clave,
      solicitud.ttlMinutes,
    );
    respuesta.setHeader('Location', `${BASE_V2}/offers/hold/${cuerpo.holdId}`);
    if (repetida) respuesta.status(200).setHeader(CABECERA_REPETIDA, 'true');
    return aRetencionCreadaV2(cuerpo);
  }

  @Scopes('flights:read')
  @OperacionContrato('getHold')
  @Get('offers/hold/:holdId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'getHold', summary: 'Estado de un hold' })
  @ApiOkResponse({ type: EstadoRetencionV2Dto })
  @ApiProblemaV2(404, 'El hold no existe o es de otro dueño')
  async consultarHold(
    @UsuarioFachada() usuario: UsuarioV2,
    @Param('holdId', UuidPipe) holdId: string,
  ): Promise<EstadoRetencionV2Dto> {
    const { retencion, ahora } = await this.retenciones.consultar(holdId, usuario);
    return aEstadoRetencionV2(retencion, ahora);
  }

  @Scopes('flights:hold')
  @OperacionContrato('releaseHold')
  @Delete('offers/hold/:holdId')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'releaseHold',
    summary: 'Liberar un hold (compensación de la saga)',
    description: 'Idempotente: liberar uno ya liberado o vencido responde 204 otra vez.',
  })
  @ApiNoContentResponse({ description: 'Liberado (o ya lo estaba)' })
  @ApiProblemaV2(404, 'El hold no existe o es de otro dueño')
  @ApiProblemaV2(409, 'HOLD_ALREADY_CONSUMED: el hold ya es una reserva (se cancela la reserva)')
  async liberarHold(
    @UsuarioFachada() usuario: UsuarioV2,
    @Param('holdId', UuidPipe) holdId: string,
  ): Promise<void> {
    await this.retenciones.liberar(holdId, usuario);
  }

  @Scopes('flights:read')
  @OperacionContrato('listBookings')
  @Get('bookings')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'listBookings',
    summary: 'Reservas del dueño del token',
    description: 'Un partner con X-User-Id ve solo las de ese usuario final.',
  })
  @ApiHeader(USUARIO_FINAL)
  @ApiOkResponse({ type: ListaReservasV2Dto })
  @ApiProblemaV2(400, 'Un filtro o el cursor no son válidos')
  async listarReservas(
    @UsuarioFachada() usuario: UsuarioV2,
    @Query() consulta: ConsultaReservasV2Dto,
  ): Promise<ListaReservasV2Dto> {
    const pagina = await this.reservas.listar(
      { ...consulta, limit: consulta.limit ?? LIMITE_LISTADO_V2.porDefecto },
      usuario.id,
      usuario.usuarioExterno,
    );
    return aListaReservasV2(pagina);
  }

  @Scopes('flights:book')
  @LimiteEstricto(LIMITE_RESERVA.limite, LIMITE_RESERVA.ventanaSegundos)
  @OperacionContrato('createBooking')
  @Post('bookings')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'createBooking',
    summary: 'Crear la reserva de un hold con la paymentReference de Booking',
    description:
      'Con provider BOOKING_PROTOTIPO (por defecto) la aerolínea no cobra: valida la referencia ' +
      '(que no haya acreditado otra operación) y, si llega, que amount sea el precio congelado; ' +
      'emite en el acto (201 CONFIRMED). Con AIRLINE_DIRECT juzga la referencia la Payment API ' +
      '(como v1): 201 o 202 PENDING_PAYMENT. Compensación: POST .../cancel con SAGA_COMPENSATION.',
  })
  @ApiHeader(CLAVE_OBLIGATORIA)
  @ApiHeader(USUARIO_FINAL)
  @ApiCreatedResponse({ type: DetalleReservaV2Dto, description: 'Reserva y boletos emitidos' })
  @ApiOkResponse({ type: DetalleReservaV2Dto, description: 'Reintento con la misma clave' })
  @ApiProblemaV2(400, 'Cuerpo inválido o Idempotency-Key ausente')
  @ApiProblemaV2(409, 'HOLD_ALREADY_CONSUMED, IDEMPOTENCY_KEY_REUSED o el vuelo ya no se vende')
  @ApiProblemaV2(410, 'HOLD_EXPIRED')
  @ApiProblemaV2(
    422,
    'PAYMENT_REFERENCE_INVALID, AMOUNT_MISMATCH, PASSENGER_COUNT_MISMATCH, DOCUMENT_EXPIRED...',
  )
  async crearReserva(
    @UsuarioFachada() usuario: UsuarioV2,
    @ClaveIdempotencia() clave: string,
    @Body() solicitud: SolicitudReservaV2Dto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<DetalleReservaV2Dto> {
    const { reserva, codigoHttp, repetida } = await this.reservas.crear(
      solicitud,
      usuario.id,
      clave,
      {
        pago: aPagoDeFachada(solicitud.payment),
        origen: aOrigenReserva(usuario, solicitud.salesChannel),
      },
    );
    respuesta.setHeader('Location', `${BASE_V2}/bookings/${reserva.id}`);
    respuesta.status(repetida ? 200 : codigoHttp);
    if (repetida) respuesta.setHeader(CABECERA_REPETIDA, 'true');
    return this.fachada.detalle(reserva);
  }

  @Scopes('flights:read')
  @OperacionContrato('getBooking')
  @Get('bookings/:bookingId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'getBooking', summary: 'Detalle de una reserva' })
  @ApiHeader(USUARIO_FINAL)
  @ApiOkResponse({ type: DetalleReservaV2Dto })
  @ApiProblemaV2(404, 'La reserva no existe, es de otro dueño o de otro usuario final')
  async detalleReserva(
    @UsuarioFachada() usuario: UsuarioV2,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<DetalleReservaV2Dto> {
    await this.fachada.exigirAcceso(bookingId, usuario);
    return this.fachada.detalle(await this.reservas.detalle(bookingId, usuario.id));
  }

  @Scopes('flights:book')
  @OperacionContrato('issueTickets')
  @Post('bookings/:bookingId/tickets')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'issueTickets',
    summary: 'Emitir los boletos de una reserva',
    description:
      'Idempotente por construcción: si ya estaban emitidos, 200 con issued 0 (Idempotency-Key ' +
      'es opcional y no se usa). Una reserva que espera su pago pregunta a la Payment API.',
  })
  @ApiOkResponse({ type: EmisionBoletosDto })
  @ApiProblemaV2(404, 'La reserva no existe o es de otro dueño')
  @ApiProblemaV2(409, 'BOOKING_NOT_CONFIRMED: fallida, cancelada o con un cambio pendiente')
  async emitirBoletos(
    @UsuarioFachada() usuario: UsuarioV2,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<EmisionBoletosDto> {
    return this.fachada.emitirBoletos(bookingId, usuario);
  }

  @Scopes('flights:read')
  @OperacionContrato('listTickets')
  @Get('bookings/:bookingId/tickets')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'listTickets', summary: 'Boletos de una reserva' })
  @ApiOkResponse({ type: ListaBoletosDto })
  @ApiProblemaV2(404, 'La reserva no existe o es de otro dueño')
  async listarBoletos(
    @UsuarioFachada() usuario: UsuarioV2,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<ListaBoletosDto> {
    await this.fachada.exigirAcceso(bookingId, usuario);
    return aListaBoletos(bookingId, await this.boletos.consultar(bookingId, usuario.id));
  }

  @Scopes('flights:read')
  @OperacionContrato('getTicket')
  @Get('bookings/:bookingId/tickets/:ticketId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'getTicket', summary: 'Un boleto' })
  @ApiOkResponse({ type: BoletoDto })
  @ApiProblemaV2(404, 'La reserva o el boleto no existen')
  async boleto(
    @UsuarioFachada() usuario: UsuarioV2,
    @Param('bookingId', UuidPipe) bookingId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<BoletoDto> {
    await this.fachada.exigirAcceso(bookingId, usuario);
    return aBoleto(await this.boletos.consultarUno(bookingId, ticketId, usuario.id));
  }

  @Scopes('flights:book')
  @LimiteEstricto(LIMITE_CHECKIN.limite, LIMITE_CHECKIN.ventanaSegundos)
  @OperacionContrato('checkIn')
  @Post('bookings/:bookingId/check-in')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiTags(ETIQUETAS_V2.checkin)
  @ApiOperation({
    operationId: 'checkIn',
    summary: 'Check-in de todos los pasajeros',
    description: 'Como v1 (abre 48 h antes). Idempotente; Idempotency-Key es opcional y no se usa.',
  })
  @ApiOkResponse({ type: CheckInV2Dto })
  @ApiProblemaV2(404, 'La reserva no existe o es de otro dueño')
  @ApiProblemaV2(409, 'CHECK_IN_NOT_AVAILABLE o BOOKING_NOT_CONFIRMED')
  async checkIn(
    @UsuarioFachada() usuario: UsuarioV2,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<CheckInV2Dto> {
    await this.fachada.exigirAcceso(bookingId, usuario);
    return aCheckinV2(await this.checkins.hacer(bookingId, usuario.id));
  }

  @Scopes('flights:read')
  @OperacionContrato('listBoardingPasses')
  @Get('bookings/:bookingId/boarding-passes')
  @Header('Cache-Control', 'no-store')
  @ApiTags(ETIQUETAS_V2.checkin)
  @ApiOperation({ operationId: 'listBoardingPasses', summary: 'Pases de abordar' })
  @ApiOkResponse({ type: ListaPasesDto })
  @ApiProblemaV2(404, 'La reserva no existe o es de otro dueño')
  @ApiProblemaV2(409, 'BOARDING_PASS_NOT_AVAILABLE')
  async pasesDeAbordar(
    @UsuarioFachada() usuario: UsuarioV2,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<ListaPasesDto> {
    await this.fachada.exigirAcceso(bookingId, usuario);
    return aListaPases(bookingId, await this.pases.consultar(bookingId, usuario.id));
  }
}
