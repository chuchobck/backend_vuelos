import { Injectable } from '@nestjs/common';
import { estado_boleto, estado_cupon } from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';
import { GeneradorCodigos } from '../../compartido/generador-codigos';
import { Boleto } from './boleto.modelo';

/** Intentos de número de boleto antes de rendirse (con 10^10 series, en la práctica uno). */
const INTENTOS_NUMERO = 5;

interface FilaBoleto {
  id: string;
  reserva_id: string;
  codigo_pasajero: string;
  numero_boleto: string | null;
  estado: estado_boleto;
  fecha_emision: Date | null;
  motivo_fallo: string | null;
  salida_id: string | null;
  numero_cupon: number | null;
  estado_cupon: estado_cupon | null;
}

/** El número de boleto no se pudo asignar: la base ya tenía todos los que salieron. */
export class NumeroBoletoAgotado extends Error {}

/**
 * Boletos (boleto_cabecera) y sus cupones (boleto_detalle, uno por vuelo). Los crea y emite el
 * service de la reserva dentro de su transacción; las lecturas sirven a GET .../tickets.
 *
 * Un boleto por pasajero, también para los infantes (viajan sin asiento, pero con boleto). Los
 * cupones son los vuelos de los itinerarios vigentes de la reserva, en orden de viaje.
 */
