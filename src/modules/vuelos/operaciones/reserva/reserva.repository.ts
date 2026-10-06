import { Injectable } from '@nestjs/common';
import {
  clase_cabina,
  estado_reserva,
  estado_retencion,
  estado_vuelo,
  genero,
  Prisma,
  tipo_documento,
  tipo_pasajero,
} from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';
import { GeneradorCodigos } from '../../compartido/generador-codigos';
import { SalidaVendible } from '../busqueda/busqueda.modelo';
import { ItinerarioDeReserva, PasajeroDeReserva, Reserva, ResumenReserva } from './reserva.modelo';

/** PNR que se prueban antes de rendirse (con 887 millones posibles, en la práctica uno). */
const INTENTOS_PNR = 5;

/** Una salida de un itinerario del hold, con lo que la reserva necesita saber de ella. */
export interface SalidaDelHold {
  id: string;
  estado: estado_vuelo;
  salida: Date;
  /** Fecha local de salida (un `date`). */
  fechaSalida: Date;
}

export interface ItinerarioDelHold {
  id: string;
  /** Orden del itinerario en la oferta (oferta_detalle.orden). */
  orden: number;
  familiaId: bigint;
  cabina: clase_cabina;
  codigoFamilia: string;
  base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  salidas: SalidaDelHold[];
}

/** Un hold con todo lo que hace falta para convertirlo en reserva. */
export interface HoldParaReservar {
  id: string;
  idPropietario: string;
  estado: estado_retencion;
  vence: Date;
  adultos: number;
  jovenes: number;
  ninos: number;
  infantes: number;
  monedaId: bigint;
  moneda: string;
  /** La aerolínea de la oferta, que emite los boletos. */
  aerolinea: { codigo: string; prefijoBoleto: string | null };
  itinerarios: ItinerarioDelHold[];
}

/** Un asiento físico de la aeronave de una salida, y si alguien lo tiene asignado. */
export interface AsientoDeSalida {
  salidaId: string;
  asientoId: bigint;
  /** Número del contrato: fila y letra (12A). */
  numero: string;
  cabina: clase_cabina;
  ocupado: boolean;
}

export interface PasajeroNuevo {
  codigo: string;
  tipo: tipo_pasajero;
  /** codigo del adulto responsable (infantes). */
  adultoResponsable: string | null;
  nombres: string;
  apellidos: string;
  tipoDocumento: tipo_documento;
  numeroDocumento: string;
  paisId: bigint;
  vencimientoDocumento: Date | null;
  nacimiento: Date;
  genero: genero;
  correo: string;
  telefono: string;
}

export interface ReservaNueva {
  /** Lo genera el service: la clave de idempotencia lo guarda antes de insertar la reserva. */
  id: string;
  retencionId: string;
  ahora: Date;
  itinerarios: Array<{
    itinerarioId: string;
    familiaId: bigint;
    orden: number;
    base: Prisma.Decimal;
    impuestos: Prisma.Decimal;
  }>;
  pasajeros: PasajeroNuevo[];
  asientos: Array<{ codigoPasajero: string; salidaId: string; asientoId: bigint }>;
}

export interface CambioDeEstado {
  anterior: estado_reserva | null;
  nuevo: estado_reserva | null;
  descripcion: string;
  fecha: Date;
}

export interface FiltrosReservas {
  idPropietario: string;
  pnr?: string;
  estado?: estado_reserva;
  /** Creadas desde ese instante (incluido) y antes de `hasta` (excluido). */
  desde?: Date;
  hasta?: Date;
  /** La última fila de la página anterior. */
  despuesDe?: { creada: Date; id: string };
  limite: number;
}

/** La reserva de una pagina de GET /bookings, con lo que hace falta para el cursor. */
export type FilaListado = ResumenReserva & { creada: Date };

/** El PNR no se pudo generar: todos los que salieron ya existían. */
export class PnrAgotado extends Error {}

interface FilaSegmento {
  itinerario_id: string;
  id: string;
  numero_vuelo: string;
  aerolinea_id: bigint;
  comercializa: string;
  nombre_comercializa: string;
  opera: string;
  origen: string;
  destino: string;
  fecha_salida: Date;
  salida_programada: Date;
  llegada_programada: Date;
  terminal_salida: string | null;
  terminal_llegada: string | null;
  estado: estado_vuelo;
  modelo: string;
}

