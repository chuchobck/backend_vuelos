import { Module } from '@nestjs/common';
import { IdempotenciaRepository } from '../../compartido/idempotencia.repository';
import { RetencionController } from './retencion.controller';
import { RetencionRepository } from './retencion.repository';
import { RetencionService } from './retencion.service';
import { VencimientoRetenciones } from './vencimiento-retenciones';

/**
 * /offers/hold (contrato). retencion_detalle no tiene controller: la maneja este service, y
 * clave_idempotencia también (se escribe en la misma transacción que el hold).
 * VencimientoRetenciones vence periódicamente los holds abandonados.
 */
@Module({
  controllers: [RetencionController],
  providers: [
    RetencionService,
    RetencionRepository,
    IdempotenciaRepository,
    VencimientoRetenciones,
  ],
  exports: [RetencionService],
})
export class RetencionModule {}