@Injectable()
export class BoletoRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generador: GeneradorCodigos,
  ) {}

  /** Un boleto PENDIENTE por pasajero de la reserva, con sus cupones PENDIENTE. */
  async crearPendientes(tx: TransaccionVuelos, reservaId: string, ahora: Date): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO vuelos.boleto_cabecera (pasajero_id, fecha_creacion)
      SELECT p.id, ${ahora}::timestamptz
        FROM vuelos.reserva_detalle_pasajero p
       WHERE p.reserva_id = ${reservaId}::uuid
       ORDER BY p.id`;
    await tx.$executeRaw`
      INSERT INTO vuelos.boleto_detalle (boleto_id, vuelo_programado_id)
      SELECT b.id, i.vuelo_programado_id
        FROM vuelos.boleto_cabecera b
        JOIN vuelos.reserva_detalle_pasajero p   ON p.id = b.pasajero_id
        JOIN vuelos.reserva_detalle_itinerario r ON r.reserva_id = p.reserva_id AND r.vigente
        JOIN vuelos.itinerario_detalle i         ON i.itinerario_id = r.itinerario_id
       WHERE p.reserva_id = ${reservaId}::uuid
         AND b.estado = 'PENDIENTE'
       ORDER BY b.id, r.orden, i.orden`;
  }

  /**
   * Emite los boletos pendientes de la reserva: número `prefijo + 10 dígitos`, EMITIDO con la
   * hora de emisión, y sus cupones numerados del 1 en orden de viaje. Cada número se asigna con
   * un UPDATE que solo lo toma si nadie lo tiene (NOT EXISTS); si ya existía, se pide otro.
   * Devuelve cuántos boletos emitió.
   */
  async emitir(
    tx: TransaccionVuelos,
    reservaId: string,
    prefijo: string,
    ahora: Date,
  ): Promise<number> {
    const pendientes = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT b.id
        FROM vuelos.boleto_cabecera b
        JOIN vuelos.reserva_detalle_pasajero p ON p.id = b.pasajero_id
       WHERE p.reserva_id = ${reservaId}::uuid
         AND b.estado::text IN ('PENDIENTE', 'EMITIENDO')
       ORDER BY p.id
         FOR UPDATE OF b`;

    for (const { id } of pendientes) {
      let asignado = false;
      for (let intento = 0; intento < INTENTOS_NUMERO && !asignado; intento++) {
        const numero = `${prefijo}${this.generador.serieBoleto()}`;
        asignado =
          (await tx.$executeRaw`
            UPDATE vuelos.boleto_cabecera
               SET numero_boleto = ${numero}, estado = 'EMITIDO',
                   fecha_emision = ${ahora}::timestamptz
             WHERE id = ${id}::uuid
               AND NOT EXISTS (SELECT 1 FROM vuelos.boleto_cabecera o
                                WHERE o.numero_boleto = ${numero})`) === 1;
      }
      if (!asignado) throw new NumeroBoletoAgotado();
    }

    await tx.$executeRaw`
      UPDATE vuelos.boleto_detalle bd
         SET numero_cupon = c.numero, estado = 'EMITIDO'
        FROM (SELECT d.id,
                     row_number() OVER (PARTITION BY d.boleto_id ORDER BY r.orden, i.orden) AS numero
                FROM vuelos.boleto_detalle d
                JOIN vuelos.boleto_cabecera b            ON b.id = d.boleto_id
                JOIN vuelos.reserva_detalle_pasajero p   ON p.id = b.pasajero_id
                JOIN vuelos.reserva_detalle_itinerario r ON r.reserva_id = p.reserva_id AND r.vigente
                JOIN vuelos.itinerario_detalle i         ON i.itinerario_id = r.itinerario_id
                                                        AND i.vuelo_programado_id = d.vuelo_programado_id
               WHERE p.reserva_id = ${reservaId}::uuid
                 AND b.estado = 'EMITIDO'
                 AND d.estado = 'PENDIENTE') c
       WHERE bd.id = c.id`;
    return pendientes.length;
  }

  /** Los boletos que no llegaron a emitirse quedan FALLIDO con el motivo, y sus cupones también. */
  async fallar(tx: TransaccionVuelos, reservaId: string, motivo: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE vuelos.boleto_detalle d
         SET estado = 'FALLIDO'
        FROM vuelos.boleto_cabecera b
        JOIN vuelos.reserva_detalle_pasajero p ON p.id = b.pasajero_id
       WHERE d.boleto_id = b.id
         AND p.reserva_id = ${reservaId}::uuid
         AND b.estado::text IN ('PENDIENTE', 'EMITIENDO')`;
    await tx.$executeRaw`
      UPDATE vuelos.boleto_cabecera b
         SET estado = 'FALLIDO', motivo_fallo = ${motivo}
        FROM vuelos.reserva_detalle_pasajero p
       WHERE p.id = b.pasajero_id
         AND p.reserva_id = ${reservaId}::uuid
         AND b.estado::text IN ('PENDIENTE', 'EMITIENDO')`;
  }

  /** Los boletos de la reserva en estado `desde` pasan a `hacia` (cancelación). */
  async cambiarEstado(
    tx: TransaccionVuelos,
    reservaId: string,
    desde: estado_boleto,
    hacia: estado_boleto,
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE vuelos.boleto_cabecera b
         SET estado = ${hacia}::text::vuelos.estado_boleto
        FROM vuelos.reserva_detalle_pasajero p
       WHERE p.id = b.pasajero_id
         AND p.reserva_id = ${reservaId}::uuid
         AND b.estado::text = ${desde}`;
  }

  /** El dueño de la reserva (el de su hold), o null si la reserva no existe. */
  async propietarioDeReserva(reservaId: string): Promise<string | null> {
    const fila = await this.prisma.db.reserva_cabecera.findUnique({
      where: { id: reservaId },
      select: { retencion_cabecera: { select: { id_propietario: true } } },
    });
    return fila?.retencion_cabecera.id_propietario ?? null;
  }

  /** Los boletos de la reserva (con o sin `boletoId`), en el orden de los pasajeros. */
  async deReserva(reservaId: string, boletoId?: string): Promise<Boleto[]> {
    const filas = await this.prisma.db.$queryRaw<FilaBoleto[]>`
      SELECT b.id, p.reserva_id, p.codigo_pasajero, b.numero_boleto, b.estado::text AS estado,
             b.fecha_emision, b.motivo_fallo, d.vuelo_programado_id AS salida_id,
             d.numero_cupon, d.estado::text AS estado_cupon
        FROM vuelos.boleto_cabecera b
        JOIN vuelos.reserva_detalle_pasajero p ON p.id = b.pasajero_id
        LEFT JOIN vuelos.boleto_detalle d      ON d.boleto_id = b.id
        LEFT JOIN vuelos.vuelo_programado vp   ON vp.id = d.vuelo_programado_id
       WHERE p.reserva_id = ${reservaId}::uuid
         AND (${boletoId ?? null}::uuid IS NULL OR b.id = ${boletoId ?? null}::uuid)
       ORDER BY p.id, b.fecha_creacion, b.id, vp.salida_programada, vp.id`;
    return agrupar(filas);
  }
}

function agrupar(filas: FilaBoleto[]): Boleto[] {
  const boletos = new Map<string, Boleto>();
  for (const f of filas) {
    let boleto = boletos.get(f.id);
    if (!boleto) {
      boleto = {
        id: f.id,
        reservaId: f.reserva_id,
        codigoPasajero: f.codigo_pasajero,
        numero: f.numero_boleto,
        estado: f.estado,
        emitido: f.fecha_emision,
        motivoFallo: f.motivo_fallo,
        cupones: [],
      };
      boletos.set(f.id, boleto);
    }
    if (f.salida_id !== null) {
      boleto.cupones.push({
        salidaId: f.salida_id,
        numero: f.numero_cupon,
        estado: f.estado_cupon,
      });
    }
  }
  return [...boletos.values()];
}
