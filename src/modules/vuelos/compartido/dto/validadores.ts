import { registerDecorator, ValidationOptions } from 'class-validator';
import { fechaIsoAUtc } from '../../../../common/pipes/formatos';

/** `YYYY-MM-DD` que existe en el calendario (rechaza 2026-02-30). */
export function FechaIso(opciones?: ValidationOptions): PropertyDecorator {
  return (objeto, propiedad) =>
    registerDecorator({
      name: 'fechaIso',
      target: objeto.constructor,
      propertyName: propiedad as string,
      options: opciones,
      validator: {
        validate: (valor: unknown) => fechaIsoAUtc(valor) !== undefined,
        defaultMessage: ({ property }) => `${property} must be a valid date (YYYY-MM-DD)`,
      },
    });
}
