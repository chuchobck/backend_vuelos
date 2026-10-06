import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import {
  CABECERA_HUELLA,
  HuellaDispositivo,
} from '../../../../common/decorators/huella-dispositivo.decorator';
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import { Publico } from '../../../../common/decorators/publico.decorator';
import { ETIQUETAS } from '../../../../config/swagger';
import { aRespuestaBusqueda } from './busqueda.mapper';
import { BusquedaService, REGLAS_BUSQUEDA } from './busqueda.service';
import { RespuestaBusquedaDto } from './dto/respuesta-busqueda.dto';
import { SolicitudBusquedaDto } from './dto/solicitud-busqueda.dto';

/**
 * Límite propio de /search, aparte del global (100 por minuto e IP): cada búsqueda hace varias
 * consultas y guarda hasta 20 ofertas. 20 por minuto e IP alcanza para que una persona cambie
 * fechas y pasajeros varias veces, y frena a un robot que recorra rutas.
 */
export const LIMITE_BUSQUEDA = { limite: 20, ventanaSegundos: 60 };

@ApiTags(ETIQUETAS.busqueda)
@Controller()
export class BusquedaController {
  constructor(private readonly servicio: BusquedaService) {}

  @Publico()
  @LimiteEstricto(LIMITE_BUSQUEDA.limite, LIMITE_BUSQUEDA.ventanaSegundos)
  @Post()
  @HttpCode(200)
  // Ofertas con precios del momento: ninguna caché debe guardarlas
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Búsqueda de vuelos (Multidestino)',
    description:
      'Un tramo es solo ida; dos con los aeropuertos invertidos, ida y vuelta; hasta 6, multidestino. ' +
      'Cada oferta es de una sola aerolínea y trae un itinerario por tramo (directo o con una escala), ' +
      'con las familias tarifarias que tienen cupo para todos los pasajeros. Orden: precio total y ' +
      `luego hora de salida; a lo sumo ${REGLAS_BUSQUEDA.maximoOfertas} ofertas. Cada oferta vence a los ` +
      `${REGLAS_BUSQUEDA.vigenciaPorDefectoMinutos} minutos (SEARCH_OFFER_TTL_MINUTES). Sin resultados: 200 con la lista vacía.`,
  })
  @ApiHeader({
    name: CABECERA_HUELLA,
    required: true,
    description: 'Huella del dispositivo: de 8 a 128 letras, dígitos o . _ : + / = -',
    example: 'b3f1c2a4-9d8e-4f6a-8b1c-2d3e4f5a6b7c',
  })
  @ApiOkResponse({ type: RespuestaBusquedaDto })
  @ApiProblema(400, 'Cuerpo inválido, fecha pasada o falta la cabecera X-Device-Fingerprint')
  @ApiProblema(
    429,
    `Más de ${LIMITE_BUSQUEDA.limite} búsquedas por IP en un minuto (con Retry-After)`,
  )
  async buscar(
    @HuellaDispositivo() huella: string,
    @Body() solicitud: SolicitudBusquedaDto,
  ): Promise<RespuestaBusquedaDto> {
    return aRespuestaBusqueda(await this.servicio.buscar(solicitud, huella));
  }
}
