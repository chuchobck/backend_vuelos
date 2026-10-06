import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CodigoError } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { Reloj } from '../../../../common/reloj';
import { estado_vuelo } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ESTADO_RESERVA } from '../../compartido/enums';
import { SalidaVendible } from '../busqueda/busqueda.modelo';
import { ItinerarioDeReserva, Reserva } from '../reserva/reserva.modelo';
import { ReservaService } from '../reserva/reserva.service';
import { EstadoCheckinPasajero, PasajeroCheckin, ResultadoCheckin } from './checkin.modelo';
import { CheckinRegistrado, CheckinRepository } from './checkin.repository';

/** Reglas del check-in. */
export const REGLAS_CHECKIN = {
  /** Horas antes de la salida en que abre, si CHECKIN_OPENS_HOURS_BEFORE no dice otra cosa. */
  aperturaPorDefectoHoras: 48,
  /** Minutos antes de la salida en que cierra, si CHECKIN_CLOSES_MINUTES_BEFORE no dice otra. */
  cierrePorDefectoMinutos: 60,
};

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
/** Estados en los que un vuelo todavía admite check-in (los mismos en que se vende). */
const ESTADOS_ABIERTOS: estado_vuelo[] = ['PROGRAMADO', 'DEMORADO'];

type Ventana = 'abierta' | 'aun-no' | 'cerrada';

/** Un vuelo de la reserva con el itinerario al que pertenece. */
interface Tramo {
  salida: SalidaVendible;
  itinerario: ItinerarioDeReserva;
}

const noDisponible = (detalle: string) =>
  new ErrorNegocio(409, CodigoError.CHECK_IN_NOT_AVAILABLE, detalle);

/**
 * POST /bookings/{bookingId}/check-in. Sin cuerpo y sin Idempotency-Key (el contrato no la
 * declara): es idempotente por naturaleza. Cada pasajero y vuelo se registra una sola vez;
 * repetirlo no cambia lo registrado ni el asiento y devuelve el estado actual.
 *
 * Ventana de cada vuelo, con su salida programada: abre CHECKIN_OPENS_HOURS_BEFORE horas antes
 * (48) y cierra CHECKIN_CLOSES_MINUTES_BEFORE minutos antes (60). Solo mientras el vuelo es
 * PROGRAMADO o DEMORADO.
 *
 * - Reserva que no está CONFIRMED (cancelada, pendiente, con cambio pendiente): 409.
 * - Ningún vuelo en ventana y nada registrado antes: 409 CHECK_IN_NOT_AVAILABLE, diciendo cuándo
 *   abre o que ya cerró.
 * - Si no: 200 con lo registrado ahora y antes. Un vuelo que todavía no abre queda
 *   NOT_CHECKED_IN y uno que ya cerró (o cuyo vuelo salió o se canceló) queda FAILED: resultado
 *   parcial, IN_PROGRESS. COMPLETED es todos los pasajeros en todos los vuelos.
 * - Datos que impiden el check-in (un asiento sin asignar, un pasaporte que vence antes del
 *   vuelo): 422 CHECK_IN_FAILED para toda la reserva, sin registrar nada.
 */
@Injectable()
export class CheckinService {
  private readonly aperturaMs: number;
  private readonly cierreMs: number;

  constructor(
    private readonly repositorio: CheckinRepository,
    private readonly reservas: ReservaService,
    private readonly prisma: PrismaService,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.aperturaMs =
      (config.get<number>('CHECKIN_OPENS_HOURS_BEFORE') ?? REGLAS_CHECKIN.aperturaPorDefectoHoras) *
      HORA;
    this.cierreMs =
      (config.get<number>('CHECKIN_CLOSES_MINUTES_BEFORE') ??
        REGLAS_CHECKIN.cierrePorDefectoMinutos) * MINUTO;
  }

