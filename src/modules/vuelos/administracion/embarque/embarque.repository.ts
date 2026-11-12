import { Injectable } from '@nestjs/common';
import {
  clase_cabina,
  estado_boleto,
  estado_reserva,
  estado_vuelo,
} from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';
import { AsientoManifiesto, Conteo, PasajeroAbordado, SalidaDeEmbarque } from './embarque.modelo';

/** El boleto de un pase: de qué reserva es, para bloquearla antes de mirar lo demás. */
export interface BoletoDelPase {
  reservaId: string;
  pnr: string;
}

/** Todo lo que el escaneo necesita del pasajero en la salida, leído con la reserva bloqueada. */
export interface SituacionDeAbordaje {
  pasajeroId: bigint;
  codigoPasajero: string;
  nombres: string;
  apellidos: string;
  estadoReserva: estado_reserva;
  estadoBoleto: estado_boleto;
  /** El cupón del boleto para esa salida está emitido. */
  cuponEmitido: boolean;
  /** La salida sigue en un itinerario vigente de la reserva (un cambio de fecha la quita). */
  vigente: boolean;
  /** El check-in REGISTRADO del pasajero en la salida, o null. */
  checkinId: bigint | null;
  abordado: Date | null;
  /** El código del pase emitido para ese check-in. */
  codigoBarras: string | null;
  grupo: string | null;
  posicion: string | null;
  /** El asiento que el pasajero tiene hoy en la salida. */
  asiento: string | null;
}

interface FilaSalida {
  id: string;
  numero_vuelo: string;
  fecha_salida: Date;
  origen: string;
  destino: string;
  estado: estado_vuelo;
  puerta_salida: string | null;
}

interface FilaSituacion {
  pasajero_id: bigint;
  codigo_pasajero: string;
  nombres: string;
  apellidos: string;
  estado_reserva: estado_reserva;
  estado_boleto: estado_boleto;
  cupon_emitido: boolean;
  vigente: boolean;
  checkin_id: bigint | null;
  fecha_abordaje: Date | null;
  codigo_barras: string | null;
  grupo_abordaje: string | null;
  posicion_abordaje: string | null;
  asiento: string | null;
}

interface FilaManifiesto {
  asiento: string;
  cabina: clase_cabina;
  pnr: string;
  codigo_pasajero: string;
  emitido: boolean;
  registrado: boolean;
  fecha_abordaje: Date | null;
  grupo_abordaje: string | null;
}

/**
 * Embarque: el abordaje es `checkin.fecha_abordaje` (migración 007). No hay tabla propia: el
 * check-in ya es la fila única de un pasajero en una salida (uq_checkin_registrado) y ya está
 * auditada, así que marcar el abordaje queda en `auditoria` con el agente que escaneó.
 */
