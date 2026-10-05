import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ControllerAdmin, DocCatalogo } from '../base/documentacion-catalogo';
import { aPagina, filtroBase, Pagina } from '../base/paginacion';
import {
  ActualizarMapaAsientosDto,
  ConsultaMapaAsientosDto,
  CrearMapaAsientosDto,
  MapaAsientosRespuestaDto,
  MapaAsientosResumenDto,
} from './dto/mapa-asientos.dto';
import { aMapaAsientosRespuesta, aMapaAsientosResumen } from './mapa-asientos.mapper';
import { MapaAsientosService } from './mapa-asientos.service';

const ENTIDAD = 'seat maps';

@ControllerAdmin(ETIQUETAS.adminMapaAsientos)
export class MapaAsientosController {
  constructor(private readonly servicio: MapaAsientosService) {}

  @Get()
  @DocCatalogo.listar(ENTIDAD, MapaAsientosResumenDto)
  async listar(
    @Query() consulta: ConsultaMapaAsientosDto,
  ): Promise<Pagina<MapaAsientosResumenDto>> {
    const pagina = await this.servicio.listar(
      {
        ...filtroBase(consulta),
        codigoAerolinea: consulta.airline,
        codigoModelo: consulta.aircraftModel,
      },
      consulta.limit,
      consulta.cursor,
    );
    return aPagina(pagina, aMapaAsientosResumen);
  }

  @Get(':id')
  @DocCatalogo.obtener(ENTIDAD, MapaAsientosRespuestaDto)
  async obtener(@Param('id', UuidPipe) id: string): Promise<MapaAsientosRespuestaDto> {
    return aMapaAsientosRespuesta(await this.servicio.obtener(id));
  }

  @Post()
  @DocCatalogo.crear(ENTIDAD, MapaAsientosRespuestaDto)
  async crear(@Body() dto: CrearMapaAsientosDto): Promise<MapaAsientosRespuestaDto> {
    return aMapaAsientosRespuesta(await this.servicio.crear(dto));
  }

  @Patch(':id')
  @DocCatalogo.actualizar(ENTIDAD, MapaAsientosRespuestaDto)
  async actualizar(
    @Param('id', UuidPipe) id: string,
    @Body() dto: ActualizarMapaAsientosDto,
  ): Promise<MapaAsientosRespuestaDto> {
    return aMapaAsientosRespuesta(await this.servicio.actualizar(id, dto));
  }

  @Delete(':id')
  @DocCatalogo.desactivar(ENTIDAD)
  async desactivar(@Param('id', UuidPipe) id: string): Promise<void> {
    await this.servicio.desactivar(id);
  }

  @Post(':id/reactivate')
  @DocCatalogo.reactivar(ENTIDAD, MapaAsientosRespuestaDto)
  async reactivar(@Param('id', UuidPipe) id: string): Promise<MapaAsientosRespuestaDto> {
    return aMapaAsientosRespuesta(await this.servicio.reactivar(id));
  }
}