  async hacer(reservaId: string, idPropietario: string): Promise<ResultadoCheckin> {
    const ahora = this.reloj.ahora();
    const reserva = await this.reservas.detalle(reservaId, idPropietario);
    exigirElegible(reserva);
    const tramos = tramosDe(reserva);
    const previos = await this.repositorio.registrados(reserva.id);

    const abiertos = tramos.filter(
      (t) => !estaRegistrado(previos, reserva, t) && this.ventana(t.salida, ahora) === 'abierta',
    );
    if (abiertos.length === 0 && previos.length === 0) {
      throw noDisponible(this.motivoSinVentana(tramos, ahora));
    }

    if (abiertos.length > 0) {
      validarDatos(reserva, abiertos);
      await this.prisma.transaccionAuditada(async (tx) => {
        // La reserva bloqueada: otro check-in suyo espera y ve lo que este registró
        if ((await this.reservas.bloquear(tx, reserva.id)) !== 'CONFIRMADA') {
          throw noDisponible(`Booking ${reserva.id} is no longer CONFIRMED`);
        }
        const existentes = await this.repositorio.registradosEn(tx, reserva.id);
        for (const tramo of abiertos) {
          let nuevos = 0;
          // Los adultos antes que los infantes: un infante hace check-in con su adulto
          for (const pasajero of ordenados(reserva)) {
            if (
              existentes.some(
                (e) => e.codigoPasajero === pasajero.codigo && e.salidaId === tramo.salida.id,
              )
            ) {
              continue;
            }
            const id = await this.repositorio.registrar(
              tx,
              reserva.id,
              pasajero.codigo,
              tramo.salida.id,
              ahora,
            );
            if (id !== null) nuevos++;
          }
          if (nuevos > 0) {
            await this.reservas.evento(
              tx,
              reserva.id,
              'booking.checked_in',
              `Check-in for flight ${tramo.salida.numeroVuelo}: ${nuevos} passenger(s)`,
              ahora,
            );
          }
        }
      });
    }

    const actuales = await this.repositorio.registrados(reserva.id);
    return this.armar(reserva, tramos, actuales, ahora);
  }

  /** La ventana de un vuelo en `ahora`. */
  private ventana(salida: SalidaVendible, ahora: Date): Ventana {
    if (!ESTADOS_ABIERTOS.includes(salida.estado)) return 'cerrada';
    const t = salida.salida.getTime();
    if (ahora.getTime() >= t - this.cierreMs) return 'cerrada';
    if (ahora.getTime() < t - this.aperturaMs) return 'aun-no';
    return 'abierta';
  }

  /** Por qué ningún vuelo admite check-in: cuándo abre el primero que falta, o que ya cerró. */
  private motivoSinVentana(tramos: Tramo[], ahora: Date): string {
    const proximos = tramos
      .filter((t) => this.ventana(t.salida, ahora) === 'aun-no')
      .sort((a, b) => a.salida.salida.getTime() - b.salida.salida.getTime());
    if (proximos.length > 0) {
      const abre = new Date(proximos[0].salida.salida.getTime() - this.aperturaMs);
      return (
        `Check-in for flight ${proximos[0].salida.numeroVuelo} opens at ${abre.toISOString()} ` +
        `(${this.aperturaMs / HORA} hours before departure)`
      );
    }
    return (
      `Check-in is closed: it closes ${this.cierreMs / MINUTO} minutes before departure, and the ` +
      'flights must not have departed or been cancelled'
    );
  }

