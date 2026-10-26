import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiHeader,
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
import {
  LIMITE_BUSQUEDA_CAMBIO,
  LIMITE_CAMBIO,
} from '../operaciones/cambio-fecha/cambio-fecha.controller';
import { aOpcionCambio } from '../operaciones/cambio-fecha/cambio-fecha.mapper';
import { CambioFechaService } from '../operaciones/cambio-fecha/cambio-fecha.service';
import {
  OpcionCambioDto,
  SolicitudBusquedaCambioDto,
} from '../operaciones/cambio-fecha/dto/cambio-fecha.dto';
import { LIMITE_CANCELACION } from '../operaciones/cancelacion/cancelacion.controller';
import { aCotizacion } from '../operaciones/cancelacion/cancelacion.mapper';
import { CancelacionService } from '../operaciones/cancelacion/cancelacion.service';
import { CotizacionCancelacionDto } from '../operaciones/cancelacion/dto/cancelacion.dto';
import { EquipajeAgregadoDto, OpcionEquipajeDto } from '../operaciones/equipaje/dto/equipaje.dto';
import { LIMITE_EQUIPAJE } from '../operaciones/equipaje/equipaje.controller';
import { aOpcionEquipaje } from '../operaciones/equipaje/equipaje.mapper';
import { EquipajeService } from '../operaciones/equipaje/equipaje.service';
import { CABECERA_REPETIDA } from '../operaciones/retencion/retencion.controller';
import { ApiProblemaV2, ETIQUETAS_V2 } from './documentacion-v2';
import { CancelacionV2Dto, DetalleReservaV2Dto } from './dto/respuestas-v2.dto';
import {
  SolicitudCambioV2Dto,
  SolicitudCancelacionV2Dto,
  SolicitudEquipajeV2Dto,
} from './dto/solicitudes-v2.dto';
import { aPagoDeFachada } from './entrada-v2';
import { FachadaV2Service } from './fachada-v2.service';
import { UsuarioFachada, UsuarioV2 } from './partner/usuario-v2';

const CLAVE_OBLIGATORIA = {
  name: CABECERA_IDEMPOTENCIA,
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description: 'Misma clave y mismo cuerpo: la respuesta original con Idempotent-Replayed: true',
};

/**
 * MS.Postventa del contrato v2: maletas, cambio de fecha y cancelación, con los services de v1.
 * El pago de una maleta o de un cambio sigue las reglas de createBooking (BOOKING_PROTOTIPO no
 * cobra); la cancelación calcula el reembolso y, si cobró Booking, no lo ejecuta.
 */
@ApiTags(ETIQUETAS_V2.postventa)
@Controller({ version: VERSION_NEUTRAL })
export class PostventaV2Controller {
  constructor(
    private readonly equipajes: EquipajeService,
    private readonly cambios: CambioFechaService,
    private readonly cancelaciones: CancelacionService,
    private readonly fachada: FachadaV2Service,
  ) {}

