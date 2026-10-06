import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { SinCaracteresDeControl, SinEtiquetasHtml } from './texto-limpio.decorator';
import { normalizarTexto } from './texto';

/** Máximo práctico de una dirección de correo (RFC 5321) y el de ck_usuario_correo. */
export const LARGO_MAXIMO_CORREO = 254;

/**
 * Correo: la sanitización común (recortar, NFC, sin controles ni HTML) y además en minúsculas,
 * como lo guarda la base. Así `Ana@Correo.ec ` y `ana@correo.ec` son el mismo correo. Lo usan
 * las cuentas (auth) y el contacto de los pasajeros (reservas).
 */
export function CorreoNormalizado() {
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