  /** El estado de cada pasajero en cada vuelo, con lo registrado y la ventana de `ahora`. */
  private armar(
    reserva: Reserva,
    tramos: Tramo[],
    registrados: CheckinRegistrado[],
    ahora: Date,
  ): ResultadoCheckin {
    const pasajeros: PasajeroCheckin[] = reserva.pasajeros.map((p) => {
      const detalle = tramos.map((t) => {
        let estado: EstadoCheckinPasajero;
        if (registrados.some((r) => r.codigoPasajero === p.codigo && r.salidaId === t.salida.id)) {
          estado = 'CHECKED_IN';
        } else {
          estado = this.ventana(t.salida, ahora) === 'aun-no' ? 'NOT_CHECKED_IN' : 'FAILED';
        }
        const asiento = p.asientos.find((a) => a.salidaId === t.salida.id)?.numero ?? null;
        return { salidaId: t.salida.id, estado, asiento };
      });
      const todos = detalle.every((d) => d.estado === 'CHECKED_IN');
      const alguno = detalle.some((d) => d.estado === 'FAILED');
      return {
        codigo: p.codigo,
        estado: todos ? 'CHECKED_IN' : alguno ? 'FAILED' : 'NOT_CHECKED_IN',
        tramos: detalle,
      };
    });
    const completo = pasajeros.every((p) => p.estado === 'CHECKED_IN');
    return { reservaId: reserva.id, estado: completo ? 'COMPLETED' : 'IN_PROGRESS', pasajeros };
  }
}

/** 409 si la reserva no está CONFIRMED o le falta un boleto emitido para algún vuelo. */
function exigirElegible(reserva: Reserva): void {
  if (reserva.estado !== 'CONFIRMADA') {
    throw noDisponible(
      `Booking ${reserva.id} is ${ESTADO_RESERVA.aContrato(reserva.estado)}; check-in needs a ` +
        'CONFIRMED booking with its tickets issued',
    );
  }
  const vuelos = tramosDe(reserva).map((t) => t.salida.id);
  const completa = reserva.pasajeros.every((p) =>
    reserva.boletos.some(
      (b) =>
        b.codigoPasajero === p.codigo &&
        b.estado === 'EMITIDO' &&
        vuelos.every((v) => b.cupones.some((c) => c.salidaId === v && c.estado === 'EMITIDO')),
    ),
  );
  if (!completa) throw noDisponible(`Booking ${reserva.id} has tickets that are not issued yet`);
}

/** Los vuelos de los itinerarios vigentes, en orden de viaje. */
function tramosDe(reserva: Reserva): Tramo[] {
  return [...reserva.itinerarios]
    .sort((a, b) => a.orden - b.orden)
    .flatMap((itinerario) => itinerario.salidas.map((salida) => ({ salida, itinerario })));
}

const estaRegistrado = (registrados: CheckinRegistrado[], reserva: Reserva, t: Tramo): boolean =>
  reserva.pasajeros.every((p) =>
    registrados.some((r) => r.codigoPasajero === p.codigo && r.salidaId === t.salida.id),
  );

/** Los adultos y demás pasajeros primero, los infantes al final. */
const ordenados = (reserva: Reserva) =>
  [...reserva.pasajeros].sort(
    (a, b) => Number(a.tipo === 'INFANTE') - Number(b.tipo === 'INFANTE'),
  );

/**
 * 422 si un pasajero no puede hacer check-in en alguno de los vuelos que se van a registrar:
 * un pasajero con asiento no lo tiene asignado en ese vuelo, o su pasaporte vence antes de la
 * salida (un cambio de fecha pudo moverla). El error nombra el campo, nunca el valor.
 */
function validarDatos(reserva: Reserva, tramos: Tramo[]): void {
  reserva.pasajeros.forEach((pasajero, i) => {
    for (const { salida } of tramos) {
      const campo =
        pasajero.tipo !== 'INFANTE' && !pasajero.asientos.some((a) => a.salidaId === salida.id)
          ? 'seat'
          : pasajero.vencimientoDocumento !== null && pasajero.vencimientoDocumento <= salida.salida
            ? 'documentExpiryDate'
            : null;
      if (campo === null) continue;
      const razon =
        campo === 'seat'
          ? `has no seat on flight ${salida.numeroVuelo}`
          : `expires before flight ${salida.numeroVuelo} departs`;
      throw new ErrorNegocio(
        422,
        CodigoError.CHECK_IN_FAILED,
        `passengers[${i}].${campo}: ${razon}`,
        { invalidParams: [{ name: `passengers[${i}].${campo}`, reason: razon }] },
      );
    }
  });
}
