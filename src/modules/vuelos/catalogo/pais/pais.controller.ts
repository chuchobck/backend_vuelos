import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CodigoPaisPipe } from '../../../../common/pipes/codigo-iata.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ControllerAdmin, DocCatalogo } from '../base/documentacion-catalogo';
import { aPagina, filtroBase, Pagina } from '../base/paginacion';
import { ActualizarPaisDto, ConsultaPaisDto, CrearPaisDto, PaisRespuestaDto } from './dto/pais.dto';
import { aPaisRespuesta } from './pais.mapper';
import { PaisService } from './pais.service';

const ENTIDAD = 'countries';

@ControllerAdmin(ETIQUETAS.adminPais)
export class PaisController {
  constructor(private readonly servicio: PaisService) {}

  @Get()
  @DocCatalogo.listar(ENTIDAD, PaisRespuestaDto)
  async listar(@Query() consulta: ConsultaPaisDto): Promise<Pagina<PaisRespuestaDto>> {
    const pagina = await this.servicio.listar(
      filtroBase(consulta),
      consulta.limit,
      consulta.cursor,
    );
    return aPagina(pagina, aPaisRespuesta);
  }

  @Get(':code')
  @DocCatalogo.obtener(ENTIDAD, PaisRespuestaDto)
  async obtener(@Param('code', CodigoPaisPipe) code: string): Promise<PaisRespuestaDto> {
    return aPaisRespuesta(await this.servicio.obtener(code));
  }

  @Post()
  @DocCatalogo.crear(ENTIDAD, PaisRespuestaDto)
  async crear(@Body() dto: CrearPaisDto): Promise<PaisRespuestaDto> {
    return aPaisRespuesta(await this.servicio.crear(dto));
  }

  @Patch(':code')
  @DocCatalogo.actualizar(ENTIDAD, PaisRespuestaDto)
  async actualizar(
    @Param('code', CodigoPaisPipe) code: string,
    @Body() dto: ActualizarPaisDto,
  ): Promise<PaisRespuestaDto> {
    return aPaisRespuesta(await this.servicio.actualizar(code, dto));
  }

  @Delete(':code')
  @DocCatalogo.desactivar(ENTIDAD)
  async desactivar(@Param('code', CodigoPaisPipe) code: string): Promise<void> {
    await this.servicio.desactivar(code);
  }

  @Post(':code/reactivate')
  @DocCatalogo.reactivar(ENTIDAD, PaisRespuestaDto)
  async reactivar(@Param('code', CodigoPaisPipe) code: string): Promise<PaisRespuestaDto> {
    return aPaisRespuesta(await this.servicio.reactivar(code));
  }
}
