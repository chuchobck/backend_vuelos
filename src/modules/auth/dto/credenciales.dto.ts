import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import {
  SinCaracteresDeControl,
  SinEtiquetasHtml,
} from '../../../common/sanitizacion/texto-limpio.decorator';
import { normalizarTexto } from '../../../common/sanitizacion/texto';

export const LARGO_MINIMO_CONTRASENA = 12;
export const LARGO_MAXIMO_CONTRASENA = 128;
/** Máximo práctico de una dirección de correo (RFC 5321) y el de ck_usuario_correo. */
const LARGO_MAXIMO_CORREO = 254;

/**
 * Correo de una cuenta: la sanitización común (recortar, NFC, sin controles ni HTML) y además
 * en minúsculas, como lo guarda la base (ck_usuario_correo). Así `Ana@Correo.ec ` y
 * `ana@correo.ec` son la misma cuenta.
 */
function CorreoNormalizado() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? normalizarTexto(value).toLowerCase() : value,
    ),
    IsString(),
    SinCaracteresDeControl(),
    SinEtiquetasHtml(),
    MaxLength(LARGO_MAXIMO_CORREO),
    IsEmail({ allow_display_name: false, allow_ip_domain: false, require_tld: true }),
  );
}

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
