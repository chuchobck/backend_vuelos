import { Observabilidad } from '../../../../observabilidad/observabilidad';
import {
  CobroEsperado,
  EstadoPago,
  EstadoReembolso,
  ReembolsoPedido,
  ServicioPagos,
} from './servicio-pagos';

/** Cómo se llama la Payment API en `quinde.upstream` y en las métricas de cliente. */
export const UPSTREAM_PAGOS = 'payments';

/**
 * La Payment API vista por la observabilidad: cada llamada es un span CLIENT hacia `payments`
 * (`POST /payments/authorize`...) y una observación de `http_client_request_duration_seconds`,
 * aunque hoy la simule `PagosSimulados` dentro del proceso; con la Payment API real (RDA2) el
 * cliente HTTP queda detrás del mismo decorador. El nombre y la ruta son fijos: nunca la
 * paymentReference ni el id de la operación (`GET /payments/{reference}`), que son datos del cobro.
 */
export class PagosObservados implements ServicioPagos {
  constructor(
    private readonly pagos: ServicioPagos,
    private readonly observabilidad: Observabilidad,
  ) {}

  autorizar(cobro: CobroEsperado): Promise<EstadoPago> {
    return this.observabilidad.cliente(UPSTREAM_PAGOS, 'POST', '/payments/authorize', () =>
      this.pagos.autorizar(cobro),
    );
  }

  consultar(referencia: string): Promise<Exclude<EstadoPago, 'INVALIDO'>> {
    return this.observabilidad.cliente(UPSTREAM_PAGOS, 'GET', '/payments/{reference}', () =>
      this.pagos.consultar(referencia),
    );
  }

  reembolsar(reembolso: ReembolsoPedido): Promise<EstadoReembolso> {
    return this.observabilidad.cliente(UPSTREAM_PAGOS, 'POST', '/payments/refunds', () =>
      this.pagos.reembolsar(reembolso),
    );
  }

  consultarReembolso(reembolso: ReembolsoPedido): Promise<EstadoReembolso> {
    return this.observabilidad.cliente(UPSTREAM_PAGOS, 'GET', '/payments/refunds/{operation}', () =>
      this.pagos.consultarReembolso(reembolso),
    );
  }
}
