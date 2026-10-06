import { Module } from '@nestjs/common';
import { Cobros } from './cobros';
import { PagosRepository } from './pagos.repository';
import { PagosSimulados } from './pagos-simulados';
import { SERVICIO_PAGOS } from './servicio-pagos';

/**
 * La Payment API. Para usar la real (RDA2): escribir una clase que implemente ServicioPagos
 * (un cliente HTTP que traduzca la respuesta de la Payment API a EstadoPago) y cambiar aquí
 * `useClass`. Las pruebas reemplazan el provider con `overrideProvider(SERVICIO_PAGOS)`.
 */
@Module({
  providers: [{ provide: SERVICIO_PAGOS, useClass: PagosSimulados }, PagosRepository, Cobros],
  exports: [SERVICIO_PAGOS, PagosRepository, Cobros],
})
export class PagosModule {}
