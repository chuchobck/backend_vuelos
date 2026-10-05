import { Body, Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Publico } from '../../common/decorators/publico.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../common/decorators/usuario-actual.decorator';
import { ETIQUETAS } from '../../config/swagger';
import { aUsuarioRespuesta } from './auth.mapper';
import { AuthService } from './auth.service';
import { LoginDto, RegistroDto } from './dto/credenciales.dto';
import { RefrescoDto } from './dto/refresco.dto';
import { TokenRespuestaDto } from './dto/token-respuesta.dto';
import { UsuarioRespuestaDto } from './dto/usuario-respuesta.dto';

@ApiTags(ETIQUETAS.auth)
@Controller()
export class AuthController {
  constructor(private readonly servicio: AuthService) {}

  @Publico()
  @Post('register')
  async registrar(@Body() dto: RegistroDto): Promise<UsuarioRespuestaDto> {
    return aUsuarioRespuesta(await this.servicio.registrar(dto));
  }

  @Publico()
  @Post('login')
  @HttpCode(200)
  // RFC 6749, sección 5.1: una respuesta con tokens no se guarda en ninguna caché
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  iniciarSesion(@Body() dto: LoginDto): Promise<TokenRespuestaDto> {
    return this.servicio.iniciarSesion(dto);
  }

  @Publico()
  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  refrescar(@Body() dto: RefrescoDto): Promise<TokenRespuestaDto> {
    return this.servicio.refrescar(dto.refresh_token);
  }

  @Post('logout')
  @HttpCode(204)
  async cerrarSesion(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: RefrescoDto,
  ): Promise<void> {
    await this.servicio.cerrarSesion(usuario.id, dto.refresh_token);
  }

  @Get('me')
  async perfil(@UsuarioActual() usuario: UsuarioAutenticado): Promise<UsuarioRespuestaDto> {
    return aUsuarioRespuesta(await this.servicio.perfil(usuario.id));
  }
}
