import { ApiProperty } from '@nestjs/swagger';

export class UsuarioRespuestaDto {
  @ApiProperty({ format: 'uuid', description: 'Es el `sub` de los tokens' })
  id: string;

  @ApiProperty({ example: 'ana@example.com' })
  email: string;

  @ApiProperty({ example: ['cliente'] })
  roles: string[];

  @ApiProperty({ example: ['flights:read', 'flights:hold'] })
  scopes: string[];

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}
