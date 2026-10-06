import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CodigoIataAeropuertoPipe } from '../../../../common/pipes/codigo-iata.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ControllerAdmin, DocCatalogo } from '../base/documentacion-catalogo';
import { aPagina, filtroBase, Pagina } from '../base/paginacion';
import { aAeropuertoRespuesta } from './aeropuerto.mapper';
import { AeropuertoService } from './aeropuerto.service';
import {
  ActualizarAeropuertoDto,
  AeropuertoRespuestaDto,
  ConsultaAeropuertoDto,
  CrearAeropuertoDto,
} from './dto/aeropuerto.dto';

const ENTIDAD = 'airports';

@ControllerAdmin(ETIQUETAS.adminAeropuerto)
export class AeropuertoController {
  constructor(private readonly servicio: AeropuertoService) {}

  @Get()
  @DocCatalogo.listar(ENTIDAD, AeropuertoRespuestaDto)
  async listar(@Query() consulta: ConsultaAeropuertoDto): Promise<Pagina<AeropuertoRespuestaDto>> {
    const pagina = await this.servicio.listar(
      { ...filtroBase(consulta), ciudadId: consulta.cityId, codigoPais: consulta.country },
      consulta.limit,
      consulta.cursor,
    );
    return aPagina(pagina, aAeropuertoRespuesta);
  }

  @Get(':code')
  @DocCatalogo.obtener(ENTIDAD, AeropuertoRespuestaDto)
  async obtener(
    @Param('code', CodigoIataAeropuertoPipe) code: string,
  ): Promise<AeropuertoRespuestaDto> {
    return aAeropuertoRespuesta(await this.servicio.obtener(code));
  }

  @Post()
  @DocCatalogo.crear(ENTIDAD, AeropuertoRespuestaDto)
  async crear(@Body() dto: CrearAeropuertoDto): Promise<AeropuertoRespuestaDto> {
    return aAeropuertoRespuesta(await this.servicio.crear(dto));
  }

  @Patch(':code')
  @DocCatalogo.actualizar(ENTIDAD, AeropuertoRespuestaDto)
  async actualizar(
    @Param('code', CodigoIataAeropuertoPipe) code: string,
    @Body() dto: ActualizarAeropuertoDto,
  ): Promise<AeropuertoRespuestaDto> {
    return aAeropuertoRespuesta(await this.servicio.actualizar(code, dto));
  }

  @Delete(':code')
  @DocCatalogo.desactivar(ENTIDAD)
  async desactivar(@Param('code', CodigoIataAeropuertoPipe) code: string): Promise<void> {
    await this.servicio.desactivar(code);
  }

  @Post(':code/reactivate')
  @DocCatalogo.reactivar(ENTIDAD, AeropuertoRespuestaDto)
  async reactivar(
    @Param('code', CodigoIataAeropuertoPipe) code: string,
  ): Promise<AeropuertoRespuestaDto> {
    return aAeropuertoRespuesta(await this.servicio.reactivar(code));
  }
}
