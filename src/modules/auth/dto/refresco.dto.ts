import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Cuerpo de POST /auth/refresh y POST /auth/logout. El nombre del campo es el de OAuth 2.0
 * (RFC 6749, sección 6). Un token con forma inválida no da 400 sino 401, como uno vencido:
 * así la respuesta no dice si el token existió.
 */
export class RefrescoDto {
  @ApiProperty({ description: 'Token de refresco recibido en el login o en el último refresh' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  refresh_token: string;
}
