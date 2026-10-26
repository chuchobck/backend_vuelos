import { Module } from '@nestjs/common';
import { Observabilidad } from '../../../../observabilidad/observabilidad';
import { Cobros } from './cobros';
import { PagosObservados } from './pagos-observados';
import { PagosRepository } from './pagos.repository';
import { PagosSimulados } from './pagos-simulados';
import { SERVICIO_PAGOS } from './servicio-pagos';

/**
 * La Payment API. Para usar la real (RDA2): escribir una clase que implemente ServicioPagos
 * (un cliente HTTP que traduzca la respuesta de la Payment API a EstadoPago) y cambiar aquí la
 * clase que envuelve `PagosObservados` (el span CLIENT y la métrica de cada llamada). Las pruebas reemplazan el provider con `overrideProvider(SERVICIO_PAGOS)`.
 */
@Module({
  providers: [
    {
      provide: SERVICIO_PAGOS,
      useFactory: (observabilidad: Observabilidad) =>
        new PagosObservados(new PagosSimulados(), observabilidad),
      inject: [Observabilidad],
    },
    PagosRepository,
    Cobros,
  ],
  exports: [SERVICIO_PAGOS, PagosRepository, Cobros],
})
export class PagosModule {}
