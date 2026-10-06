import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  CorreoNormalizado,
  LARGO_MAXIMO_CORREO,
} from '../../../common/sanitizacion/correo.decorator';

export const LARGO_MINIMO_CONTRASENA = 12;
export const LARGO_MAXIMO_CONTRASENA = 128;

/**
 * Contraseña: de 12 a 128 caracteres y nada más. Sin reglas de composición (mayúsculas,
 * símbolos): con la longitud alcanza y obligan a contraseñas peores (NIST SP 800-63B).
 * No se recorta: un espacio al borde es parte de la contraseña. Se normaliza a NFKC, como
 * recomienda NIST, para que la misma contraseña escrita en otro teclado dé el mismo hash.
 */
function Contrasena() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.normalize('NFKC') : value,
    ),
    IsString(),
    MinLength(LARGO_MINIMO_CONTRASENA),
    MaxLength(LARGO_MAXIMO_CONTRASENA),
  );
}

export class RegistroDto {
  @ApiProperty({ example: 'ana@example.com', maxLength: LARGO_MAXIMO_CORREO })
  @CorreoNormalizado()
  email: string;

  @ApiProperty({
    example: 'una frase larga y fácil de recordar',
    minLength: LARGO_MINIMO_CONTRASENA,
    maxLength: LARGO_MAXIMO_CONTRASENA,
    format: 'password',
  })
  @Contrasena()
  password: string;
}

/**
 * Login: mismo formato que el registro. Una contraseña fuera de 12 a 128 caracteres no puede
 * existir, pero se valida igual (400) para no llegar a argon2 con 1 MB de texto.
 */
export class LoginDto extends RegistroDto {}
