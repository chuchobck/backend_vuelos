import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CodigoError } from '../src/common/errores/codigo-error';
import { traducirExcepcion } from '../src/common/errores/traducir-excepcion';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';
import { armarReservas } from './utils/fixture-reserva';
import { capturar, capturarError, enTransaccionRevertida } from './utils/transaccion-revertida';

/**
 * Cada caso provoca el error contra la base real (dentro de una transacción que se revierte),
 * toma el error tal como lo entrega Prisma 7 y comprueba a qué status y `code` del contrato
 * lo traduce el filtro.
 */
describe('Errores de la base traducidos al contrato', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let conteoInicial: { reservas: number; auditoria: number };

  const contar = async () => {
    const [conteo] = await prisma.db.$queryRawUnsafe<{ reservas: number; auditoria: number }[]>(
      `SELECT (SELECT count(*)::int FROM vuelos.reserva_cabecera) AS reservas,
              (SELECT count(*)::int FROM vuelos.auditoria) AS auditoria`,
    );
    return conteo;
  };

  const traducir = (error: unknown) =>
    traducirExcepcion(error, { metodo: 'POST', ruta: '/flights/v1/x', metodosPermitidos: [] });

  const esperar = (error: unknown, status: number, code: CodigoError, detail?: string) => {
    const { problema } = traducir(error);
    expect(problema).toMatchObject({ status, code });
    if (detail !== undefined) expect(problema.detail).toBe(detail);
    // Nada interno hacia afuera: ni tablas, ni columnas, ni SQL.
    expect(JSON.stringify(problema)).not.toMatch(/pais|ciudad|vuelos\.|constraint|SELECT|INSERT/i);
  };

  beforeAll(async () => {
    app = await crearApp();
    prisma = app.get(PrismaService);
    conteoInicial = await contar();
  });

  afterAll(async () => {
    await app.close();
  });

  it('P2002 (unique) → 409 VALIDATION_FAILED', async () => {
    await enTransaccionRevertida(prisma, async (tx) => {
      const error = await tx.pais
        .create({ data: { codigo_iso2: 'EC', codigo_iso3: 'ZZZ', nombre: 'Otro' } })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe('P2002');
      esperar(
        error,
        409,
        CodigoError.VALIDATION_FAILED,
        'A record with the same unique value already exists',
      );
    });
  });

  it('P2003 (FK sin padre) → 422', async () => {
    await enTransaccionRevertida(prisma, async (tx) => {
      const error = await tx.ciudad
        .create({ data: { pais_id: 999999n, nombre: 'X' } })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe('P2003');
      esperar(error, 422, CodigoError.VALIDATION_FAILED, 'A referenced record does not exist');
    });
  });

  it('P2025 (no encontrado) → 404', async () => {
    await enTransaccionRevertida(prisma, async (tx) => {
      const error = await tx.pais
        .update({ where: { id: 999999n }, data: { nombre: 'Y' } })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe('P2025');
      esperar(error, 404, CodigoError.VALIDATION_FAILED, 'The record was not found');
    });
  });

  it('ON DELETE RESTRICT (SQLSTATE 23001) → 409, con SQL crudo y con delete anidado', async () => {
    await enTransaccionRevertida(prisma, async (tx) => {
      const crudo = await capturarError(tx, `DELETE FROM vuelos.pais WHERE codigo_iso2 = 'EC'`);
      expect((crudo as { code: string }).code).toBe('P2010');
      esperar(
        crudo,
        409,
        CodigoError.VALIDATION_FAILED,
        'The record is referenced by other records and cannot be removed',
      );

      // El bloqueo de delete no cubre un delete anidado en un update: llega a la base.
      const anidado = await tx.pais
        .update({ where: { codigo_iso2: 'EC' }, data: { ciudad: { deleteMany: {} } } })
        .catch((e: unknown) => e);
      expect((anidado as { code: string }).code).toBe('P2003');
      esperar(anidado, 409, CodigoError.VALIDATION_FAILED);
    });
  });

  it('CHECK, NOT NULL, texto largo y formato de uuid → 422 / 400', async () => {
    await enTransaccionRevertida(prisma, async (tx) => {
      const check = await capturar(tx, () =>
        tx.pais.create({ data: { codigo_iso2: 'zz', codigo_iso3: 'ZZZ', nombre: 'Zeta' } }),
      );
      esperar(check, 422, CodigoError.VALIDATION_FAILED, 'The data violates a business rule');

      const nulo = await capturarError(
        tx,
        `INSERT INTO vuelos.pais (codigo_iso2, codigo_iso3, nombre) VALUES ('ZY', 'ZYY', NULL)`,
      );
      esperar(nulo, 400, CodigoError.VALIDATION_FAILED, 'A required value is missing');

      const largo = await capturar(tx, () =>
        tx.pais.create({ data: { codigo_iso2: 'ABC', codigo_iso3: 'ZZZ', nombre: 'Largo' } }),
      );
      esperar(largo, 400, CodigoError.VALIDATION_FAILED, 'A value is too long');

      const uuid = await capturarError(
        tx,
        `SELECT * FROM vuelos.vuelo_programado WHERE id = 'no-es-uuid'`,
      );
      esperar(uuid, 400, CodigoError.VALIDATION_FAILED, 'A value has an invalid format');
    });
  });

  it('los triggers de integridad y los índices únicos de reservas', async () => {
    await enTransaccionRevertida(prisma, async (tx) => {
      const f = await armarReservas(tx);
      const insertarAsiento = `INSERT INTO vuelos.reserva_detalle_asiento (pasajero_id, vuelo_programado_id, asiento_id) VALUES ($1, $2::uuid, $3)`;

      // Infante con asiento
      esperar(
        await capturarError(
          tx,
          insertarAsiento,
          f.infante,
          f.vueloProgramadoId,
          f.asientosDelMapa[0],
        ),
        422,
        CodigoError.INFANT_SEAT_NOT_ALLOWED,
        'An infant cannot be assigned a seat',
      );

      // Asiento que no es del mapa del vuelo
      esperar(
        await capturarError(
          tx,
          insertarAsiento,
          f.adulto1,
          f.vueloProgramadoId,
          f.asientoDeOtroMapa,
        ),
        422,
        CodigoError.VALIDATION_FAILED,
        'The seat does not belong to the seat map of this flight',
      );

      // Adulto responsable de otra reserva
      esperar(
        await capturarError(
          tx,
          `INSERT INTO vuelos.reserva_detalle_pasajero
             (reserva_id, codigo_pasajero, tipo_pasajero, adulto_responsable_id, nombres, apellidos,
              tipo_documento, numero_documento, pais_nacionalidad_id, fecha_nacimiento, genero, correo, telefono)
           VALUES ($1::uuid, 'PAX9', 'INFANTE', $2, 'B', 'P', 'CEDULA', '1750000009',
                   (SELECT id FROM vuelos.pais LIMIT 1), '2026-01-01', 'X', 'a@b.co', '+593991234567')`,
          f.reserva1,
          f.adultoDeReserva2,
        ),
        422,
        CodigoError.VALIDATION_FAILED,
        'The responsible adult must be an adult passenger of the same booking',
      );

      // Equipaje con el pago de otra reserva
      esperar(
        await capturarError(
          tx,
          `INSERT INTO vuelos.reserva_detalle_equipaje (pasajero_id, reserva_itinerario_id, pago_id, cantidad, precio_unitario)
           VALUES ($1, $2, $3, 1, 20)`,
          f.adulto1,
          f.itinerarioReserva1,
          f.pagoReserva2,
        ),
        422,
        CodigoError.VALIDATION_FAILED,
        'The passenger, itinerary and payment of the baggage must belong to the same booking',
      );

      // Asiento ocupado: el segundo pasajero pide el mismo asiento del mismo vuelo
      await tx.$executeRawUnsafe(
        insertarAsiento,
        f.adulto1,
        f.vueloProgramadoId,
        f.asientosDelMapa[0],
      );
      esperar(
        await capturarError(
          tx,
          insertarAsiento,
          f.adulto2,
          f.vueloProgramadoId,
          f.asientosDelMapa[0],
        ),
        409,
        CodigoError.SEAT_TAKEN,
        'The seat is already taken on this flight',
      );
    });
  });

  it('un cambio a auditoria (solo inserción) no se traduce: es un fallo interno 500', async () => {
    await enTransaccionRevertida(prisma, async (tx) => {
      await tx.pais.create({ data: { codigo_iso2: 'ZY', codigo_iso3: 'ZYY', nombre: 'Zy' } });
      const error = await capturarError(
        tx,
        `UPDATE vuelos.auditoria SET nombre_tabla = nombre_tabla`,
      );
      const { problema, esErrorInterno } = traducir(error);

      expect(esErrorInterno).toBe(true);
      expect(problema.status).toBe(500);
      expect(problema.detail).toBeUndefined();
    });
  });

  it('un choque de escritura concurrente (40001) → 409 con Retry-After', async () => {
    await enTransaccionRevertida(prisma, async (tx) => {
      const error = await capturarError(
        tx,
        `DO $$ BEGIN RAISE EXCEPTION 'conflicto' USING ERRCODE = '40001'; END $$`,
      );
      const { problema, cabeceras } = traducir(error);

      expect(problema.status).toBe(409);
      expect(cabeceras['Retry-After']).toBe('1');
    });
  });

  it('con la base caída → 503 con Retry-After y sin detalles internos', async () => {
    const caida = new PrismaService({
      getOrThrow: () => 'postgresql://postgres:postgres@localhost:5999/booking_db?schema=vuelos',
    } as unknown as ConfigService);

    const error = await caida.db.pais.findFirst().catch((e: unknown) => e);
    const { problema, cabeceras } = traducir(error);

    expect(problema).toMatchObject({
      status: 503,
      detail: 'The database is temporarily unavailable',
    });
    expect(cabeceras['Retry-After']).toBe('5');
    expect(JSON.stringify(problema)).not.toMatch(/5999|localhost|127\.0\.0\.1/);
    await caida.onModuleDestroy();
  });

  it('las pruebas no dejaron datos', async () => {
    expect(await contar()).toEqual(conteoInicial);
  });
});
