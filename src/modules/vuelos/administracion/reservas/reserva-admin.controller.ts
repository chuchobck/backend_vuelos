import { Body, Get, Header, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { Response } from 'express';
import {
  CABECERA_IDEMPOTENCIA,
  ClaveIdempotencia,
} from '../../../../common/decorators/clave-idempotencia.decorator';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../../../common/decorators/usuario-actual.decorator';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ControllerAdmin } from '../../catalogo/base/documentacion-catalogo';
import { LIMITE_CANCELACION } from '../../operaciones/cancelacion/cancelacion.controller';
import { CABECERA_REPETIDA } from '../../operaciones/retencion/retencion.controller';
import {
  CancelarReservaAdminDto,
  ConsultaReservasAdminDto,
  DetalleReservaAdminDto,
  ListaReservasAdminDto,
} from './dto/reserva-admin.dto';
import { aDetalleAdmin, aListaAdmin } from './reserva-admin.mapper';
import { ReservaAdminService } from './reserva-admin.service';

@ControllerAdmin(ETIQUETAS.adminReservas)
export class ReservaAdminController {
  constructor(private readonly servicio: ReservaAdminService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Listar las reservas de todos los clientes (Paginado)',
    description:
      'De la más reciente a la más vieja. Cada fila lleva su dueño (`owner`). Filtros: pnr, status, ' +
      'createdFrom/createdTo (días UTC, incluidos), ownerEmail (correo exacto) y flightNumber ' +
      '(p. ej. LA2410, en un itinerario vigente).',
  })
  @ApiOkResponse({ type: ListaReservasAdminDto })
  @ApiProblema(400, 'Un filtro inválido o un cursor que no es de esta lista')
  async listar(@Query() consulta: ConsultaReservasAdminDto): Promise<ListaReservasAdminDto> {
    return aListaAdmin(await this.servicio.listar(consulta));
  }

  @Get(':bookingId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Detalle completo de cualquier reserva',
    description:
      'El mismo detalle de GET /bookings/{bookingId}, sin el filtro de dueño, más `owner`.',
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiOkResponse({ type: DetalleReservaAdminDto })
  @ApiProblema(404, 'La reserva no existe')
  async detalle(@Param('bookingId', UuidPipe) bookingId: string): Promise<DetalleReservaAdminDto> {
    const { reserva, owner } = await this.servicio.detalle(bookingId);
    return aDetalleAdmin(reserva, owner);
  }

  @Post(':bookingId/cancel')
  @LimiteEstricto(LIMITE_CANCELACION.limite, LIMITE_CANCELACION.ventanaSegundos)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Cancelar una reserva como administrador',
    description:
      'Misma cancelación que la del cliente (mismo reembolso y penalidad según la familia ' +
      'tarifaria, libera asientos y cupo, anula boletos, auditoría y eventos/webhooks), sin ' +
      'necesidad de cotizar antes: el servidor crea y acepta la cotización. 200 con la reserva ' +
      'CANCELLED; 202 si el reembolso sigue pendiente (CANCELLATION_PENDIENTE). La misma ' +
      'Idempotency-Key repite el resultado (con Idempotent-Replayed: true); una reserva ya ' +
      'cancelada, con otra clave, es 409 ALREADY_CANCELLED.',
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiHeader({
    name: CABECERA_IDEMPOTENCIA,
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description: 'Una por intento lógico de cancelación; se reusa solo al reintentar',
  })
  @ApiOkResponse({ type: DetalleReservaAdminDto, description: 'Reserva cancelada' })
  @ApiAcceptedResponse({
    type: DetalleReservaAdminDto,
    description: 'Cancelación en proceso (el reembolso sigue pendiente)',
  })
  @ApiProblema(400, 'Cuerpo inválido o Idempotency-Key ausente')
  @ApiProblema(404, 'La reserva no existe')
  @ApiProblema(
    409,
    'ALREADY_CANCELLED, la reserva no está CONFIRMED, un vuelo ya salió o hay un pago pendiente',
  )
  @ApiProblema(422, 'La Idempotency-Key ya se usó con otro cuerpo')
  async cancelar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('bookingId', UuidPipe) bookingId: string,
    @ClaveIdempotencia() clave: string,
    @Body() cuerpo: CancelarReservaAdminDto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<DetalleReservaAdminDto> {
    const resultado = await this.servicio.cancelar(bookingId, usuario.id, clave, cuerpo);
    respuesta.status(resultado.codigoHttp);
    if (resultado.repetida) respuesta.setHeader(CABECERA_REPETIDA, 'true');
    return aDetalleAdmin(resultado.reserva, resultado.owner);
  }
}
