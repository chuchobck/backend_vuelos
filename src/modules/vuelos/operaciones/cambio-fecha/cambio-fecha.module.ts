import { Module } from '@nestjs/common';
import { IdempotenciaRepository } from '../../compartido/idempotencia.repository';
import { InventarioRepository } from '../../compartido/inventario.repository';
import { PagosModule } from '../../compartido/pagos/pagos.module';
import { BusquedaModule } from '../busqueda/busqueda.module';
import { ReservaModule } from '../reserva/reserva.module';
import { CambioFechaController } from './cambio-fecha.controller';
import { CambioFechaRepository } from './cambio-fecha.repository';
import { CambioFechaService } from './cambio-fecha.service';

/**
 * Cambio de fecha de una reserva (cambio_cabecera y cambio_detalle, sin controller propio de
 * las tablas). Busca con BusquedaService, cobra con PagosModule, mueve el cupo con
 * InventarioRepository y cambia la reserva (asientos, líneas, boletos) con ReservaService.
 */
@Module({
  imports: [ReservaModule, BusquedaModule, PagosModule],
  controllers: [CambioFechaController],
  providers: [
    CambioFechaService,
    CambioFechaRepository,
    InventarioRepository,
    IdempotenciaRepository,
  ],
  exports: [CambioFechaService, CambioFechaRepository],
})
export class CambioFechaModule {}
