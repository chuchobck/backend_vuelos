import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { fechaIsoAUtc, rechazarParametro } from '../../../../common/pipes/formatos';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { ESTADO_VUELO } from '../../compartido/enums';
import { ControllerAdmin, DocCatalogo } from '../base/documentacion-catalogo';
import { aPagina, filtroBase, Pagina } from '../base/paginacion';
import { partirNumeroVuelo } from '../vuelo/vuelo.repository';
import {
  ActualizarVueloProgramadoDto,
  ConsultaVueloProgramadoDto,
  CrearVueloProgramadoDto,
  VueloProgramadoRespuestaDto,
} from './dto/vuelo-programado.dto';
import { aVueloProgramadoRespuesta } from './vuelo-programado.mapper';
import { VueloProgramadoService } from './vuelo-programado.service';

const ENTIDAD = 'departures';

/** Una fecha `YYYY-MM-DD` de la query, que además exista en el calendario (400 si no). */
function fechaDeQuery(valor: string | undefined, nombre: string): Date | undefined {
  if (valor === undefined) return undefined;
  const fecha = fechaIsoAUtc(valor);
  if (!fecha) rechazarParametro({ type: 'query', data: nombre }, 'must be a valid date');
  return fecha;
}

/**
 * Salidas programadas (el segmento del contrato). DELETE la cancela (estado CANCELLED) y
 * reactivate la devuelve a SCHEDULED.
 */
@ControllerAdmin(ETIQUETAS.adminVueloProgramado)
export class VueloProgramadoController {
  constructor(private readonly servicio: VueloProgramadoService) {}

  @Get()
  @DocCatalogo.listar(ENTIDAD, VueloProgramadoRespuestaDto)
  async listar(
    @Query() consulta: ConsultaVueloProgramadoDto,
  ): Promise<Pagina<VueloProgramadoRespuestaDto>> {
    const pagina = await this.servicio.listar(
      {
        ...filtroBase(consulta),
        numeroVuelo: consulta.flightNumber ? partirNumeroVuelo(consulta.flightNumber) : undefined,
        fechaDesde: fechaDeQuery(consulta.dateFrom, 'dateFrom'),
        fechaHasta: fechaDeQuery(consulta.dateTo, 'dateTo'),
        estado: consulta.status ? ESTADO_VUELO.aBase(consulta.status) : undefined,
      },
      consulta.limit,
      consulta.cursor,
    );
    return aPagina(pagina, aVueloProgramadoRespuesta);
  }

  @Get(':id')
  @DocCatalogo.obtener(ENTIDAD, VueloProgramadoRespuestaDto)
  async obtener(@Param('id', UuidPipe) id: string): Promise<VueloProgramadoRespuestaDto> {
    return aVueloProgramadoRespuesta(await this.servicio.obtener(id));
  }

  @Post()
  @DocCatalogo.crear(ENTIDAD, VueloProgramadoRespuestaDto)
  async crear(@Body() dto: CrearVueloProgramadoDto): Promise<VueloProgramadoRespuestaDto> {
    return aVueloProgramadoRespuesta(await this.servicio.crear(dto));
  }

  @Patch(':id')
  @DocCatalogo.actualizar(ENTIDAD, VueloProgramadoRespuestaDto)
  async actualizar(
    @Param('id', UuidPipe) id: string,
    @Body() dto: ActualizarVueloProgramadoDto,
  ): Promise<VueloProgramadoRespuestaDto> {
    return aVueloProgramadoRespuesta(await this.servicio.actualizar(id, dto));
  }

  @Delete(':id')
  @DocCatalogo.desactivar('departures (cancels it)')
  async desactivar(@Param('id', UuidPipe) id: string): Promise<void> {
    await this.servicio.desactivar(id);
  }

  @Post(':id/reactivate')
  @DocCatalogo.reactivar(ENTIDAD, VueloProgramadoRespuestaDto)
  async reactivar(@Param('id', UuidPipe) id: string): Promise<VueloProgramadoRespuestaDto> {
    return aVueloProgramadoRespuesta(await this.servicio.reactivar(id));
  }
}
