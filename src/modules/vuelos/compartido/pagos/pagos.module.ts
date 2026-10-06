import { Module } from '@nestjs/common';
import { PagosSimulados } from './pagos-simulados';
import { SERVICIO_PAGOS } from './servicio-pagos';

/**
 * La Payment API. Para usar la real (RDA2): escribir una clase que implemente ServicioPagos
 * (un cliente HTTP que traduzca la respuesta de la Payment API a EstadoPago) y cambiar aquí
 * `useClass`. Las pruebas reemplazan el provider con `overrideProvider(SERVICIO_PAGOS)`.
 */
@Module({
  providers: [{ provide: SERVICIO_PAGOS, useClass: PagosSimulados }],
  exports: [SERVICIO_PAGOS],
})
export class PagosModule {}
