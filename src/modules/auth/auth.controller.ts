import { Body, Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiProblema,
  DocumentarAutenticacion,
} from '../../common/decorators/documentacion.decorator';
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
  @ApiOperation({
    summary: 'Crear una cuenta de cliente',
    description:
      'Registro público: crea un usuario con el rol cliente (scopes de lectura, hold, reserva, cancelación y webhooks). Después, POST /auth/login entrega el token para el botón Authorize.',
  })
  @ApiCreatedResponse({ type: UsuarioRespuestaDto })
  @ApiProblema(400, 'Correo inválido o contraseña fuera de 12 a 128 caracteres')
  @ApiProblema(409, 'Ya existe una cuenta con ese correo')
  @ApiProblema(429, `Más de ${LIMITES_AUTH.register.limite} registros por IP en 10 minutos`)
  async registrar(@Body() dto: RegistroDto): Promise<UsuarioRespuestaDto> {
    return aUsuarioRespuesta(await this.servicio.registrar(dto));
  }

  @Publico()
  @LimiteEstricto(LIMITES_AUTH.login.limite, LIMITES_AUTH.login.ventanaSegundos)
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Iniciar sesión',
    description:
      'Entrega un access_token (JWT, 15 minutos) y un refresh_token (7 días, se rota en cada uso). ' +
      'Un correo inexistente, una contraseña errónea y una cuenta inactiva responden igual.',
  })
  @ApiOkResponse({ type: TokenRespuestaDto })
  @ApiProblema(400, 'Cuerpo inválido')
  @ApiProblema(401, 'Correo o contraseña incorrectos')
  @ApiProblema(429, `Más de ${LIMITES_AUTH.login.limite} intentos por IP en un minuto`)
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
  @ApiOperation({
    summary: 'Renovar el token de acceso',
    description:
      'Rota el refresh_token: el usado deja de servir. Reusar uno ya rotado revoca la sesión completa.',
  })
  @ApiOkResponse({ type: TokenRespuestaDto })
  @ApiProblema(400, 'Cuerpo inválido')
  @ApiProblema(401, 'Token de refresco inválido, vencido, revocado o reutilizado')
  @ApiProblema(429, `Más de ${LIMITES_AUTH.refresh.limite} renovaciones por IP en un minuto`)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  refrescar(@Body() dto: RefrescoDto): Promise<TokenRespuestaDto> {
    return this.servicio.refrescar(dto.refresh_token);
  }

  @Post('logout')
  @HttpCode(204)
  @DocumentarAutenticacion()
  @ApiOperation({
    summary: 'Cerrar sesión',
    description:
      'Revoca el refresh_token y los demás de su sesión. El access_token vigente sirve hasta que vence.',
  })
  @ApiBody({ type: RefrescoDto })
  @ApiNoContentResponse({ description: 'Sesión cerrada (también si el token ya no era válido)' })
  async cerrarSesion(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: RefrescoDto,
  ): Promise<void> {
    await this.servicio.cerrarSesion(usuario.id, dto.refresh_token);
  }

  @Get('me')
  @DocumentarAutenticacion()
  @ApiOperation({
    summary: 'Perfil, roles y scopes del usuario del token',
    description: 'Sirve para comprobar que el token de Authorize funciona y qué scopes tiene.',
  })
  @ApiOkResponse({ type: UsuarioRespuestaDto })
  async perfil(@UsuarioActual() usuario: UsuarioAutenticado): Promise<UsuarioRespuestaDto> {
    return aUsuarioRespuesta(await this.servicio.perfil(usuario.id));
  }
}
