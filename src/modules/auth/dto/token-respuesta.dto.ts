import { ApiProperty } from '@nestjs/swagger';

/**
 * Respuesta de login y refresh con los nombres de OAuth 2.0 (RFC 6749, sección 5.1), en
 * snake_case como el estándar: el contrato delega la autenticación en un servidor OAuth2 y
 * un cliente de OAuth2 espera estos campos.
 */
export class TokenRespuestaDto {
  @ApiProperty({ description: 'JWT de acceso; va en Authorization: Bearer <token>' })
  access_token: string;

  @ApiProperty({ enum: ['Bearer'] })
  token_type: 'Bearer';

  @ApiProperty({ example: 900, description: 'Segundos de vida del token de acceso' })
  expires_in: number;

  @ApiProperty({ description: 'Token opaco para POST /auth/refresh; se rota en cada uso' })
  refresh_token: string;

  @ApiProperty({
    example: 'flights:read flights:hold flights:book',
    description: 'Scopes concedidos, separados por espacio',
  })
  scope: string;
}
