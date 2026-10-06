import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CodigoModeloAeronavePipe } from '../../../../common/pipes/codigo-iata.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ControllerAdmin, DocCatalogo } from '../base/documentacion-catalogo';
import { aPagina, filtroBase, Pagina } from '../base/paginacion';
import {
  ActualizarModeloAeronaveDto,
  ConsultaModeloAeronaveDto,
  CrearModeloAeronaveDto,
  ModeloAeronaveRespuestaDto,
} from './dto/modelo-aeronave.dto';
import { aModeloAeronaveRespuesta } from './modelo-aeronave.mapper';
import { ModeloAeronaveService } from './modelo-aeronave.service';

const ENTIDAD = 'aircraft models';

@ControllerAdmin(ETIQUETAS.adminModeloAeronave)
export class ModeloAeronaveController {
  constructor(private readonly servicio: ModeloAeronaveService) {}

  @Get()
  @DocCatalogo.listar(ENTIDAD, ModeloAeronaveRespuestaDto)
  async listar(
    @Query() consulta: ConsultaModeloAeronaveDto,
  ): Promise<Pagina<ModeloAeronaveRespuestaDto>> {
    const pagina = await this.servicio.listar(
      filtroBase(consulta),
      consulta.limit,
      consulta.cursor,
    );
    return aPagina(pagina, aModeloAeronaveRespuesta);
  }

  @Get(':code')
  @DocCatalogo.obtener(ENTIDAD, ModeloAeronaveRespuestaDto)
  async obtener(
    @Param('code', CodigoModeloAeronavePipe) code: string,
  ): Promise<ModeloAeronaveRespuestaDto> {
    return aModeloAeronaveRespuesta(await this.servicio.obtener(code));
  }

  @Post()
  @DocCatalogo.crear(ENTIDAD, ModeloAeronaveRespuestaDto)
  async crear(@Body() dto: CrearModeloAeronaveDto): Promise<ModeloAeronaveRespuestaDto> {
    return aModeloAeronaveRespuesta(await this.servicio.crear(dto));
  }

  @Patch(':code')
  @DocCatalogo.actualizar(ENTIDAD, ModeloAeronaveRespuestaDto)
  async actualizar(
    @Param('code', CodigoModeloAeronavePipe) code: string,
    @Body() dto: ActualizarModeloAeronaveDto,
  ): Promise<ModeloAeronaveRespuestaDto> {
    return aModeloAeronaveRespuesta(await this.servicio.actualizar(code, dto));
  }

  @Delete(':code')
  @DocCatalogo.desactivar(ENTIDAD)
  async desactivar(@Param('code', CodigoModeloAeronavePipe) code: string): Promise<void> {
    await this.servicio.desactivar(code);
  }

  @Post(':code/reactivate')
  @DocCatalogo.reactivar(ENTIDAD, ModeloAeronaveRespuestaDto)
  async reactivar(
    @Param('code', CodigoModeloAeronavePipe) code: string,
  ): Promise<ModeloAeronaveRespuestaDto> {
    return aModeloAeronaveRespuesta(await this.servicio.reactivar(code));
  }
}
