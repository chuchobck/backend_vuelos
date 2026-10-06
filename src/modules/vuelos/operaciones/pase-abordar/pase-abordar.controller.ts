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
import { ListaPasesDto } from './dto/pase-abordar.dto';
import { aListaPases } from './pase-abordar.mapper';
import { PaseAbordarService } from './pase-abordar.service';

/** /bookings/{bookingId}/boarding-passes. */
@ApiTags(ETIQUETAS.checkin)
@Controller()
export class PaseAbordarController {
  constructor(private readonly servicio: PaseAbordarService) {}

  @Scopes('flights:read')
  @Get('boarding-passes')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Consultar pases de abordar',
    description:
      'Un pase por pasajero con asiento y vuelo con check-in, emitido al hacerlo y estable: pedirlos ' +
      'dos veces da lo mismo. Sin check-in, lista vacía. Los infantes no tienen pase propio. El ' +
      'barcode es un texto firmado con el PNR, el boleto, el vuelo, la fecha, la ruta, el asiento y ' +
      'el orden del pasajero; sin datos personales.',
  })
  @ApiParam({ name: 'bookingId', format: 'uuid' })
  @ApiOkResponse({ type: ListaPasesDto, description: 'Pases de abordar disponibles' })
  @ApiProblema(400, 'bookingId no es un uuid')
  @ApiProblema(404, 'La reserva no existe o es de otro usuario')
  @ApiProblema(429, LIMITE_CONSULTAS)
  async consultar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('bookingId', UuidPipe) bookingId: string,
  ): Promise<ListaPasesDto> {
    return aListaPases(bookingId, await this.servicio.consultar(bookingId, usuario.id));
  }
}
