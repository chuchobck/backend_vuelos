import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ControllerAdmin, DocCatalogo } from '../base/documentacion-catalogo';
import { aPagina, filtroBase, Pagina } from '../base/paginacion';
import {
  ActualizarTarifaDto,
  ConsultaTarifaDto,
  CrearTarifaDto,
  TarifaRespuestaDto,
} from './dto/tarifa.dto';
import { aTarifaRespuesta } from './tarifa.mapper';
import { TarifaService } from './tarifa.service';

const ENTIDAD = 'fares';

@ControllerAdmin(ETIQUETAS.adminTarifa)
export class TarifaController {
  constructor(private readonly servicio: TarifaService) {}

  @Get()
  @DocCatalogo.listar(ENTIDAD, TarifaRespuestaDto)
  async listar(@Query() consulta: ConsultaTarifaDto): Promise<Pagina<TarifaRespuestaDto>> {
    const pagina = await this.servicio.listar(
      { ...filtroBase(consulta), salidaId: consulta.departureId, familiaId: consulta.fareFamilyId },
      consulta.limit,
      consulta.cursor,
    );
    return aPagina(pagina, aTarifaRespuesta);
  }

  @Get(':id')
  @DocCatalogo.obtener(ENTIDAD, TarifaRespuestaDto)
  async obtener(@Param('id', UuidPipe) id: string): Promise<TarifaRespuestaDto> {
    return aTarifaRespuesta(await this.servicio.obtener(id));
  }

  @Post()
  @DocCatalogo.crear(ENTIDAD, TarifaRespuestaDto)
  async crear(@Body() dto: CrearTarifaDto): Promise<TarifaRespuestaDto> {
    return aTarifaRespuesta(await this.servicio.crear(dto));
  }

  @Patch(':id')
  @DocCatalogo.actualizar(ENTIDAD, TarifaRespuestaDto)
  async actualizar(
    @Param('id', UuidPipe) id: string,
    @Body() dto: ActualizarTarifaDto,
  ): Promise<TarifaRespuestaDto> {
    return aTarifaRespuesta(await this.servicio.actualizar(id, dto));
  }

  @Delete(':id')
  @DocCatalogo.desactivar(ENTIDAD)
  async desactivar(@Param('id', UuidPipe) id: string): Promise<void> {
    await this.servicio.desactivar(id);
  }

  @Post(':id/reactivate')
  @DocCatalogo.reactivar(ENTIDAD, TarifaRespuestaDto)
  async reactivar(@Param('id', UuidPipe) id: string): Promise<TarifaRespuestaDto> {
    return aTarifaRespuesta(await this.servicio.reactivar(id));
  }
}
