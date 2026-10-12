import { Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { ETIQUETAS } from '../../../../config/swagger';
import { ControllerAdmin } from '../../catalogo/base/documentacion-catalogo';
import { aListaAuditoria } from './auditoria.mapper';
import { AuditoriaService } from './auditoria.service';
import { ConsultaAuditoriaDto, ListaAuditoriaDto } from './dto/auditoria.dto';

@ControllerAdmin(ETIQUETAS.adminAuditoria)
export class AuditoriaController {
  constructor(private readonly servicio: AuditoriaService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar el registro de auditoría (más recientes primero)',
    description:
      'Solo lectura. Cada alta, cambio y baja de las tablas de negocio, con quién y desde qué IP. ' +
      'before/after son las columnas afectadas; todo valor sensible (hashes de contraseña, tokens, ' +
      'secretos) sale como "[REDACTED]". Filtros: table, operation, recordId, userId y el rango ' +
      'from/to (días UTC, incluidos).',
  })
  @ApiOkResponse({
    type: ListaAuditoriaDto,
    description: 'Una página. Sin `nextCursor`, no hay más',
  })
  @ApiProblema(
    400,
    'Un filtro inválido (operation, fechas, limit) o un cursor que no es de esta lista',
  )
  async listar(@Query() consulta: ConsultaAuditoriaDto): Promise<ListaAuditoriaDto> {
    return aListaAuditoria(await this.servicio.listar(consulta));
  }
}
