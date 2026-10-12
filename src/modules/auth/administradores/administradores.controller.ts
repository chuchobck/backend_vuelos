import { Body, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { ApiProblema } from '../../../common/decorators/documentacion.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../../common/decorators/usuario-actual.decorator';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../config/swagger';
import { ControllerAdmin } from '../../vuelos/catalogo/base/documentacion-catalogo';
import { AdministradoresService } from './administradores.service';
import { aAdministradorCreado, aListaAdministradores } from './administradores.mapper';
import {
  AdministradorRespuestaDto,
  ConsultaAdministradoresDto,
  CrearAdministradorDto,
  ListaAdministradoresDto,
} from './dto/administrador.dto';

@ControllerAdmin(ETIQUETAS.adminUsuarios)
export class AdministradoresController {
  constructor(private readonly servicio: AdministradoresService) {}

  @Post()
  @ApiOperation({
    summary: 'Crear un administrador',
    description:
      'Crea una cuenta con el rol administrador (el rol lo fija el servidor; el cuerpo no lo admite). ' +
      'Mismas reglas que POST /auth/register: correo válido y contraseña de 12 a 128 caracteres.',
  })
  @ApiCreatedResponse({ type: AdministradorRespuestaDto })
  @ApiProblema(409, 'Ya existe una cuenta con ese correo')
  async crear(@Body() dto: CrearAdministradorDto): Promise<AdministradorRespuestaDto> {
    return aAdministradorCreado(await this.servicio.crear(dto));
  }

  @Get()
  @ApiOperation({
    summary: 'Listar los administradores (sin los dados de baja, salvo includeInactive)',
    description: 'Más recientes primero. Nunca devuelve contraseñas ni hashes.',
  })
  @ApiOkResponse({ type: ListaAdministradoresDto })
  @ApiProblema(400, 'Un cursor que no es de esta lista o un límite inválido')
  async listar(@Query() consulta: ConsultaAdministradoresDto): Promise<ListaAdministradoresDto> {
    return aListaAdministradores(await this.servicio.listar(consulta));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Dar de baja a un administrador (eliminación lógica)',
    description:
      'Deja la cuenta inactiva (no puede iniciar sesión) y revoca sus tokens de refresco; el token ' +
      'de acceso vigente sirve hasta que vence (15 minutos). No borra la fila. Repetirlo no cambia ' +
      'nada. No se puede dar de baja la propia cuenta ni al último administrador activo (409).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Dado de baja' })
  @ApiProblema(404, 'No existe o no es administrador')
  @ApiProblema(409, 'Es la propia cuenta o el último administrador activo')
  async darDeBaja(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', UuidPipe) id: string,
  ): Promise<void> {
    await this.servicio.darDeBaja(id, usuario.id);
  }
}
