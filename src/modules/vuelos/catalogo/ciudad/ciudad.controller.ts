import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ControllerAdmin, DocCatalogo } from '../base/documentacion-catalogo';
import { aPagina, filtroBase, Pagina } from '../base/paginacion';
import { aCiudadRespuesta } from './ciudad.mapper';
import { CiudadService } from './ciudad.service';
import {
  ActualizarCiudadDto,
  CiudadRespuestaDto,
  ConsultaCiudadDto,
  CrearCiudadDto,
} from './dto/ciudad.dto';

const ENTIDAD = 'cities';

@ControllerAdmin(ETIQUETAS.adminCiudad)
export class CiudadController {
  constructor(private readonly servicio: CiudadService) {}

  @Get()
  @DocCatalogo.listar(ENTIDAD, CiudadRespuestaDto)
  async listar(@Query() consulta: ConsultaCiudadDto): Promise<Pagina<CiudadRespuestaDto>> {
    const pagina = await this.servicio.listar(
      { ...filtroBase(consulta), codigoPais: consulta.country },
      consulta.limit,
      consulta.cursor,
    );
    return aPagina(pagina, aCiudadRespuesta);
  }

  @Get(':id')
  @DocCatalogo.obtener(ENTIDAD, CiudadRespuestaDto)
  async obtener(@Param('id', UuidPipe) id: string): Promise<CiudadRespuestaDto> {
    return aCiudadRespuesta(await this.servicio.obtener(id));
  }

  @Post()
  @DocCatalogo.crear(ENTIDAD, CiudadRespuestaDto)
  async crear(@Body() dto: CrearCiudadDto): Promise<CiudadRespuestaDto> {
    return aCiudadRespuesta(await this.servicio.crear(dto));
  }

  @Patch(':id')
  @DocCatalogo.actualizar(ENTIDAD, CiudadRespuestaDto)
  async actualizar(
    @Param('id', UuidPipe) id: string,
    @Body() dto: ActualizarCiudadDto,
  ): Promise<CiudadRespuestaDto> {
    return aCiudadRespuesta(await this.servicio.actualizar(id, dto));
  }

  @Delete(':id')
  @DocCatalogo.desactivar(ENTIDAD)
  async desactivar(@Param('id', UuidPipe) id: string): Promise<void> {
    await this.servicio.desactivar(id);
  }

  @Post(':id/reactivate')
  @DocCatalogo.reactivar(ENTIDAD, CiudadRespuestaDto)
  async reactivar(@Param('id', UuidPipe) id: string): Promise<CiudadRespuestaDto> {
    return aCiudadRespuesta(await this.servicio.reactivar(id));
  }
}
