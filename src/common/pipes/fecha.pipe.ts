import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { fechaIsoAUtc, rechazarParametro } from './formatos';

/**
 * Exige una fecha `YYYY-MM-DD` que exista (rechaza 2026-02-30) y la entrega como `Date` a
 * medianoche UTC, igual que un `date` de la base.
 *
 *   @Get('status')
 *   estado(@Query('date', FechaPipe) fecha: Date) {}
 */
@Injectable()
export class FechaPipe implements PipeTransform<unknown, Date> {
  transform(valor: unknown, metadata: ArgumentMetadata): Date {
    const fecha = fechaIsoAUtc(valor);
    if (fecha === undefined) rechazarParametro(metadata, 'must be a valid date (YYYY-MM-DD)');
    return fecha as Date;
  }
}
