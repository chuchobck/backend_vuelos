import { Body, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam } from '@nestjs/swagger';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ControllerAdmin } from '../../catalogo/base/documentacion-catalogo';
import { AbordajeDto, EscanearPaseDto, ManifiestoDto } from './dto/embarque.dto';
import { aAbordaje, aManifiesto } from './embarque.mapper';
import { EmbarqueService } from './embarque.service';

/**
 * Límite propio del escaneo, aparte del global de 100: una puerta escanea un pase cada pocos
 * segundos y varias puertas pueden salir por la misma IP. 120 por minuto e IP.
 */
export const LIMITE_ESCANEO = { limite: 120, ventanaSegundos: 60 };

/** /admin/departures/{departureId}/boarding: la puerta de embarque de una salida. */
@ControllerAdmin(ETIQUETAS.adminEmbarque)
export class EmbarqueController {
  constructor(private readonly servicio: EmbarqueService) {}

  @Post('scan')
  @LimiteEstricto(LIMITE_ESCANEO.limite, LIMITE_ESCANEO.ventanaSegundos)
  @HttpCode(200)
  // Lleva el nombre de un pasajero: ninguna caché debe guardarlo
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Escanear un pase de abordar en la puerta',
    description:
      'Recibe el texto del código (`barcode` de un pase) y la salida que la puerta embarca. Valida ' +
      'formato, firma, que el pase sea de esa salida, que el boleto y la reserva estén vigentes, que ' +
      'el pasajero tenga check-in y que no haya abordado; cada rechazo tiene su `code`. Si pasa, ' +
      'marca al pasajero como abordado con la hora del servidor (los infantes en brazos abordan con ' +
      'su adulto) y devuelve su nombre para compararlo con el documento. De dos escaneos simultáneos ' +
      'del mismo pase, uno responde 200 y el otro 409 ALREADY_BOARDED. No mueve cupo.',
  })
  @ApiParam({ name: 'departureId', format: 'uuid', description: 'La salida (segmentId)' })
  @ApiOkResponse({ type: AbordajeDto, description: 'El pasajero abordó' })
  @ApiProblema(400, 'BOARDING_PASS_MALFORMED: el texto no tiene el formato de un pase')
  @ApiProblema(404, 'La salida no existe; BOARDING_PASS_NOT_FOUND: el boleto del pase no existe')
  @ApiProblema(
    409,
    'FLIGHT_CANCELLED, FLIGHT_ALREADY_DEPARTED, BOARDING_PASS_WRONG_FLIGHT (el pase es de otra ' +
      'salida), BOARDING_PASS_NOT_VALID (reserva o boleto sin vigencia, o no es el pase emitido), ' +
      'PASSENGER_NOT_CHECKED_IN o ALREADY_BOARDED',
  )
  @ApiProblema(422, 'BOARDING_PASS_SIGNATURE_INVALID: la firma no es válida (código alterado)')
  @ApiProblema(429, `Más de ${LIMITE_ESCANEO.limite} escaneos por IP en un minuto`)
  async escanear(
    @Param('departureId', UuidPipe) departureId: string,
    @Body() cuerpo: EscanearPaseDto,
  ): Promise<AbordajeDto> {
    return aAbordaje(await this.servicio.escanear(departureId, cuerpo.barcode));
  }

  @Get('manifest')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Manifiesto de embarque de una salida',
    description:
      'Para la pantalla de la puerta: cuántos asientos se vendieron, cuántos tienen check-in y ' +
      'cuántos abordaron, y una fila por asiento con su estado (BOOKED, TICKETED, CHECKED_IN o ' +
      'BOARDED). Lleva el PNR y el passengerId, nunca el nombre, el documento ni el correo.',
  })
  @ApiParam({ name: 'departureId', format: 'uuid', description: 'La salida (segmentId)' })
  @ApiOkResponse({ type: ManifiestoDto })
  @ApiProblema(404, 'La salida no existe')
  async manifiesto(@Param('departureId', UuidPipe) departureId: string): Promise<ManifiestoDto> {
    return aManifiesto(await this.servicio.manifiesto(departureId));
  }
}
