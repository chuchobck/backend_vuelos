import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { Scopes } from '../../../../common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../../../common/decorators/usuario-actual.decorator';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { LIMITE_CONSULTAS } from '../reserva/reserva.controller';
import { aBoleto, aListaBoletos } from './boleto.mapper';
import { BoletoService } from './boleto.service';
import { BoletoDto, ListaBoletosDto } from './dto/boleto.dto';

/** /bookings/{bookingId}/tickets: cuelga de las rutas de reserva (reserva.routes.ts). */
@ApiTags(ETIQUETAS.reservas)
@Controller()
export class BoletoController {
  constructor(private readonly servicio: BoletoService) {}

  @Scopes('flights:read')
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Consultar tickets de una reserva',
    description: 'Un boleto por pasajero (también los infantes), con un cupón por vuelo.',
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiOkResponse({ type: ListaBoletosDto, description: 'Tickets asociados a la reserva' })
  @ApiProblema(400, 'bookingId no es un uuid')
  @ApiProblema(404, 'La reserva no existe o es de otro usuario')
  @ApiProblema(429, LIMITE_CONSULTAS)
  async listar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<ListaBoletosDto> {
    return aListaBoletos(bookingId, await this.servicio.consultar(bookingId, usuario.id));
  }

  @Scopes('flights:read')
  @Get(':ticketId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Consultar un ticket' })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiParam({ name: 'ticketId', description: 'ticketId de la lista de tickets' })
  @ApiOkResponse({ type: BoletoDto, description: 'Detalle del ticket' })
  @ApiProblema(400, 'bookingId no es un uuid')
  @ApiProblema(404, 'La reserva no existe o es de otro usuario, o el ticket no es de esa reserva')
  @ApiProblema(429, LIMITE_CONSULTAS)
  async uno(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('bookingId', UuidPipe) bookingId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<BoletoDto> {
    return aBoleto(await this.servicio.consultarUno(bookingId, ticketId, usuario.id));
  }
}
