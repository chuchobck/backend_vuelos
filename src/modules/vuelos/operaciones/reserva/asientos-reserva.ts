import { CodigoError, CODIGO_SIN_EQUIVALENTE } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { clase_cabina } from '../../../../generated/prisma/client';
import { CABINA } from '../../compartido/enums';
import { cuerpoInvalido } from '../../compartido/errores';
import { PasajeroReservaDto } from './dto/solicitud-reserva.dto';
import { AsientoDeSalida } from './reserva.repository';

/** Una salida del hold con la cabina que se retuvo en ella. */
export interface SalidaConCabina {
  id: string;
  cabina: clase_cabina;
}

/** Un asiento elegido por un pasajero, ya validado contra el hold. */
export interface AsientoPedido {
  /** Posición del pasajero en el cuerpo, para el campo del error. */
  indice: number;
  codigoPasajero: string;
  salidaId: string;
  numero: string;
}

const seatTaken = (detalle: string) => new ErrorNegocio(409, CodigoError.SEAT_TAKEN, detalle);

/**
 * Lo que se puede validar de los asientos elegidos sin mirar la base: el segmento es del hold
 * (422), un infante no elige asiento (422 INFANT_SEAT_NOT_ALLOWED), un pasajero elige a lo
 * sumo uno por segmento y dos pasajeros no eligen el mismo (400).
 */
export function validarAsientosElegidos(
  pasajeros: PasajeroReservaDto[],
  salidas: SalidaConCabina[],
): AsientoPedido[] {
  const delHold = new Set(salidas.map((s) => s.id));
  const tomados = new Set<string>();
  const pedidos: AsientoPedido[] = [];
  pasajeros.forEach((p, i) => {
    const elegidos = p.assignedSeats ?? [];
    if (elegidos.length > 0 && p.passengerType === 'INFANT') {
      throw new ErrorNegocio(
        422,
        CodigoError.INFANT_SEAT_NOT_ALLOWED,
        `passengers[${i}].assignedSeats: an infant travels on an adult's lap and has no seat`,
        { invalidParams: [{ name: `passengers[${i}].assignedSeats`, reason: 'infant' }] },
      );
    }
    const segmentos = new Set<string>();
    elegidos.forEach((a, j) => {
      const campo = `passengers[${i}].assignedSeats[${j}]`;
      if (!delHold.has(a.segmentId)) {
        throw new ErrorNegocio(
          422,
          CODIGO_SIN_EQUIVALENTE,
          `${campo}.segmentId: is not a segment of the hold`,
          {
            invalidParams: [{ name: `${campo}.segmentId`, reason: 'is not a segment of the hold' }],
          },
        );
      }
      if (segmentos.has(a.segmentId)) {
        throw cuerpoInvalido(`${campo}.segmentId`, 'a passenger has one seat per segment');
      }
      segmentos.add(a.segmentId);
      const asiento = `${a.segmentId}|${a.seatNumber}`;
      if (tomados.has(asiento)) {
        throw cuerpoInvalido(`${campo}.seatNumber`, 'is chosen by another passenger');
      }
      tomados.add(asiento);
      pedidos.push({
        indice: i,
        codigoPasajero: p.passengerId,
        salidaId: a.segmentId,
        numero: a.seatNumber,
      });
    });
  });
  return pedidos;
}

/**
 * Asigna un asiento por segmento a cada pasajero con asiento (los infantes no), con el mapa
 * de la base ya bloqueado (ver ReservaRepository.bloquearCabinas):
 *
 * - Un asiento elegido debe existir en la aeronave de esa salida (422), ser de la cabina del
 *   hold (422 SEAT_CABIN_MISMATCH) y estar libre (409 SEAT_TAKEN).
 * - Sin asiento elegido, la regla es determinista: el primero libre de esa cabina por fila y
 *   letra (1A, 1B, ... 2A), en el orden de los pasajeros del cuerpo y sin repetir los que ya
 *   eligió otro pasajero de la misma reserva.
 */
export function asignarAsientos(
  pasajeros: PasajeroReservaDto[],
  salidas: SalidaConCabina[],
  pedidos: AsientoPedido[],
  mapa: AsientoDeSalida[],
): Array<{ codigoPasajero: string; salidaId: string; asientoId: bigint }> {
  const usados = new Set<bigint>();
  const asignados: Array<{ codigoPasajero: string; salidaId: string; asientoId: bigint }> = [];

  for (const pedido of pedidos) {
    const salida = salidas.find((s) => s.id === pedido.salidaId)!;
    const campo = `passengers[${pedido.indice}].assignedSeats`;
    const asiento = mapa.find((a) => a.salidaId === salida.id && a.numero === pedido.numero);
    if (!asiento) {
      throw new ErrorNegocio(
        422,
        CODIGO_SIN_EQUIVALENTE,
        `${campo}: seat ${pedido.numero} does not exist on this aircraft`,
        { invalidParams: [{ name: campo, reason: 'seat does not exist on this aircraft' }] },
      );
    }
    if (asiento.cabina !== salida.cabina) {
      throw new ErrorNegocio(
        422,
        CodigoError.SEAT_CABIN_MISMATCH,
        `${campo}: seat ${pedido.numero} is in ${CABINA.aContrato(asiento.cabina)}, ` +
          `but the hold is for ${CABINA.aContrato(salida.cabina)}`,
        { invalidParams: [{ name: campo, reason: 'seat is in another cabin' }] },
      );
    }
    if (asiento.ocupado) throw seatTaken(`Seat ${pedido.numero} is already taken on this flight`);
    usados.add(asiento.asientoId);
    asignados.push({
      codigoPasajero: pedido.codigoPasajero,
      salidaId: salida.id,
      asientoId: asiento.asientoId,
    });
  }

  for (const salida of salidas) {
    const libres = mapa.filter(
      (a) => a.salidaId === salida.id && a.cabina === salida.cabina && !a.ocupado,
    );
    for (const p of pasajeros) {
      if (p.passengerType === 'INFANT') continue;
      if (pedidos.some((x) => x.codigoPasajero === p.passengerId && x.salidaId === salida.id)) {
        continue;
      }
      const asiento = libres.find((a) => !usados.has(a.asientoId));
      if (!asiento) {
        throw seatTaken(
          `No free seat is left in ${CABINA.aContrato(salida.cabina)} on this flight`,
        );
      }
      usados.add(asiento.asientoId);
      asignados.push({
        codigoPasajero: p.passengerId,
        salidaId: salida.id,
        asientoId: asiento.asientoId,
      });
    }
  }
  return asignados;
}
