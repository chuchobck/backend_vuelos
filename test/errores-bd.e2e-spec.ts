import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as dns from 'node:dns';
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
      // Una restricción sin mensaje propio en POR_RESTRICCION: sale el genérico
      const error = await tx.moneda
        .create({ data: { codigo_iso: 'USD', nombre: 'Otro dólar' } })
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

  describe('con la base caída', () => {
    const NADA_DE_RED = /5999|localhost|127\.0\.0\.1|::1/;

    /** Una Prisma apuntada a un puerto sin servidor; devuelve el error que entrega y lo traduce. */
    const consultarBaseCaida = async (host: string) => {
      const caida = new PrismaService({
        getOrThrow: () => `postgresql://postgres:postgres@${host}:5999/booking_db?schema=vuelos`,
      } as unknown as ConfigService);
      try {
        const error = await caida.db.pais.findFirst().catch((e: unknown) => e);
        return { error, ...traducir(error) };
      } finally {
        await caida.onModuleDestroy();
      }
    };

    const espera503 = (resultado: ReturnType<typeof traducir>) => {
      expect(resultado.problema).toMatchObject({
        status: 503,
        detail: 'The database is temporarily unavailable',
      });
      expect(resultado.cabeceras['Retry-After']).toBe('5');
      expect(JSON.stringify(resultado.problema)).not.toMatch(NADA_DE_RED);
    };

    it('503 con Retry-After y sin detalles internos (IPv4 explícito)', async () => {
      espera503(await consultarBaseCaida('127.0.0.1'));
    });

    it('503 también con IPv6 explícito', async () => {
      espera503(await consultarBaseCaida('[::1]'));
    });

    it('503 si `localhost` resuelve a ::1 y 127.0.0.1, como en ubuntu-latest de GitHub', async () => {
      // Node prueba las dos direcciones y, si ninguna responde, lanza un AggregateError sin
      // syscall ni errno que el adaptador de pg no reconoce: Prisma lo entrega como
      // PrismaClientKnownRequestError con code ECONNREFUSED y sin driverAdapterError
      const original = dns.lookup;
      const dos = [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ];
      (dns as { lookup: unknown }).lookup = (
        host: string,
        opciones: unknown,
        devolver?: (...args: unknown[]) => void,
      ) => {
        const cb = (typeof opciones === 'function' ? opciones : devolver) as (
          ...a: unknown[]
        ) => void;
        const todas = typeof opciones === 'object' && (opciones as { all?: boolean }).all;
        if (host !== 'localhost') {
          return (original as (...a: unknown[]) => void)(host, opciones, devolver);
        }
        process.nextTick(() => (todas ? cb(null, dos) : cb(null, dos[0].address, dos[0].family)));
      };
      try {
        const resultado = await consultarBaseCaida('localhost');
        expect((resultado.error as { code?: string }).code).toBe('ECONNREFUSED');
        espera503(resultado);
      } finally {
        (dns as { lookup: unknown }).lookup = original;
      }
    });
  });

  describe('fallos de conexión que no llegan como DatabaseNotReachable', () => {
    const NADA_DE_RED = /5999|localhost|127\.0\.0\.1|::1|10\.1\.2\.3/;
    /** Un Error con `cause` (el `lib` del proyecto no trae el constructor de ES2022). */
    const conCausa = (mensaje: string, cause: unknown) =>
      Object.assign(new Error(mensaje), { cause });
    const de = (codigo: string, extra: object = {}) =>
      Object.assign(new Error(`connect ${codigo} 127.0.0.1:5999`), { code: codigo, ...extra });
    const espera503 = (error: unknown) => {
      const { problema, cabeceras } = traducir(error);
      expect(problema).toMatchObject({
        status: 503,
        detail: 'The database is temporarily unavailable',
      });
      expect(cabeceras['Retry-After']).toBe('5');
      // Ni el host ni el puerto del mensaje original salen hacia el cliente
      expect(JSON.stringify(problema)).not.toMatch(NADA_DE_RED);
    };
    const espera500 = (error: unknown) => {
      const { problema, cabeceras, esErrorInterno } = traducir(error);
      expect(problema.status).toBe(500);
      expect(esErrorInterno).toBe(true);
      expect(cabeceras['Retry-After']).toBeUndefined();
      expect(JSON.stringify(problema)).not.toMatch(NADA_DE_RED);
    };

    it.each([
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ECONNRESET',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
    ])('un error simple con code %s → 503', (codigo) => {
      espera503(de(codigo, { syscall: 'connect', errno: -111, address: '10.1.2.3', port: 5999 }));
    });

    it('un AggregateError con ECONNREFUSED dentro de errors[] → 503', () => {
      const agregado = new AggregateError([de('ECONNREFUSED'), de('ECONNREFUSED')], '');
      espera503(agregado);
    });

    it('un AggregateError con el code en sí mismo (como el de Node 22) → 503', () => {
      espera503(Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }));
    });

    it('el error de Prisma tal como llega: PrismaClientKnownRequestError con code ECONNREFUSED y sin driverAdapterError → 503', () => {
      const prisma = Object.assign(new Error('Invalid `db.pais.findFirst()` invocation'), {
        name: 'PrismaClientKnownRequestError',
        code: 'ECONNREFUSED',
        meta: { modelName: 'pais' },
        clientVersion: '7.10.0',
      });
      espera503(prisma);
    });

    it('un error con la causa anidada en `cause` → 503', () => {
      const raiz = conCausa('capa 1', conCausa('capa 2', conCausa('capa 3', de('ETIMEDOUT'))));
      espera503(raiz);
    });

    it('un error con el code dentro de meta.driverAdapterError.cause → 503', () => {
      espera503(
        Object.assign(new Error('x'), {
          name: 'PrismaClientKnownRequestError',
          meta: { driverAdapterError: { name: 'DriverAdapterError', cause: de('ECONNRESET') } },
        }),
      );
    });

    it('un AggregateError cuyas causas están anidadas en `cause` → 503', () => {
      espera503(new AggregateError([conCausa('a', de('ENOTFOUND'))], ''));
    });

    it('una cadena con ciclos termina y no se traduce si no hay un fallo de red', () => {
      const a: { cause?: unknown; errors?: unknown[] } = {};
      const b = { cause: a };
      a.cause = b;
      a.errors = [a, b];
      espera500(Object.assign(new Error('ciclo'), a));
    });

    it('un ciclo con un fallo de red adentro sí se traduce', () => {
      const a = new Error('a') as Error & { cause?: unknown };
      const b = conCausa('b', a) as Error & { cause?: unknown; errors?: unknown[] };
      a.cause = b;
      b.errors = [de('ECONNREFUSED')];
      espera503(a);
    });

    it('la profundidad está acotada: a 5 niveles se traduce; a 7 no', () => {
      const anidar = (niveles: number) => {
        let error: Error = de('ECONNREFUSED');
        for (let i = 0; i < niveles; i++) error = conCausa(`nivel ${i}`, error);
        return error;
      };
      espera503(anidar(5));
      espera500(anidar(7));
    });

    describe('lo que NO es un fallo de conexión sigue siendo 500', () => {
      it.each([
        ['un Error común', new Error('boom')],
        ['un code que no es de red (EACCES)', de('EACCES')],
        ['un code desconocido', de('ESOMETHING')],
        [
          'ECONNREFUSED solo en el mensaje, sin code',
          new Error('connect ECONNREFUSED 127.0.0.1:5999'),
        ],
        ['un code ECONNREFUSED que no es texto', Object.assign(new Error('x'), { code: 111 })],
        ['un TypeError', new TypeError('x is not a function')],
        ['una cadena de causas sin red', conCausa('a', conCausa('b', de('EPERM')))],
        ['un valor que no es un objeto', 'ECONNREFUSED'],
        ['null', null],
      ])('%s', (_nombre, error) => {
        const { problema } = traducir(error);
        expect(problema.status).toBe(500);
        expect(problema.detail).toBeUndefined();
        expect(JSON.stringify(problema)).not.toMatch(NADA_DE_RED);
      });

      it('un error de la base que no es de conexión conserva su traducción', () => {
        const unico = Object.assign(new Error('x'), {
          name: 'PrismaClientKnownRequestError',
          code: 'P2002',
          meta: {
            driverAdapterError: {
              cause: { originalCode: '23505', kind: 'UniqueConstraintViolation' },
            },
          },
        });
        expect(traducir(unico).problema.status).toBe(409);
      });
    });
  });

  it('las pruebas no dejaron datos', async () => {
    expect(await contar()).toEqual(conteoInicial);
  });
});
