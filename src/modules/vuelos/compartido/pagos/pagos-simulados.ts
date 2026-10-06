import { Injectable } from '@nestjs/common';
import {
  CobroEsperado,
  EstadoPago,
  EstadoReembolso,
  ReembolsoPedido,
  ServicioPagos,
} from './servicio-pagos';

/**
 * La regla de la Payment API simulada: el estado sale del prefijo de la referencia, sin
 * estado guardado ni azar, así que la misma referencia da siempre lo mismo.
 *
 * | Referencia          | autorizar | consultar (después) |
 * | ------------------- | --------- | ------------------- |
 * | `PAY-OK-<código>`   | APROBADO  | APROBADO            |
 * | `PAY-PEND-<código>` | PENDIENTE | APROBADO            |
 * | `PAY-REJ-<código>`  | RECHAZADO | RECHAZADO           |
 * | cualquier otra      | INVALIDO  | RECHAZADO           |
 *
 * `<código>` son de 4 a 50 letras mayúsculas o dígitos. Un pago pendiente se aprueba en la
 * primera consulta posterior (la que hace el proceso de emisión). No revisa el monto: la
 * Payment API real sí lo haría con `CobroEsperado`.
 *
 * Un reembolso sigue al pago que devuelve: si el pago fue `PAY-OK-…`, se aprueba al pedirlo; si
 * fue `PAY-PEND-…` (aprobado después), queda PENDIENTE y se aprueba al consultarlo. Cualquier
 * otro, RECHAZADO (no hay reservas pagadas con otra referencia).
 */
export const REGLA_PAGO_SIMULADO = /^PAY-(OK|PEND|REJ)-[A-Z0-9]{4,50}$/;

@Injectable()
export class PagosSimulados implements ServicioPagos {
  autorizar({ referencia }: CobroEsperado): Promise<EstadoPago> {
    const tipo = REGLA_PAGO_SIMULADO.exec(referencia)?.[1];
    const estado: EstadoPago =
      tipo === 'OK'
        ? 'APROBADO'
        : tipo === 'PEND'
          ? 'PENDIENTE'
          : tipo === 'REJ'
            ? 'RECHAZADO'
            : 'INVALIDO';
    return Promise.resolve(estado);
  }

  consultar(referencia: string): Promise<Exclude<EstadoPago, 'INVALIDO'>> {
    const tipo = REGLA_PAGO_SIMULADO.exec(referencia)?.[1];
    return Promise.resolve(tipo === 'OK' || tipo === 'PEND' ? 'APROBADO' : 'RECHAZADO');
  }

  reembolsar({ referenciaPago }: ReembolsoPedido): Promise<EstadoReembolso> {
    const tipo = REGLA_PAGO_SIMULADO.exec(referenciaPago)?.[1];
    return Promise.resolve(
      tipo === 'OK' ? 'APROBADO' : tipo === 'PEND' ? 'PENDIENTE' : 'RECHAZADO',
    );
  }

  consultarReembolso({ referenciaPago }: ReembolsoPedido): Promise<EstadoReembolso> {
    const tipo = REGLA_PAGO_SIMULADO.exec(referenciaPago)?.[1];
    return Promise.resolve(tipo === 'OK' || tipo === 'PEND' ? 'APROBADO' : 'RECHAZADO');
  }
}