  @Scopes('flights:read')
  @OperacionContrato('getBaggageOptions')
  @Get('bookings/:bookingId/baggage-options')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'getBaggageOptions', summary: 'Opciones de maletas adicionales' })
  @ApiOkResponse({ type: [OpcionEquipajeDto] })
  @ApiProblemaV2(404, 'La reserva no existe o es de otro dueño')
  async opcionesDeEquipaje(
    @UsuarioFachada() usuario: UsuarioV2,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<OpcionEquipajeDto[]> {
    await this.fachada.exigirAcceso(bookingId, usuario);
    return (await this.equipajes.opciones(bookingId, usuario.id)).map(aOpcionEquipaje);
  }

  @Scopes('flights:book')
  @LimiteEstricto(LIMITE_EQUIPAJE.limite, LIMITE_EQUIPAJE.ventanaSegundos)
  @OperacionContrato('addBaggage')
  @Post('bookings/:bookingId/baggage')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'addBaggage', summary: 'Agregar maletas con el pago de Booking' })
  @ApiHeader(CLAVE_OBLIGATORIA)
  @ApiOkResponse({ type: EquipajeAgregadoDto })
  @ApiAcceptedResponse({ type: EquipajeAgregadoDto, description: 'Pago AIRLINE_DIRECT pendiente' })
  @ApiProblemaV2(404, 'La reserva no existe o es de otro dueño')
  @ApiProblemaV2(409, 'BOOKING_NOT_CONFIRMED, FLIGHT_ALREADY_DEPARTED o IDEMPOTENCY_KEY_REUSED')
  @ApiProblemaV2(422, 'BAGGAGE_LIMIT_EXCEEDED, PAYMENT_REFERENCE_INVALID o AMOUNT_MISMATCH')
  async agregarEquipaje(
    @UsuarioFachada() usuario: UsuarioV2,
    @ClaveIdempotencia() clave: string,
    @Param('bookingId', UuidPipe) bookingId: string,
    @Body() solicitud: SolicitudEquipajeV2Dto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<EquipajeAgregadoDto> {
    await this.fachada.exigirAcceso(bookingId, usuario);
    const resultado = await this.equipajes.agregar(
      bookingId,
      solicitud,
      usuario.id,
      clave,
      aPagoDeFachada(solicitud.payment),
    );
    respuesta.status(resultado.codigoHttp);
    if (resultado.repetida) respuesta.setHeader(CABECERA_REPETIDA, 'true');
    return resultado.cuerpo;
  }

  @Scopes('flights:read')
  @LimiteEstricto(LIMITE_BUSQUEDA_CAMBIO.limite, LIMITE_BUSQUEDA_CAMBIO.ventanaSegundos)
  @OperacionContrato('searchDateChange')
  @Post('bookings/:bookingId/date-change/search')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'searchDateChange', summary: 'Buscar nuevas fechas' })
  @ApiOkResponse({ type: [OpcionCambioDto] })
  @ApiProblemaV2(404, 'La reserva no existe o es de otro dueño')
  @ApiProblemaV2(409, 'BOOKING_NOT_CONFIRMED o FARE_NOT_CHANGEABLE')
  async buscarCambio(
    @UsuarioFachada() usuario: UsuarioV2,
    @Param('bookingId', UuidPipe) bookingId: string,
    @Body() solicitud: SolicitudBusquedaCambioDto,
  ): Promise<OpcionCambioDto[]> {
    await this.fachada.exigirAcceso(bookingId, usuario);
    return (await this.cambios.buscar(bookingId, solicitud, usuario.id)).map(aOpcionCambio);
  }

  @Scopes('flights:book')
  @LimiteEstricto(LIMITE_CAMBIO.limite, LIMITE_CAMBIO.ventanaSegundos)
  @OperacionContrato('confirmDateChange')
  @Post('bookings/:bookingId/date-change')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'confirmDateChange', summary: 'Confirmar el cambio de fecha' })
  @ApiHeader(CLAVE_OBLIGATORIA)
  @ApiOkResponse({ type: DetalleReservaV2Dto })
  @ApiAcceptedResponse({ type: DetalleReservaV2Dto, description: 'Pago AIRLINE_DIRECT pendiente' })
  @ApiProblemaV2(404, 'La reserva no existe o es de otro dueño')
  @ApiProblemaV2(409, 'CHANGE_OFFER_EXPIRED, BOOKING_NOT_CONFIRMED o IDEMPOTENCY_KEY_REUSED')
  @ApiProblemaV2(422, 'PAYMENT_REFERENCE_INVALID o AMOUNT_MISMATCH')
  async confirmarCambio(
    @UsuarioFachada() usuario: UsuarioV2,
    @ClaveIdempotencia() clave: string,
    @Param('bookingId', UuidPipe) bookingId: string,
    @Body() solicitud: SolicitudCambioV2Dto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<DetalleReservaV2Dto> {
    await this.fachada.exigirAcceso(bookingId, usuario);
    const resultado = await this.cambios.confirmar(
      bookingId,
      solicitud,
      usuario.id,
      clave,
      solicitud.payment ? aPagoDeFachada(solicitud.payment) : undefined,
    );
    respuesta.status(resultado.codigoHttp);
    if (resultado.repetida) respuesta.setHeader(CABECERA_REPETIDA, 'true');
    return this.fachada.detalle(resultado.reserva);
  }

  @Scopes('flights:read')
  @OperacionContrato('getCancellationQuote')
  @Get('bookings/:bookingId/cancellation-quote')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'getCancellationQuote', summary: 'Cotizar la cancelación' })
  @ApiOkResponse({ type: CotizacionCancelacionDto })
  @ApiProblemaV2(404, 'La reserva no existe o es de otro dueño')
  @ApiProblemaV2(409, 'BOOKING_NOT_CANCELLABLE o FLIGHT_ALREADY_DEPARTED')
  async cotizarCancelacion(
    @UsuarioFachada() usuario: UsuarioV2,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<CotizacionCancelacionDto> {
    await this.fachada.exigirAcceso(bookingId, usuario);
    return aCotizacion(await this.cancelaciones.cotizar(bookingId, usuario.id));
  }

  @Scopes('flights:cancel')
  @LimiteEstricto(LIMITE_CANCELACION.limite, LIMITE_CANCELACION.ventanaSegundos)
  @OperacionContrato('cancelBooking')
  @Post('bookings/:bookingId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'cancelBooking',
    summary: 'Cancelar una reserva (también la compensación de la saga)',
    description:
      'quoteId es obligatorio salvo reasonCode SAGA_COMPENSATION o FLIGHT_CANCELLED (el servidor ' +
      'cotiza sin penalidad). El reembolso se calcula; si cobró Booking, lo ejecuta Booking ' +
      '(refund.status CALCULATED). Una compensación sobre una reserva ya cancelada responde la ' +
      'cancelación existente.',
  })
  @ApiHeader(CLAVE_OBLIGATORIA)
  @ApiOkResponse({ type: CancelacionV2Dto })
  @ApiAcceptedResponse({
    type: CancelacionV2Dto,
    description: 'Reembolso pendiente (AIRLINE_DIRECT)',
  })
  @ApiProblemaV2(400, 'Cuerpo inválido o falta quoteId')
  @ApiProblemaV2(404, 'La reserva no existe o es de otro dueño')
  @ApiProblemaV2(409, 'ALREADY_CANCELLED, BOOKING_NOT_CANCELLABLE, QUOTE_EXPIRED...')
  async cancelar(
    @UsuarioFachada() usuario: UsuarioV2,
    @ClaveIdempotencia() clave: string,
    @Param('bookingId', UuidPipe) bookingId: string,
    @Body() solicitud: SolicitudCancelacionV2Dto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<CancelacionV2Dto> {
    await this.fachada.exigirAcceso(bookingId, usuario);
    const resultado = await this.cancelaciones.cancelarV2(
      bookingId,
      { ...solicitud, reasonCode: solicitud.reasonCode ?? 'CUSTOMER_REQUEST' },
      usuario.id,
      clave,
    );
    respuesta.status(resultado.codigoHttp);
    if (resultado.repetida) respuesta.setHeader(CABECERA_REPETIDA, 'true');
    return this.fachada.cancelacion(resultado.reserva);
  }
}
