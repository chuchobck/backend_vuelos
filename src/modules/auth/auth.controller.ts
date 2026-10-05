import { Body, Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LimiteEstricto } from '../../common/decorators/limite-peticiones.decorator';
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

/**
 * Límites por IP y por ruta, aparte del global (RATE_LIMIT_MAX). Cuentan también los
 * intentos fallidos: el límite corre antes que el controller, así que un 401 suma igual.
 */
export const LIMITES_AUTH = {
  // Adivinar contraseñas: 5 intentos por minuto y por IP
  login: { limite: 5, ventanaSegundos: 60 },
  // Crear cuentas en masa o probar qué correos existen (el 409 lo revela). Holgado para un
  // aula entera detrás de la misma IP.
  register: { limite: 10, ventanaSegundos: 600 },
  // Un cliente normal refresca una vez cada 15 minutos; el tope protege la base
  refresh: { limite: 30, ventanaSegundos: 60 },
} as const;

@ApiTags(ETIQUETAS.auth)
@Controller()
export class AuthController {
  constructor(private readonly servicio: AuthService) {}

  @Publico()
  @LimiteEstricto(LIMITES_AUTH.register.limite, LIMITES_AUTH.register.ventanaSegundos)
  @Post('register')
  async registrar(@Body() dto: RegistroDto): Promise<UsuarioRespuestaDto> {
    return aUsuarioRespuesta(await this.servicio.registrar(dto));
  }

  @Publico()
  @LimiteEstricto(LIMITES_AUTH.login.limite, LIMITES_AUTH.login.ventanaSegundos)
  @Post('login')
  @HttpCode(200)
  // RFC 6749, sección 5.1: una respuesta con tokens no se guarda en ninguna caché
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  iniciarSesion(@Body() dto: LoginDto): Promise<TokenRespuestaDto> {
    return this.servicio.iniciarSesion(dto);
  }

  @Publico()
  @LimiteEstricto(LIMITES_AUTH.refresh.limite, LIMITES_AUTH.refresh.ventanaSegundos)
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
