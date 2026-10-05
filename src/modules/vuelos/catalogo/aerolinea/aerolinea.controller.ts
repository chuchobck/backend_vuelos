import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CodigoIataAerolineaPipe } from '../../../../common/pipes/codigo-iata.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ControllerAdmin, DocCatalogo } from '../base/documentacion-catalogo';
import { aPagina, filtroBase, Pagina } from '../base/paginacion';
import { aAerolineaRespuesta } from './aerolinea.mapper';
import { AerolineaService } from './aerolinea.service';
import {
  ActualizarAerolineaDto,
  AerolineaRespuestaDto,
  ConsultaAerolineaDto,
  CrearAerolineaDto,
} from './dto/aerolinea.dto';

const ENTIDAD = 'airlines';

@ControllerAdmin(ETIQUETAS.adminAerolinea)
export class AerolineaController {
  constructor(private readonly servicio: AerolineaService) {}

  @Get()
  @DocCatalogo.listar(ENTIDAD, AerolineaRespuestaDto)
  async listar(@Query() consulta: ConsultaAerolineaDto): Promise<Pagina<AerolineaRespuestaDto>> {
    const pagina = await this.servicio.listar(
      filtroBase(consulta),
      consulta.limit,
      consulta.cursor,
    );
    return aPagina(pagina, aAerolineaRespuesta);
  }

  @Get(':code')
  @DocCatalogo.obtener(ENTIDAD, AerolineaRespuestaDto)
  async obtener(
    @Param('code', CodigoIataAerolineaPipe) code: string,
  ): Promise<AerolineaRespuestaDto> {
    return aAerolineaRespuesta(await this.servicio.obtener(code));
  }

  @Post()
  @DocCatalogo.crear(ENTIDAD, AerolineaRespuestaDto)
  async crear(@Body() dto: CrearAerolineaDto): Promise<AerolineaRespuestaDto> {
    return aAerolineaRespuesta(await this.servicio.crear(dto));
  }

  @Patch(':code')
  @DocCatalogo.actualizar(ENTIDAD, AerolineaRespuestaDto)
  async actualizar(
    @Param('code', CodigoIataAerolineaPipe) code: string,
    @Body() dto: ActualizarAerolineaDto,
  ): Promise<AerolineaRespuestaDto> {
    return aAerolineaRespuesta(await this.servicio.actualizar(code, dto));
  }

  @Delete(':code')
  @DocCatalogo.desactivar(ENTIDAD)
  async desactivar(@Param('code', CodigoIataAerolineaPipe) code: string): Promise<void> {
    await this.servicio.desactivar(code);
  }

  @Post(':code/reactivate')
  @DocCatalogo.reactivar(ENTIDAD, AerolineaRespuestaDto)
  async reactivar(
    @Param('code', CodigoIataAerolineaPipe) code: string,
  ): Promise<AerolineaRespuestaDto> {
    return aAerolineaRespuesta(await this.servicio.reactivar(code));
  }
}
