import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, ValidationOptions, registerDecorator } from 'class-validator';
import {
  OpcionesControl,
  normalizarTexto,
  tieneCaracteresDeControl,
  tieneEtiquetasHtml,
} from './texto';

/**
 * Recorta los bordes y normaliza a NFC. Corre en la transformación del DTO, antes de que se
 * validen las demás reglas, así que `@IsNotEmpty` ya ve el texto recortado. Lo que no es
 * texto se deja igual para que `@IsString` lo rechace con su mensaje.
 */
export const RecortarYNormalizar = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'string') return normalizarTexto(value);
    if (Array.isArray(value)) {
      return value.map((item) => (typeof item === 'string' ? normalizarTexto(item) : item));
    }
    return value;
  });

/** Rechaza (400 VALIDATION_FAILED) texto con caracteres de control o invisibles. */
export function SinCaracteresDeControl(
  opciones: OpcionesControl = {},
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (objeto, propiedad) =>
    registerDecorator({
      name: 'sinCaracteresDeControl',
      target: objeto.constructor,
      propertyName: propiedad as string,
      options: validationOptions,
      validator: {
        validate: (valor: unknown) =>
          typeof valor !== 'string' || !tieneCaracteresDeControl(valor, opciones),
        defaultMessage: ({ property }) => `${property} must not contain control characters`,
      },
    });
}

/** Rechaza (400 VALIDATION_FAILED) texto con etiquetas HTML (`<b>`, `</p>`, `<!--`, `<?`). */
export function SinEtiquetasHtml(validationOptions?: ValidationOptions): PropertyDecorator {
  return (objeto, propiedad) =>
    registerDecorator({
      name: 'sinEtiquetasHtml',
      target: objeto.constructor,
      propertyName: propiedad as string,
      options: validationOptions,
      validator: {
        validate: (valor: unknown) => typeof valor !== 'string' || !tieneEtiquetasHtml(valor),
        defaultMessage: ({ property }) => `${property} must not contain HTML tags`,
      },
    });
}

/**
 * Para todo campo de texto libre que llega del cliente (nombres, documentos, motivos, URL):
 * recorta, normaliza a NFC, exige texto y rechaza caracteres de control y etiquetas HTML.
 * Con `each: true` aplica la misma regla a cada elemento de un arreglo de textos.
 *
 *   class PasajeroDto {
 *     @TextoLimpio()
 *     @IsNotEmpty() @MaxLength(100)
 *     firstName: string;
 *
 *     @TextoLimpio({ multilinea: true })
 *     @IsOptional() @MaxLength(500)
 *     remarks?: string;
 *   }
 */
export function TextoLimpio(
  opciones: OpcionesControl & { each?: boolean } = {},
): PropertyDecorator {
  const { each, ...control } = opciones;
  const validacion: ValidationOptions = { each };
  return applyDecorators(
    RecortarYNormalizar(),
    IsString(validacion),
    SinCaracteresDeControl(control, validacion),
    SinEtiquetasHtml(validacion),
  );
}
