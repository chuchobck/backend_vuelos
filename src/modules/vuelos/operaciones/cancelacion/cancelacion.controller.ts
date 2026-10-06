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
import { aCotizacion } from './cancelacion.mapper';
import { CancelacionService, REGLAS_CANCELACION } from './cancelacion.service';
import { CotizacionCancelacionDto } from './dto/cancelacion.dto';

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
}
