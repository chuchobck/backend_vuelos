import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { CABINA } from '../../compartido/enums';
import { ControllerAdmin, DocCatalogo } from '../base/documentacion-catalogo';
import { aPagina, filtroBase, Pagina } from '../base/paginacion';
import {
  ActualizarFamiliaTarifaDto,
  ConsultaFamiliaTarifaDto,
  CrearFamiliaTarifaDto,
  FamiliaTarifaRespuestaDto,
} from './dto/familia-tarifa.dto';
import { aFamiliaTarifaRespuesta } from './familia-tarifa.mapper';
import { FamiliaTarifaService } from './familia-tarifa.service';

const ENTIDAD = 'fare families';

@ControllerAdmin(ETIQUETAS.adminFamiliaTarifa)
export class FamiliaTarifaController {
  constructor(private readonly servicio: FamiliaTarifaService) {}

  @Get()
  @DocCatalogo.listar(ENTIDAD, FamiliaTarifaRespuestaDto)
  async listar(
    @Query() consulta: ConsultaFamiliaTarifaDto,
  ): Promise<Pagina<FamiliaTarifaRespuestaDto>> {
    const pagina = await this.servicio.listar(
      {
        ...filtroBase(consulta),
        codigoAerolinea: consulta.airline,
        claseCabina: consulta.cabinClass ? CABINA.aBase(consulta.cabinClass) : undefined,
      },
      consulta.limit,
      consulta.cursor,
    );
    return aPagina(pagina, aFamiliaTarifaRespuesta);
  }

  @Get(':id')
  @DocCatalogo.obtener(ENTIDAD, FamiliaTarifaRespuestaDto)
  async obtener(@Param('id', UuidPipe) id: string): Promise<FamiliaTarifaRespuestaDto> {
    return aFamiliaTarifaRespuesta(await this.servicio.obtener(id));
  }

  @Post()
  @DocCatalogo.crear(ENTIDAD, FamiliaTarifaRespuestaDto)
  async crear(@Body() dto: CrearFamiliaTarifaDto): Promise<FamiliaTarifaRespuestaDto> {
    return aFamiliaTarifaRespuesta(await this.servicio.crear(dto));
  }

  @Patch(':id')
  @DocCatalogo.actualizar(ENTIDAD, FamiliaTarifaRespuestaDto)
  async actualizar(
    @Param('id', UuidPipe) id: string,
    @Body() dto: ActualizarFamiliaTarifaDto,
  ): Promise<FamiliaTarifaRespuestaDto> {
    return aFamiliaTarifaRespuesta(await this.servicio.actualizar(id, dto));
  }

  @Delete(':id')
  @DocCatalogo.desactivar(ENTIDAD)
  async desactivar(@Param('id', UuidPipe) id: string): Promise<void> {
    await this.servicio.desactivar(id);
  }

  @Post(':id/reactivate')
  @DocCatalogo.reactivar(ENTIDAD, FamiliaTarifaRespuestaDto)
  async reactivar(@Param('id', UuidPipe) id: string): Promise<FamiliaTarifaRespuestaDto> {
    return aFamiliaTarifaRespuesta(await this.servicio.reactivar(id));
  }
}
