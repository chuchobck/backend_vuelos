import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { NumeroVueloPipe } from '../../../../common/pipes/codigo-iata.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ControllerAdmin, DocCatalogo } from '../base/documentacion-catalogo';
import { aPagina, filtroBase, Pagina } from '../base/paginacion';
import {
  ActualizarVueloDto,
  ConsultaVueloDto,
  CrearVueloDto,
  VueloRespuestaDto,
} from './dto/vuelo.dto';
import { aVueloRespuesta } from './vuelo.mapper';
import { VueloService } from './vuelo.service';

const ENTIDAD = 'flights';

@ControllerAdmin(ETIQUETAS.adminVuelo)
export class VueloController {
  constructor(private readonly servicio: VueloService) {}

  @Get()
  @DocCatalogo.listar(ENTIDAD, VueloRespuestaDto)
  async listar(@Query() consulta: ConsultaVueloDto): Promise<Pagina<VueloRespuestaDto>> {
    const pagina = await this.servicio.listar(
      {
        ...filtroBase(consulta),
        codigoAerolinea: consulta.airline,
        codigoOrigen: consulta.origin,
        codigoDestino: consulta.destination,
      },
      consulta.limit,
      consulta.cursor,
    );
    return aPagina(pagina, aVueloRespuesta);
  }

  @Get(':flightNumber')
  @DocCatalogo.obtener(ENTIDAD, VueloRespuestaDto)
  async obtener(
    @Param('flightNumber', NumeroVueloPipe) flightNumber: string,
  ): Promise<VueloRespuestaDto> {
    return aVueloRespuesta(await this.servicio.obtener(flightNumber));
  }

  @Post()
  @DocCatalogo.crear(ENTIDAD, VueloRespuestaDto)
  async crear(@Body() dto: CrearVueloDto): Promise<VueloRespuestaDto> {
    return aVueloRespuesta(await this.servicio.crear(dto));
  }

  @Patch(':flightNumber')
  @DocCatalogo.actualizar(ENTIDAD, VueloRespuestaDto)
  async actualizar(
    @Param('flightNumber', NumeroVueloPipe) flightNumber: string,
    @Body() dto: ActualizarVueloDto,
  ): Promise<VueloRespuestaDto> {
    return aVueloRespuesta(await this.servicio.actualizar(flightNumber, dto));
  }

  @Delete(':flightNumber')
  @DocCatalogo.desactivar(ENTIDAD)
  async desactivar(@Param('flightNumber', NumeroVueloPipe) flightNumber: string): Promise<void> {
    await this.servicio.desactivar(flightNumber);
  }

  @Post(':flightNumber/reactivate')
  @DocCatalogo.reactivar(ENTIDAD, VueloRespuestaDto)
  async reactivar(
    @Param('flightNumber', NumeroVueloPipe) flightNumber: string,
  ): Promise<VueloRespuestaDto> {
    return aVueloRespuesta(await this.servicio.reactivar(flightNumber));
  }
}