interface FilaItinerario {
  id: string;
  orden: number;
  tarifa_base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  codigo: string;
  clase_cabina: clase_cabina;
  es_cambiable: boolean;
  porcentaje_penalidad_cancelacion: Prisma.Decimal;
  incluye_articulo_personal: boolean;
  equipaje_mano_incluido: number;
  equipaje_bodega_incluido: number;
  maximo_equipaje_adicional: number;
  equipaje_adicional: Prisma.Decimal | null;
  asientos_disponibles: number | null;
}

interface FilaCabecera {
  id: string;
  pnr: string;
  estado: estado_reserva;
  fecha_creacion: Date;
  fecha_actualizacion: Date;
  id_propietario: string;
  moneda: string;
  tarifa_base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  total: Prisma.Decimal;
}

/**
 * Reservas (reserva_cabecera) y sus detalles: itinerarios, pasajeros, asientos, pago e
 * historial. Las escrituras corren dentro de la transacción auditada que abre el service; el
 * dueño de una reserva es el de su retención (retencion_cabecera.id_propietario).
 *
 * El inventario se bloquea siempre en orden (salida, cabina), el mismo de los holds: así una
 * reserva, un hold y el catálogo se esperan en vez de cruzarse.
 */
@Injectable()
export class ReservaRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generador: GeneradorCodigos,
  ) {}

  async holdParaReservar(holdId: string): Promise<HoldParaReservar | null> {
    const r = await this.prisma.db.retencion_cabecera.findUnique({
      where: { id: holdId },
      select: {
        id: true,
        id_propietario: true,
        estado: true,
        fecha_expiracion: true,
        adultos: true,
        jovenes: true,
        ninos: true,
        infantes: true,
        moneda_id: true,
        moneda: { select: { codigo_iso: true } },
        oferta_cabecera: {
          select: {
            aerolinea: { select: { codigo_iata: true, prefijo_boleto: true } },
            oferta_detalle: { select: { itinerario_id: true, orden: true } },
          },
        },
        retencion_detalle: {
          select: {
            itinerario_id: true,
            familia_tarifa_id: true,
            tarifa_base_congelada: true,
            impuestos_congelados: true,
            familia_tarifa: { select: { clase_cabina: true, codigo: true } },
            itinerario_cabecera: {
              select: {
                itinerario_detalle: {
                  orderBy: { orden: 'asc' },
                  select: {
                    vuelo_programado: {
                      select: {
                        id: true,
                        estado: true,
                        salida_programada: true,
                        fecha_salida: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!r) return null;
    const orden = new Map(r.oferta_cabecera.oferta_detalle.map((d) => [d.itinerario_id, d.orden]));
    return {
      id: r.id,
      idPropietario: r.id_propietario,
      estado: r.estado,
      vence: r.fecha_expiracion,
      adultos: r.adultos,
      jovenes: r.jovenes,
      ninos: r.ninos,
      infantes: r.infantes,
      monedaId: r.moneda_id,
      moneda: r.moneda.codigo_iso,
      aerolinea: {
        codigo: r.oferta_cabecera.aerolinea.codigo_iata,
        prefijoBoleto: r.oferta_cabecera.aerolinea.prefijo_boleto,
      },
      itinerarios: r.retencion_detalle
        .map((d) => ({
          id: d.itinerario_id,
          orden: orden.get(d.itinerario_id) ?? 1,
          familiaId: d.familia_tarifa_id,
          cabina: d.familia_tarifa.clase_cabina,
          codigoFamilia: d.familia_tarifa.codigo,
          base: d.tarifa_base_congelada,
          impuestos: d.impuestos_congelados,
          salidas: d.itinerario_cabecera.itinerario_detalle.map(({ vuelo_programado: vp }) => ({
            id: vp.id,
            estado: vp.estado,
            salida: vp.salida_programada,
            fechaSalida: vp.fecha_salida,
          })),
        }))
        .sort((a, b) => a.orden - b.orden),
    };
  }

  /** id interno de cada país activo por su código ISO alfa-2. */
  async paises(codigos: readonly string[]): Promise<Map<string, bigint>> {
    const filas = await this.prisma.db.pais.findMany({
      where: { codigo_iso2: { in: [...codigos] }, activo: true },
      select: { id: true, codigo_iso2: true },
    });
    return new Map(filas.map((f) => [f.codigo_iso2, f.id]));
  }

  /**
   * Bloquea las filas de inventario de esas cabinas, en orden (salida, cabina), hasta el fin
   * de la transacción. Dos reservas que eligen asientos en la misma cabina de la misma salida
   * se esperan: la segunda ve los asientos que la primera ya tomó.
   */
  async bloquearCabinas(
    tx: TransaccionVuelos,
    cabinas: ReadonlyArray<{ salidaId: string; cabina: clase_cabina }>,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT ic.id
        FROM vuelos.inventario_cabina ic
        JOIN unnest(${cabinas.map((c) => c.salidaId)}::uuid[],
                    ${cabinas.map((c) => c.cabina)}::text[]) AS p(salida_id, clase_cabina)
          ON p.salida_id = ic.vuelo_programado_id AND p.clase_cabina = ic.clase_cabina::text
       ORDER BY ic.vuelo_programado_id, ic.clase_cabina
         FOR UPDATE OF ic`;
  }

  /**
   * Los asientos físicos de la aeronave de esas salidas, en orden (fila y letra), con su cabina
   * y si alguna reserva los tiene asignados (sin fecha_liberacion).
   */
  async asientosDeSalidas(
    tx: TransaccionVuelos,
    salidas: readonly string[],
  ): Promise<AsientoDeSalida[]> {
    const filas = await tx.$queryRaw<
      Array<{
        salida_id: string;
        asiento_id: bigint;
        numero: string;
        clase_cabina: clase_cabina;
        ocupado: boolean;
      }>
    >`
      SELECT vp.id AS salida_id, a.id AS asiento_id, f.numero_fila::text || a.letra AS numero,
             f.clase_cabina::text AS clase_cabina,
             EXISTS (SELECT 1 FROM vuelos.reserva_detalle_asiento o
                      WHERE o.vuelo_programado_id = vp.id AND o.asiento_id = a.id
                        AND o.fecha_liberacion IS NULL) AS ocupado
        FROM vuelos.vuelo_programado vp
        JOIN vuelos.mapa_asientos_detalle f ON f.mapa_asientos_id = vp.mapa_asientos_id
        JOIN vuelos.asiento a               ON a.mapa_asientos_detalle_id = f.id
       WHERE vp.id = ANY(${salidas}::uuid[])
       ORDER BY vp.id, f.numero_fila, a.letra`;
    return filas.map((f) => ({
      salidaId: f.salida_id,
      asientoId: f.asiento_id,
      numero: f.numero,
      cabina: f.clase_cabina,
      ocupado: f.ocupado,
    }));
  }

  /**
   * Inserta la reserva PENDIENTE con un PNR nuevo, sus itinerarios con el precio del hold, los
   * pasajeros (primero los que llevan a un infante) y sus asientos. El
   * PNR se reclama con `ON CONFLICT DO NOTHING`: si ya existía, se prueba otro sin abortar la
   * transacción.
   */
  async crear(tx: TransaccionVuelos, nueva: ReservaNueva): Promise<{ id: string; pnr: string }> {
    let creada: { id: string; pnr: string } | undefined;
    for (let intento = 0; intento < INTENTOS_PNR && !creada; intento++) {
      const pnr = this.generador.pnr();
      const [fila] = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO vuelos.reserva_cabecera
               (id, retencion_id, pnr, estado, fecha_creacion, fecha_actualizacion)
        VALUES (${nueva.id}::uuid, ${nueva.retencionId}::uuid, ${pnr}, 'PENDIENTE',
                ${nueva.ahora}::timestamptz, ${nueva.ahora}::timestamptz)
        ON CONFLICT ON CONSTRAINT uq_reserva_cabecera_pnr DO NOTHING
        RETURNING id`;
      if (fila) creada = { id: fila.id, pnr };
    }
    if (!creada) throw new PnrAgotado();
    const reservaId = creada.id;

    await tx.reserva_detalle_itinerario.createMany({
      data: nueva.itinerarios.map((it) => ({
        reserva_id: reservaId,
        itinerario_id: it.itinerarioId,
        familia_tarifa_id: it.familiaId,
        orden: it.orden,
        tarifa_base: it.base,
        impuestos: it.impuestos,
      })),
    });

    const fila = (p: PasajeroNuevo, adultoId: bigint | null) => ({
      reserva_id: reservaId,
      codigo_pasajero: p.codigo,
      tipo_pasajero: p.tipo,
      adulto_responsable_id: adultoId,
      nombres: p.nombres,
      apellidos: p.apellidos,
      tipo_documento: p.tipoDocumento,
      numero_documento: p.numeroDocumento,
      pais_nacionalidad_id: p.paisId,
      fecha_vencimiento_documento: p.vencimientoDocumento,
      fecha_nacimiento: p.nacimiento,
      genero: p.genero,
      correo: p.correo,
      telefono: p.telefono,
    });
    const ids = new Map<string, bigint>();
    const conAsiento = await tx.reserva_detalle_pasajero.createManyAndReturn({
      data: nueva.pasajeros.filter((p) => p.tipo !== 'INFANTE').map((p) => fila(p, null)),
      select: { id: true, codigo_pasajero: true },
    });
    for (const p of conAsiento) ids.set(p.codigo_pasajero, p.id);
    const infantes = nueva.pasajeros.filter((p) => p.tipo === 'INFANTE');
    if (infantes.length > 0) {
      await tx.reserva_detalle_pasajero.createMany({
        data: infantes.map((p) => fila(p, ids.get(p.adultoResponsable!)!)),
      });
    }

    if (nueva.asientos.length > 0) {
      await tx.reserva_detalle_asiento.createMany({
        data: nueva.asientos.map((a) => ({
          pasajero_id: ids.get(a.codigoPasajero)!,
          vuelo_programado_id: a.salidaId,
          asiento_id: a.asientoId,
          fecha_asignacion: nueva.ahora,
        })),
      });
    }

    return creada;
  }

  async agregarHistorial(
    tx: TransaccionVuelos,
    reservaId: string,
    cambio: CambioDeEstado,
  ): Promise<void> {
    await tx.reserva_detalle_historial.create({
      data: {
        reserva_id: reservaId,
        estado_anterior: cambio.anterior,
        estado_nuevo: cambio.nuevo,
        descripcion: cambio.descripcion,
        fecha_evento: cambio.fecha,
      },
    });
  }

  /** Cambia el estado solo si sigue en `desde` (UPDATE condicionado). Devuelve si lo cambió. */
  async cambiarEstado(
    tx: TransaccionVuelos,
    reservaId: string,
    desde: estado_reserva,
    hacia: estado_reserva,
  ): Promise<boolean> {
    const cambiadas = await tx.$executeRaw`
      UPDATE vuelos.reserva_cabecera
         SET estado = ${hacia}::text::vuelos.estado_reserva
       WHERE id = ${reservaId}::uuid AND estado::text = ${desde}`;
    return cambiadas === 1;
  }

  /** El prefijo de boleto de la aerolínea que vende la reserva, como está hoy. */
  async prefijoBoleto(tx: TransaccionVuelos, reservaId: string): Promise<string | null> {
    const [fila] = await tx.$queryRaw<Array<{ prefijo: string | null }>>`
      SELECT a.prefijo_boleto AS prefijo
        FROM vuelos.reserva_cabecera rc
        JOIN vuelos.retencion_cabecera r ON r.id = rc.retencion_id
        JOIN vuelos.oferta_cabecera o    ON o.id = r.oferta_id
        JOIN vuelos.aerolinea a          ON a.id = o.aerolinea_id
       WHERE rc.id = ${reservaId}::uuid`;
    return fila?.prefijo ?? null;
  }

  /**
   * Las reservas que esperan la confirmación del pago, las más viejas primero, con su
   * referencia. Sin bloquear: quien las procesa las vuelve a tomar con `tomarSiSigue`.
   */
  pendientesDePago(limite: number): Promise<Array<{ id: string; referencia: string }>> {
    return this.prisma.db.$queryRaw`
      SELECT rc.id, p.referencia_pago AS referencia
        FROM vuelos.reserva_cabecera rc
        JOIN vuelos.reserva_detalle_pago p ON p.reserva_id = rc.id AND p.concepto = 'EMISION'
       WHERE rc.estado = 'PENDIENTE_PAGO'
       ORDER BY rc.fecha_actualizacion, rc.id
       LIMIT ${limite}`;
  }

  /**
   * Bloquea la reserva si sigue en ese estado; `SKIP LOCKED` hace que dos procesos que la
   * buscan a la vez no la procesen los dos. Devuelve si la tomó.
   */
  async tomarSiSigue(
    tx: TransaccionVuelos,
    reservaId: string,
    estado: estado_reserva,
  ): Promise<boolean> {
    const filas = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM vuelos.reserva_cabecera
       WHERE id = ${reservaId}::uuid AND estado::text = ${estado}
         FOR UPDATE SKIP LOCKED`;
    return filas.length === 1;
  }

  /** Libera los asientos asignados de la reserva (no los borra: fecha_liberacion). */
  async liberarAsientos(tx: TransaccionVuelos, reservaId: string, ahora: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE vuelos.reserva_detalle_asiento a
         SET fecha_liberacion = ${ahora}::timestamptz
        FROM vuelos.reserva_detalle_pasajero p
       WHERE p.id = a.pasajero_id
         AND p.reserva_id = ${reservaId}::uuid
         AND a.fecha_liberacion IS NULL`;
  }

  /**
   * Devuelve al inventario el cupo de la reserva: los pasajeros con asiento (los infantes no)
   * en la cabina de la familia de cada itinerario vigente, en cada uno de sus vuelos. Una sola
   * sentencia que bloquea en orden (salida, cabina), como los holds. LEAST protege
   * ck_inventario_cabina_cupos_disponibles, igual que al liberar un hold.
   */
  async devolverCupo(tx: TransaccionVuelos, reservaId: string): Promise<void> {
    await tx.$executeRaw`
      WITH asientos AS (
        SELECT count(*)::int AS cantidad
          FROM vuelos.reserva_detalle_pasajero
         WHERE reserva_id = ${reservaId}::uuid AND tipo_pasajero <> 'INFANTE'
      ), pedido AS (
        SELECT i.vuelo_programado_id AS salida_id, f.clase_cabina,
               SUM((SELECT cantidad FROM asientos))::int AS cantidad
          FROM vuelos.reserva_detalle_itinerario r
          JOIN vuelos.itinerario_detalle i ON i.itinerario_id = r.itinerario_id
          JOIN vuelos.familia_tarifa f     ON f.id = r.familia_tarifa_id
         WHERE r.reserva_id = ${reservaId}::uuid AND r.vigente
         GROUP BY i.vuelo_programado_id, f.clase_cabina
      ), bloqueadas AS MATERIALIZED (
        SELECT ic.id, p.cantidad
          FROM vuelos.inventario_cabina ic
          JOIN pedido p ON p.salida_id = ic.vuelo_programado_id
                       AND p.clase_cabina = ic.clase_cabina
         ORDER BY ic.vuelo_programado_id, ic.clase_cabina
           FOR UPDATE OF ic
      )
      UPDATE vuelos.inventario_cabina ic
         SET cupos_disponibles = LEAST(ic.cupos_totales, ic.cupos_disponibles + b.cantidad)
        FROM bloqueadas b
       WHERE ic.id = b.id`;
  }

  /**
   * La reserva completa (sin boletos: los lee BoletoRepository) y su dueño, o null si no existe.
   */
  async detalle(
    reservaId: string,
  ): Promise<{ reserva: Omit<Reserva, 'boletos'>; idPropietario: string } | null> {
    const [cabecera] = await this.prisma.db.$queryRaw<FilaCabecera[]>`
      SELECT rc.id, rc.pnr, rc.estado::text AS estado, rc.fecha_creacion, rc.fecha_actualizacion,
             r.id_propietario, t.moneda, t.tarifa_base, t.impuestos, t.total
        FROM vuelos.reserva_cabecera rc
        JOIN vuelos.retencion_cabecera r   ON r.id = rc.retencion_id
        JOIN vuelos.vista_reserva_total t  ON t.reserva_id = rc.id
       WHERE rc.id = ${reservaId}::uuid`;
    if (!cabecera) return null;

    const [itinerarios, pasajeros, historial] = await Promise.all([
      this.itinerarios(reservaId),
      this.pasajeros(reservaId),
      this.prisma.db.reserva_detalle_historial.findMany({
        where: { reserva_id: reservaId },
        orderBy: [{ fecha_evento: 'asc' }, { id: 'asc' }],
        select: { fecha_evento: true, descripcion: true },
      }),
    ]);
    return {
      idPropietario: cabecera.id_propietario,
      reserva: {
        id: cabecera.id,
        pnr: cabecera.pnr,
        estado: cabecera.estado,
        creada: cabecera.fecha_creacion,
        actualizada: cabecera.fecha_actualizacion,
        total: {
          moneda: cabecera.moneda,
          base: cabecera.tarifa_base,
          impuestos: cabecera.impuestos,
          total: cabecera.total,
        },
        itinerarios,
        // Solo los asientos de los vuelos vigentes: un cambio de fecha con pago pendiente ya
        // tomó asientos en los vuelos nuevos, pero todavía no los vuela
        pasajeros: soloVuelosVigentes(pasajeros, itinerarios),
        historial: historial.map((h) => ({ fecha: h.fecha_evento, descripcion: h.descripcion })),
      },
    };
  }

  /**
   * Una página de las reservas del dueño, de la más reciente a la más vieja (creación e id,
   * un orden estable), con `limite + 1` filas para saber si hay otra página.
   */
  async listar(filtros: FiltrosReservas): Promise<FilaListado[]> {
    const despues = filtros.despuesDe;
    const filas = await this.prisma.db.$queryRaw<
      Array<{
        id: string;
        pnr: string;
        estado: estado_reserva;
        fecha_creacion: Date;
        moneda: string;
        tarifa_base: Prisma.Decimal;
        impuestos: Prisma.Decimal;
        total: Prisma.Decimal;
        origen: string;
        destino: string;
        fecha_salida: Date;
      }>
    >`
      SELECT rc.id, rc.pnr, rc.estado::text AS estado, rc.fecha_creacion,
             t.moneda, t.tarifa_base, t.impuestos, t.total,
             primero.origen, primero.destino, primero.fecha_salida
        FROM vuelos.reserva_cabecera rc
        JOIN vuelos.retencion_cabecera r  ON r.id = rc.retencion_id
        JOIN vuelos.vista_reserva_total t ON t.reserva_id = rc.id
        JOIN LATERAL (
          SELECT (SELECT po.codigo_iata FROM vuelos.itinerario_detalle i
                    JOIN vuelos.vuelo_programado vp ON vp.id = i.vuelo_programado_id
                    JOIN vuelos.vuelo v             ON v.id = vp.vuelo_id
                    JOIN vuelos.aeropuerto po       ON po.id = v.aeropuerto_origen_id
                   WHERE i.itinerario_id = ri.itinerario_id ORDER BY i.orden LIMIT 1) AS origen,
                 (SELECT pd.codigo_iata FROM vuelos.itinerario_detalle i
                    JOIN vuelos.vuelo_programado vp ON vp.id = i.vuelo_programado_id
                    JOIN vuelos.vuelo v             ON v.id = vp.vuelo_id
                    JOIN vuelos.aeropuerto pd       ON pd.id = v.aeropuerto_destino_id
                   WHERE i.itinerario_id = ri.itinerario_id ORDER BY i.orden DESC LIMIT 1) AS destino,
                 (SELECT vp.fecha_salida FROM vuelos.itinerario_detalle i
                    JOIN vuelos.vuelo_programado vp ON vp.id = i.vuelo_programado_id
                   WHERE i.itinerario_id = ri.itinerario_id ORDER BY i.orden LIMIT 1) AS fecha_salida
            FROM vuelos.reserva_detalle_itinerario ri
           WHERE ri.reserva_id = rc.id AND ri.vigente
           ORDER BY ri.orden
           LIMIT 1
        ) primero ON true
       WHERE r.id_propietario = ${filtros.idPropietario}
         AND (${filtros.pnr ?? null}::text IS NULL OR rc.pnr = ${filtros.pnr ?? null})
         AND (${filtros.estado ?? null}::text IS NULL OR rc.estado::text = ${filtros.estado ?? null})
         AND (${filtros.desde ?? null}::timestamptz IS NULL OR rc.fecha_creacion >= ${filtros.desde ?? null})
         AND (${filtros.hasta ?? null}::timestamptz IS NULL OR rc.fecha_creacion < ${filtros.hasta ?? null})
         AND (${despues?.creada ?? null}::timestamptz IS NULL
              OR (rc.fecha_creacion, rc.id) < (${despues?.creada ?? null}::timestamptz, ${despues?.id ?? null}::uuid))
       ORDER BY rc.fecha_creacion DESC, rc.id DESC
       LIMIT ${filtros.limite + 1}`;
    return filas.map((f) => ({
      id: f.id,
      pnr: f.pnr,
      estado: f.estado,
      creada: f.fecha_creacion,
      origen: f.origen,
      destino: f.destino,
      fechaSalida: f.fecha_salida,
      total: { moneda: f.moneda, base: f.tarifa_base, impuestos: f.impuestos, total: f.total },
    }));
  }

  /** Itinerarios vigentes con la familia vendida y sus segmentos, como los arma la búsqueda. */
  private async itinerarios(reservaId: string): Promise<ItinerarioDeReserva[]> {
    const [cabeceras, segmentos] = await Promise.all([
      this.prisma.db.$queryRaw<FilaItinerario[]>`
        SELECT r.itinerario_id AS id, r.orden, r.tarifa_base, r.impuestos, f.codigo,
               f.clase_cabina::text AS clase_cabina, f.es_cambiable,
               f.porcentaje_penalidad_cancelacion, f.incluye_articulo_personal,
               f.equipaje_mano_incluido, f.equipaje_bodega_incluido, f.maximo_equipaje_adicional,
               (SELECT SUM(t.precio_equipaje_adicional)
                  FROM vuelos.itinerario_detalle i
                  JOIN vuelos.tarifa_cabecera t ON t.vuelo_programado_id = i.vuelo_programado_id
                                               AND t.familia_tarifa_id = r.familia_tarifa_id
                 WHERE i.itinerario_id = r.itinerario_id) AS equipaje_adicional,
               (SELECT MIN(ic.cupos_disponibles)::int
                  FROM vuelos.itinerario_detalle i
                  JOIN vuelos.inventario_cabina ic ON ic.vuelo_programado_id = i.vuelo_programado_id
                                                  AND ic.clase_cabina = f.clase_cabina
                 WHERE i.itinerario_id = r.itinerario_id) AS asientos_disponibles
          FROM vuelos.reserva_detalle_itinerario r
          JOIN vuelos.familia_tarifa f ON f.id = r.familia_tarifa_id
         WHERE r.reserva_id = ${reservaId}::uuid AND r.vigente
         ORDER BY r.orden`,
      this.prisma.db.$queryRaw<FilaSegmento[]>`
        SELECT i.itinerario_id, vp.id, ac.codigo_iata || v.numero AS numero_vuelo,
               ac.id AS aerolinea_id, ac.codigo_iata AS comercializa,
               ac.nombre AS nombre_comercializa, ao.codigo_iata AS opera,
               po.codigo_iata AS origen, pd.codigo_iata AS destino, vp.fecha_salida,
               vp.salida_programada, vp.llegada_programada, vp.terminal_salida,
               vp.terminal_llegada, vp.estado::text AS estado, m.codigo_iata AS modelo
          FROM vuelos.reserva_detalle_itinerario r
          JOIN vuelos.itinerario_detalle i     ON i.itinerario_id = r.itinerario_id
          JOIN vuelos.vuelo_programado vp      ON vp.id = i.vuelo_programado_id
          JOIN vuelos.vuelo v                  ON v.id = vp.vuelo_id
          JOIN vuelos.aerolinea ac             ON ac.id = v.aerolinea_id
          JOIN vuelos.aerolinea ao             ON ao.id = v.aerolinea_operadora_id
          JOIN vuelos.aeropuerto po            ON po.id = v.aeropuerto_origen_id
          JOIN vuelos.aeropuerto pd            ON pd.id = v.aeropuerto_destino_id
          JOIN vuelos.mapa_asientos_cabecera mc ON mc.id = vp.mapa_asientos_id
          JOIN vuelos.modelo_aeronave m        ON m.id = mc.modelo_aeronave_id
         WHERE r.reserva_id = ${reservaId}::uuid AND r.vigente
         ORDER BY r.orden, i.orden`,
    ]);
    return cabeceras.map((c) => ({
      id: c.id,
      orden: c.orden,
      base: c.tarifa_base,
      impuestos: c.impuestos,
      familia: {
        codigo: c.codigo,
        cabina: c.clase_cabina,
        esCambiable: c.es_cambiable,
        reembolsable: c.porcentaje_penalidad_cancelacion.lessThan(100),
        articuloPersonal: c.incluye_articulo_personal,
        equipajeMano: c.equipaje_mano_incluido,
        equipajeBodega: c.equipaje_bodega_incluido,
        equipajeAdicional: c.equipaje_adicional ?? new Prisma.Decimal(0),
        maximoEquipaje: c.maximo_equipaje_adicional,
        asientosDisponibles: c.asientos_disponibles ?? 0,
      },
      salidas: segmentos.filter((s) => s.itinerario_id === c.id).map(aSalida),
    }));
  }

  private async pasajeros(reservaId: string): Promise<PasajeroDeReserva[]> {
    const filas = await this.prisma.db.reserva_detalle_pasajero.findMany({
      where: { reserva_id: reservaId },
      orderBy: { id: 'asc' },
      include: {
        pais: { select: { codigo_iso2: true } },
        reserva_detalle_pasajero: { select: { codigo_pasajero: true } },
        reserva_detalle_asiento: {
          where: { fecha_liberacion: null },
          orderBy: { fecha_asignacion: 'asc' },
          select: {
            vuelo_programado_id: true,
            asiento: {
              select: {
                letra: true,
                mapa_asientos_detalle: { select: { numero_fila: true } },
              },
            },
            vuelo_programado: { select: { salida_programada: true } },
          },
        },
        // Las maletas con pago rechazado no cuentan; las de pago pendiente, sí (ya ocupan cupo)
        reserva_detalle_equipaje: {
          where: { reserva_detalle_pago: { estado: { not: 'RECHAZADO' } } },
          select: {
            cantidad: true,
            reserva_detalle_itinerario: { select: { itinerario_id: true } },
          },
        },
      },
    });
    return filas.map((p) => ({
      codigo: p.codigo_pasajero,
      tipo: p.tipo_pasajero,
      adultoResponsable: p.reserva_detalle_pasajero?.codigo_pasajero ?? null,
      nombres: p.nombres,
      apellidos: p.apellidos,
      tipoDocumento: p.tipo_documento,
      numeroDocumento: p.numero_documento,
      nacionalidad: p.pais.codigo_iso2,
      vencimientoDocumento: p.fecha_vencimiento_documento,
      nacimiento: p.fecha_nacimiento,
      genero: p.genero,
      correo: p.correo,
      telefono: p.telefono,
      asientos: [...p.reserva_detalle_asiento]
        .sort(
          (a, b) =>
            a.vuelo_programado.salida_programada.getTime() -
            b.vuelo_programado.salida_programada.getTime(),
        )
        .map((a) => ({
          salidaId: a.vuelo_programado_id,
          numero: `${a.asiento.mapa_asientos_detalle.numero_fila}${a.asiento.letra}`,
        })),
      equipaje: agruparEquipaje(
        p.reserva_detalle_equipaje.map((e) => ({
          itinerarioId: e.reserva_detalle_itinerario.itinerario_id,
          cantidad: e.cantidad,
        })),
      ),
    }));
  }
}

function aSalida(f: FilaSegmento): SalidaVendible {
  return {
    id: f.id,
    numeroVuelo: f.numero_vuelo,
    aerolineaId: f.aerolinea_id,
    comercializa: f.comercializa,
    nombreComercializa: f.nombre_comercializa,
    opera: f.opera,
    origen: f.origen,
    destino: f.destino,
    fechaSalida: f.fecha_salida,
    salida: f.salida_programada,
    llegada: f.llegada_programada,
    terminalSalida: f.terminal_salida,
    terminalLlegada: f.terminal_llegada,
    estado: f.estado,
    modelo: f.modelo,
  };
}

function soloVuelosVigentes(
  pasajeros: PasajeroDeReserva[],
  itinerarios: ItinerarioDeReserva[],
): PasajeroDeReserva[] {
  const vigentes = new Set(itinerarios.flatMap((it) => it.salidas.map((s) => s.id)));
  return pasajeros.map((p) => ({
    ...p,
    asientos: p.asientos.filter((a) => vigentes.has(a.salidaId)),
  }));
}

/** Las maletas compradas en varias veces para el mismo itinerario se suman. */
function agruparEquipaje(
  compras: Array<{ itinerarioId: string; cantidad: number }>,
): Array<{ itinerarioId: string; cantidad: number }> {
  const total = new Map<string, number>();
  for (const c of compras) total.set(c.itinerarioId, (total.get(c.itinerarioId) ?? 0) + c.cantidad);
  return [...total].map(([itinerarioId, cantidad]) => ({ itinerarioId, cantidad }));
}