@Injectable()
export class EmbarqueRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** La salida que la puerta embarca, o null si no existe. No filtra por estado. */
  async salida(salidaId: string): Promise<SalidaDeEmbarque | null> {
    const [f] = await this.prisma.db.$queryRaw<FilaSalida[]>`
      SELECT vp.id, ac.codigo_iata || v.numero AS numero_vuelo, vp.fecha_salida,
             po.codigo_iata AS origen, pd.codigo_iata AS destino, vp.estado::text AS estado,
             vp.puerta_salida
        FROM vuelos.vuelo_programado vp
        JOIN vuelos.vuelo v       ON v.id = vp.vuelo_id
        JOIN vuelos.aerolinea ac  ON ac.id = v.aerolinea_id
        JOIN vuelos.aeropuerto po ON po.id = v.aeropuerto_origen_id
        JOIN vuelos.aeropuerto pd ON pd.id = v.aeropuerto_destino_id
       WHERE vp.id = ${salidaId}::uuid`;
    if (!f) return null;
    return {
      id: f.id,
      numeroVuelo: f.numero_vuelo,
      fechaSalida: f.fecha_salida,
      origen: f.origen,
      destino: f.destino,
      estado: f.estado,
      puerta: f.puerta_salida,
    };
  }

  /** La reserva del boleto con ese número (es único), o null si no existe. */
  async boleto(numeroBoleto: string): Promise<BoletoDelPase | null> {
    const [f] = await this.prisma.db.$queryRaw<Array<{ reserva_id: string; pnr: string }>>`
      SELECT p.reserva_id, rc.pnr
        FROM vuelos.boleto_cabecera b
        JOIN vuelos.reserva_detalle_pasajero p ON p.id = b.pasajero_id
        JOIN vuelos.reserva_cabecera rc        ON rc.id = p.reserva_id
       WHERE b.numero_boleto = ${numeroBoleto}`;
    return f ? { reservaId: f.reserva_id, pnr: f.pnr } : null;
  }

  /**
   * La situación del pasajero del boleto en la salida, dentro de la transacción que ya bloqueó
   * su reserva: nadie la cancela ni le cambia la fecha mientras se decide.
   */
  async situacion(
    tx: TransaccionVuelos,
    numeroBoleto: string,
    salidaId: string,
  ): Promise<SituacionDeAbordaje | null> {
    const [f] = await tx.$queryRaw<FilaSituacion[]>`
      SELECT p.id AS pasajero_id, p.codigo_pasajero, p.nombres, p.apellidos,
             rc.estado::text AS estado_reserva, b.estado::text AS estado_boleto,
             EXISTS (SELECT 1 FROM vuelos.boleto_detalle d
                      WHERE d.boleto_id = b.id AND d.vuelo_programado_id = ${salidaId}::uuid
                        AND d.estado::text = 'EMITIDO') AS cupon_emitido,
             EXISTS (SELECT 1
                       FROM vuelos.reserva_detalle_itinerario r
                       JOIN vuelos.itinerario_detalle i ON i.itinerario_id = r.itinerario_id
                      WHERE r.reserva_id = p.reserva_id AND r.vigente
                        AND i.vuelo_programado_id = ${salidaId}::uuid) AS vigente,
             c.id AS checkin_id, c.fecha_abordaje, pa.codigo_barras, pa.grupo_abordaje,
             pa.posicion_abordaje,
             (SELECT f.numero_fila::text || a.letra
                FROM vuelos.reserva_detalle_asiento ra
                JOIN vuelos.asiento a               ON a.id = ra.asiento_id
                JOIN vuelos.mapa_asientos_detalle f ON f.id = a.mapa_asientos_detalle_id
               WHERE ra.pasajero_id = p.id AND ra.vuelo_programado_id = ${salidaId}::uuid
                 AND ra.fecha_liberacion IS NULL) AS asiento
        FROM vuelos.boleto_cabecera b
        JOIN vuelos.reserva_detalle_pasajero p ON p.id = b.pasajero_id
        JOIN vuelos.reserva_cabecera rc        ON rc.id = p.reserva_id
        LEFT JOIN vuelos.checkin c             ON c.pasajero_id = p.id
                                              AND c.vuelo_programado_id = ${salidaId}::uuid
                                              AND c.estado::text = 'REGISTRADO'
        LEFT JOIN vuelos.pase_abordar pa       ON pa.checkin_id = c.id
       WHERE b.numero_boleto = ${numeroBoleto}`;
    if (!f) return null;
    return {
      pasajeroId: f.pasajero_id,
      codigoPasajero: f.codigo_pasajero,
      nombres: f.nombres,
      apellidos: f.apellidos,
      estadoReserva: f.estado_reserva,
      estadoBoleto: f.estado_boleto,
      cuponEmitido: f.cupon_emitido,
      vigente: f.vigente,
      checkinId: f.checkin_id,
      abordado: f.fecha_abordaje,
      codigoBarras: f.codigo_barras,
      grupo: f.grupo_abordaje,
      posicion: f.posicion_abordaje,
      asiento: f.asiento,
    };
  }

  /**
   * Marca el abordaje del check-in. UPDATE condicionado a que siga sin abordar: de dos escaneos
   * a la vez solo uno encuentra la fila. Devuelve si este la marcó.
   */
  async abordar(tx: TransaccionVuelos, checkinId: bigint, ahora: Date): Promise<boolean> {
    const filas = await tx.$queryRaw<Array<{ id: bigint }>>`
      UPDATE vuelos.checkin
         SET fecha_abordaje = ${ahora}::timestamptz
       WHERE id = ${checkinId} AND estado::text = 'REGISTRADO' AND fecha_abordaje IS NULL
      RETURNING id`;
    return filas.length === 1;
  }

  /**
   * Los infantes con check-in que viajan en brazos de ese pasajero abordan con él (no tienen
   * pase propio). Devuelve los que abordaron ahora.
   */
  async abordarInfantes(
    tx: TransaccionVuelos,
    adultoId: bigint,
    salidaId: string,
    ahora: Date,
  ): Promise<PasajeroAbordado[]> {
    const filas = await tx.$queryRaw<
      Array<{ codigo_pasajero: string; nombres: string; apellidos: string }>
    >`
      UPDATE vuelos.checkin c
         SET fecha_abordaje = ${ahora}::timestamptz
        FROM vuelos.reserva_detalle_pasajero i
       WHERE i.id = c.pasajero_id AND i.adulto_responsable_id = ${adultoId}
         AND i.tipo_pasajero::text = 'INFANTE'
         AND c.vuelo_programado_id = ${salidaId}::uuid
         AND c.estado::text = 'REGISTRADO' AND c.fecha_abordaje IS NULL
      RETURNING i.codigo_pasajero, i.nombres, i.apellidos`;
    return filas.map((f) => ({
      codigo: f.codigo_pasajero,
      nombres: f.nombres,
      apellidos: f.apellidos,
    }));
  }

  /**
   * Los asientos vendidos de la salida (asignados y sin liberar, lo mismo que el mapa de asientos
   * da por ocupado), por fila y letra. Sin nombre, documento ni correo.
   */
  async asientos(salidaId: string): Promise<AsientoManifiesto[]> {
    const filas = await this.prisma.db.$queryRaw<FilaManifiesto[]>`
      SELECT f.numero_fila::text || a.letra AS asiento, f.clase_cabina::text AS cabina, rc.pnr,
             p.codigo_pasajero,
             EXISTS (SELECT 1 FROM vuelos.boleto_cabecera b
                      WHERE b.pasajero_id = p.id AND b.estado::text = 'EMITIDO') AS emitido,
             c.id IS NOT NULL AS registrado, c.fecha_abordaje, pa.grupo_abordaje
        FROM vuelos.reserva_detalle_asiento ra
        JOIN vuelos.reserva_detalle_pasajero p ON p.id = ra.pasajero_id
        JOIN vuelos.reserva_cabecera rc        ON rc.id = p.reserva_id
        JOIN vuelos.asiento a                  ON a.id = ra.asiento_id
        JOIN vuelos.mapa_asientos_detalle f    ON f.id = a.mapa_asientos_detalle_id
        LEFT JOIN vuelos.checkin c             ON c.pasajero_id = p.id
                                              AND c.vuelo_programado_id = ra.vuelo_programado_id
                                              AND c.estado::text = 'REGISTRADO'
        LEFT JOIN vuelos.pase_abordar pa       ON pa.checkin_id = c.id
       WHERE ra.vuelo_programado_id = ${salidaId}::uuid AND ra.fecha_liberacion IS NULL
       ORDER BY f.numero_fila, a.letra`;
    return filas.map((f) => ({
      asiento: f.asiento,
      cabina: f.cabina,
      pnr: f.pnr,
      codigoPasajero: f.codigo_pasajero,
      estado: f.fecha_abordaje
        ? 'BOARDED'
        : f.registrado
          ? 'CHECKED_IN'
          : f.emitido
            ? 'TICKETED'
            : 'BOOKED',
      grupo: f.grupo_abordaje,
      abordado: f.fecha_abordaje,
    }));
  }

  /** Los infantes de la salida: los que viajan en brazos de un pasajero con asiento en ella. */
  async infantes(salidaId: string): Promise<Conteo> {
    const [f] = await this.prisma.db.$queryRaw<
      Array<{ vendidos: number; registrados: number; abordados: number }>
    >`
      SELECT count(*)::int AS vendidos, count(c.id)::int AS registrados,
             count(c.fecha_abordaje)::int AS abordados
        FROM vuelos.reserva_detalle_pasajero i
        LEFT JOIN vuelos.checkin c ON c.pasajero_id = i.id
                                  AND c.vuelo_programado_id = ${salidaId}::uuid
                                  AND c.estado::text = 'REGISTRADO'
       WHERE i.tipo_pasajero::text = 'INFANTE'
         AND EXISTS (SELECT 1 FROM vuelos.reserva_detalle_asiento ra
                      WHERE ra.pasajero_id = i.adulto_responsable_id
                        AND ra.vuelo_programado_id = ${salidaId}::uuid
                        AND ra.fecha_liberacion IS NULL)`;
    return { vendidos: f.vendidos, registrados: f.registrados, abordados: f.abordados };
  }
}
