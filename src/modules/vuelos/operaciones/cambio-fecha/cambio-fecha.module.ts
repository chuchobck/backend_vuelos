import { Module } from '@nestjs/common';
import { BusquedaModule } from '../busqueda/busqueda.module';
import { ReservaModule } from '../reserva/reserva.module';
import { CambioFechaController } from './cambio-fecha.controller';
import { CambioFechaRepository } from './cambio-fecha.repository';
import { CambioFechaService } from './cambio-fecha.service';

/**
 * Cambio de fecha de una reserva (cambio_cabecera y cambio_detalle, sin controller propio de
 * las tablas). Busca con BusquedaService y cambia la reserva con ReservaService.
 */
@Module({
  imports: [ReservaModule, BusquedaModule],
  controllers: [CambioFechaController],
  providers: [CambioFechaService, CambioFechaRepository],
  exports: [CambioFechaService],
})
export class CambioFechaModule {}
