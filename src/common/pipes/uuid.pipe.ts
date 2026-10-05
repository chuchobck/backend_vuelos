import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { esUuid, rechazarParametro } from './formatos';

/**
 * Exige un UUID en un parámetro de ruta o de query; si no, 400 VALIDATION_FAILED.
 *
 *   @Get(':bookingId')
 *   detalle(@Param('bookingId', UuidPipe) bookingId: string) {}
 */
@Injectable()
export class UuidPipe implements PipeTransform<unknown, string> {
  transform(valor: unknown, metadata: ArgumentMetadata): string {
    if (!esUuid(valor)) rechazarParametro(metadata, 'must be a UUID');
    return valor as string;
  }
}
