import { TransaccionVuelos } from '../../src/prisma/prisma.service';

type Fila = Record<string, never>;

export interface FixtureReserva {
  vueloProgramadoId: string;
  asientosDelMapa: bigint[];
  asientoDeOtroMapa: bigint;
  reserva1: string;
  reserva2: string;
  adulto1: bigint;
  adulto2: bigint;
  infante: bigint;
  adultoDeReserva2: bigint;
  itinerarioReserva1: bigint;
  pagoReserva2: bigint;
}

/**
 * Arma, dentro de una transacción que luego se revierte, dos reservas con pasajeros sobre un
 * vuelo de la semilla. Sirve para disparar los triggers de la sección 15 del esquema.
 * Todo con SQL crudo y tablas calificadas: el adaptador no fija el search_path.
 */
export async function armarReservas(tx: TransaccionVuelos): Promise<FixtureReserva> {
  const consultar = <T = Fila>(sql: string, ...p: unknown[]) => tx.$queryRawUnsafe<T[]>(sql, ...p);

  const [vp] = await consultar<{ id: string; mapa_asientos_id: bigint; aerolinea_id: bigint }>(
    `SELECT vp.id, vp.mapa_asientos_id, v.aerolinea_id
       FROM vuelos.vuelo_programado vp JOIN vuelos.vuelo v ON v.id = vp.vuelo_id LIMIT 1`,
  );
  const asientos = await consultar<{ id: bigint }>(
    `SELECT a.id FROM vuelos.asiento a
       JOIN vuelos.mapa_asientos_detalle f ON f.id = a.mapa_asientos_detalle_id
      WHERE f.mapa_asientos_id = $1 ORDER BY a.id LIMIT 3`,
    vp.mapa_asientos_id,
  );
  const [otroMapa] = await consultar<{ id: bigint }>(
    `SELECT a.id FROM vuelos.asiento a
       JOIN vuelos.mapa_asientos_detalle f ON f.id = a.mapa_asientos_detalle_id
      WHERE f.mapa_asientos_id <> $1 LIMIT 1`,
    vp.mapa_asientos_id,
  );
  const [{ id: monedaId }] = await consultar<{ id: bigint }>(
    `SELECT id FROM vuelos.moneda LIMIT 1`,
  );
  const [{ id: familiaId }] = await consultar<{ id: bigint }>(
    `SELECT id FROM vuelos.familia_tarifa LIMIT 1`,
  );
  const [{ id: ofertaId }] = await consultar<{ id: string }>(
    `INSERT INTO vuelos.oferta_cabecera (aerolinea_id, huella_dispositivo, fecha_expiracion)
     VALUES ($1, 'fp-prueba', now() + interval '30 minutes') RETURNING id`,
    vp.aerolinea_id,
  );

  const crearReserva = async (pnr: string, adultos: number, infantes: number) => {
    const [{ id: retencionId }] = await consultar<{ id: string }>(
      `INSERT INTO vuelos.retencion_cabecera (oferta_id, id_propietario, moneda_id, adultos, infantes, fecha_expiracion)
       VALUES ($1::uuid, 'usuario-prueba', $2, $3, $4, now() + interval '15 minutes') RETURNING id`,
      ofertaId,
      monedaId,
      adultos,
      infantes,
    );
    const [{ id }] = await consultar<{ id: string }>(
      `INSERT INTO vuelos.reserva_cabecera (retencion_id, pnr) VALUES ($1::uuid, $2) RETURNING id`,
      retencionId,
      pnr,
    );
    return id;
  };

  const crearPasajero = async (
    reservaId: string,
    codigo: string,
    tipo: 'ADULTO' | 'INFANTE',
    adulto: bigint | null,
    documento: string,
  ) => {
    const [{ id }] = await consultar<{ id: bigint }>(
      `INSERT INTO vuelos.reserva_detalle_pasajero
         (reserva_id, codigo_pasajero, tipo_pasajero, adulto_responsable_id, nombres, apellidos,
          tipo_documento, numero_documento, pais_nacionalidad_id, fecha_nacimiento, genero, correo, telefono)
       VALUES ($1::uuid, $2, $3::vuelos.tipo_pasajero, $4, 'Nombre', 'Apellido', 'CEDULA', $5,
               (SELECT id FROM vuelos.pais LIMIT 1), '1990-01-01', 'M', 'prueba@example.com', '+593991234567')
       RETURNING id`,
      reservaId,
      codigo,
      tipo,
      adulto,
      documento,
    );
    return id;
  };

  const reserva1 = await crearReserva('AB12CD', 2, 1);
  const reserva2 = await crearReserva('ZX98YW', 1, 0);
  const adulto1 = await crearPasajero(reserva1, 'PAX1', 'ADULTO', null, '1710034065');
  const adulto2 = await crearPasajero(reserva1, 'PAX2', 'ADULTO', null, '1710034066');
  const infante = await crearPasajero(reserva1, 'PAX3', 'INFANTE', adulto1, '1750000001');
  const adultoDeReserva2 = await crearPasajero(reserva2, 'PAX1', 'ADULTO', null, '1710034073');

  const [{ id: itinerarioId }] = await consultar<{ id: string }>(
    `INSERT INTO vuelos.itinerario_cabecera DEFAULT VALUES RETURNING id`,
  );
  const [{ id: itinerarioReserva1 }] = await consultar<{ id: bigint }>(
    `INSERT INTO vuelos.reserva_detalle_itinerario (reserva_id, itinerario_id, familia_tarifa_id, orden, tarifa_base, impuestos)
     VALUES ($1::uuid, $2::uuid, $3, 1, 10, 1) RETURNING id`,
    reserva1,
    itinerarioId,
    familiaId,
  );
  const [{ id: pagoReserva2 }] = await consultar<{ id: bigint }>(
    `INSERT INTO vuelos.reserva_detalle_pago (reserva_id, referencia_pago, concepto)
     VALUES ($1::uuid, 'PAY-PRUEBA-2', 'EQUIPAJE_ADICIONAL') RETURNING id`,
    reserva2,
  );

  return {
    vueloProgramadoId: vp.id,
    asientosDelMapa: asientos.map((a) => a.id),
    asientoDeOtroMapa: otroMapa.id,
    reserva1,
    reserva2,
    adulto1,
    adulto2,
    infante,
    adultoDeReserva2,
    itinerarioReserva1,
    pagoReserva2,
  };
}
