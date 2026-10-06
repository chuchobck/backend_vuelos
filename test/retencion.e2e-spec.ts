import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { RetencionService } from '../src/modules/vuelos/operaciones/retencion/retencion.service';
import { VencimientoRetenciones } from '../src/modules/vuelos/operaciones/retencion/vencimiento-retenciones';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearUsuario, desactivarUsuariosDePrueba, firmarToken, iniciarSesion } from './utils/auth';
import { CadenaBusqueda, crearCadena, darDeBajaCadena, fechaEn, HUELLA } from './utils/busqueda';
import { ADMIN, AppCatalogo, crearAppCatalogo } from './utils/catalogo';
import { erroresContraContrato } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

const HOLD = '/flights/v1/offers/hold';
const CABINAS: Record<string, string> = {
  ECONOMY: 'ECONOMICA',
  PREMIUM_ECONOMY: 'ECONOMICA_PREMIUM',
  BUSINESS: 'EJECUTIVA',
  FIRST: 'PRIMERA',
};
const TIPOS: Record<string, string> = {
  ADULT: 'adults',
  YOUTH: 'youths',
  CHILD: 'children',
  INFANT: 'infants',
};

type Pasajeros = { adults?: number; youths?: number; children?: number; infants?: number };
type Opcion = {
  cabinClass: string;
  fareBrand: string;
  pricePerPassengerType: Array<{
    passengerType: string;
    price: { baseFare: string; taxes: string; total: string };
  }>;
};
type Oferta = {
  offerId: string;
  itineraries: Array<{
    itineraryId: string;
    segments: Array<{ segmentId: string }>;
    pricingOptions: Opcion[];
  }>;
};
type Metodo = 'get' | 'post' | 'delete';

/** Dinero en centavos, para sumar sin pasar por un float. */
const centavos = (texto: string) => {
  const [enteros, decimales = ''] = texto.split('.');
  return BigInt(enteros) * 100n + BigInt(decimales.padEnd(2, '0'));
};
const aTexto = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;

/** Petición con un token (o sin él). */
function con(app: INestApplication, token?: string) {
  return (metodo: Metodo, ruta: string) => {
    const prueba = request(app.getHttpServer())[metodo](ruta);
    return token ? prueba.set('Authorization', `Bearer ${token}`) : prueba;
  };
}

/** Un token de cliente nuevo (el usuario se crea con el service, sin gastar límites). */
async function tokenDeCliente(app: INestApplication): Promise<{ id: string; token: string }> {
  const usuario = await crearUsuario(app);
  return { id: usuario.id, token: (await iniciarSesion(app, usuario)).access_token };
}

function retener(
  app: INestApplication,
  token: string,
  cuerpo: object,
  clave: string | null = randomUUID(),
): request.Test {
  const prueba = con(app, token)('post', HOLD);
  return (clave === null ? prueba : prueba.set('Idempotency-Key', clave)).send(cuerpo);
}

async function buscarOferta(
  app: INestApplication,
  itineraries: object[],
  passengers: Pasajeros,
): Promise<Oferta> {
  const respuesta = await request(app.getHttpServer())
    .post('/flights/v1/search')
    .set('X-Device-Fingerprint', HUELLA)
    .send({ itineraries, passengers })
    .expect(200);
  expect(respuesta.body.offers.length).toBeGreaterThan(0);
  return respuesta.body.offers[0];
}

/** HoldRequest con la primera opción de precio de cada itinerario (o la de `fareBrand`). */
function cuerpoDe(oferta: Oferta, pasajeros: Pasajeros, fareBrand?: string) {
  return {
    offerId: oferta.offerId,
    itinerarySelections: oferta.itineraries.map((it) => {
      const opcion = fareBrand
        ? it.pricingOptions.find((o) => o.fareBrand === fareBrand)!
        : it.pricingOptions[0];
      return {
        itineraryId: it.itineraryId,
        cabinClass: opcion.cabinClass,
        fareBrand: opcion.fareBrand,
      };
    }),
    passengersBreakdown: pasajeros,
  };
}

/** El precio que mostró la búsqueda para esas opciones y esos pasajeros. */
function precioEsperado(oferta: Oferta, pasajeros: Pasajeros) {
  let base = 0n;
  let impuestos = 0n;
  for (const it of oferta.itineraries) {
    for (const { passengerType, price } of it.pricingOptions[0].pricePerPassengerType) {
      const cantidad = BigInt(pasajeros[TIPOS[passengerType] as keyof Pasajeros] ?? 0);
      base += centavos(price.baseFare) * cantidad;
      impuestos += centavos(price.taxes) * cantidad;
    }
  }
  return {
    currency: 'USD',
    baseFare: aTexto(base),
    taxes: aTexto(impuestos),
    total: aTexto(base + impuestos),
  };
}

interface Cupo {
  totales: number;
  disponibles: number;
  /**
   * Lo que ocupa cupo en esa cabina: los pasajeros con asiento de los holds RETENIDA (y de los
   * consumidos sin reserva), más los asientos asignados de las reservas. Desde la fase 8 una
   * reserva puede cancelarse o cambiar de vuelo: su hold CONSUMIDA ya no dice dónde está el cupo.
   */
  retenidos: number;
}

async function cupo(prisma: PrismaService, salida: string, cabina = 'ECONOMICA'): Promise<Cupo> {
  const [fila] = await prisma.db.$queryRaw<Cupo[]>`
    SELECT ic.cupos_totales::int AS totales, ic.cupos_disponibles::int AS disponibles,
           COALESCE((SELECT SUM(r.adultos + r.jovenes + r.ninos)
                       FROM vuelos.retencion_cabecera r
                       JOIN vuelos.retencion_detalle d  ON d.retencion_id = r.id
                       JOIN vuelos.itinerario_detalle i ON i.itinerario_id = d.itinerario_id
                       JOIN vuelos.familia_tarifa f     ON f.id = d.familia_tarifa_id
                      WHERE (r.estado = 'RETENIDA'
                             OR (r.estado = 'CONSUMIDA' AND NOT EXISTS (
                                   SELECT 1 FROM vuelos.reserva_cabecera rc WHERE rc.retencion_id = r.id)))
                        AND i.vuelo_programado_id = ic.vuelo_programado_id
                        AND f.clase_cabina = ic.clase_cabina), 0)::int
           + (SELECT count(*)::int
                FROM vuelos.reserva_detalle_asiento a
                JOIN vuelos.asiento s               ON s.id = a.asiento_id
                JOIN vuelos.mapa_asientos_detalle m ON m.id = s.mapa_asientos_detalle_id
               WHERE a.vuelo_programado_id = ic.vuelo_programado_id
                 AND a.fecha_liberacion IS NULL
                 AND m.clase_cabina = ic.clase_cabina) AS retenidos
      FROM vuelos.inventario_cabina ic
     WHERE ic.vuelo_programado_id = ${salida}::uuid AND ic.clase_cabina::text = ${cabina}`;
  return fila;
}

async function estadoEnBase(prisma: PrismaService, id: string): Promise<string> {
  const fila = await prisma.db.retencion_cabecera.findUniqueOrThrow({
    where: { id },
    select: { estado: true },
  });
  return fila.estado;
}

function esperarContrato(esquema: string, cuerpo: unknown): void {
  expect(erroresContraContrato(esquema, cuerpo)).toEqual([]);
}

describe('POST /offers/hold sobre la semilla', () => {
  const reloj = new RelojDePrueba();
  let app: INestApplication;
  let prisma: PrismaService;
  let cliente: { id: string; token: string };
  const creadas: string[] = [];

  beforeAll(async () => {
    app = await crearApp([], { reloj });
    prisma = app.get(PrismaService);
    cliente = await tokenDeCliente(app);
  });
  beforeEach(() => reloj.alPresente());
  afterAll(async () => {
    for (const id of creadas) await con(app, cliente.token)('delete', `${HOLD}/${id}`).expect(204);
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  it('solo ida, un adulto: 201 que cumple HoldResponse, con el precio de la búsqueda y el cupo tomado', async () => {
    const oferta = await buscarOferta(
      app,
      [{ origin: 'UIO', destination: 'GYE', departureDate: fechaEn(30) }],
      { adults: 1 },
    );
    const segmento = oferta.itineraries[0].segments[0].segmentId;
    const cabina = CABINAS[oferta.itineraries[0].pricingOptions[0].cabinClass];
    const antes = await cupo(prisma, segmento, cabina);

    const respuesta = await retener(app, cliente.token, cuerpoDe(oferta, { adults: 1 })).expect(
      201,
    );
    creadas.push(respuesta.body.holdId);

    esperarContrato('HoldResponse', respuesta.body);
    expect(Object.keys(respuesta.body)).toEqual([
      'holdId',
      'status',
      'expiresAt',
      'ttlMinutes',
      'lockedPrice',
    ]);
    expect(respuesta.body).toMatchObject({ status: 'HELD', ttlMinutes: 15 });
    expect(respuesta.body.expiresAt).toBe(
      new Date(reloj.ahora().getTime() + 15 * 60_000).toISOString(),
    );
    expect(respuesta.body.lockedPrice).toEqual(precioEsperado(oferta, { adults: 1 }));
    expect(respuesta.headers['cache-control']).toBe('no-store');
    expect(respuesta.headers['idempotent-replayed']).toBeUndefined();

    const despues = await cupo(prisma, segmento, cabina);
    expect(despues.disponibles).toBe(antes.disponibles - 1);
    expect(despues.disponibles + despues.retenidos).toBe(despues.totales);
  });

  it('guarda cabecera, líneas con el precio congelado y la auditoría con el dueño', async () => {
    const id = creadas[0];
    const cabecera = await prisma.db.retencion_cabecera.findUniqueOrThrow({
      where: { id },
      include: { retencion_detalle: true },
    });
    expect(cabecera).toMatchObject({
      id_propietario: cliente.id,
      estado: 'RETENIDA',
      adultos: 1,
      fecha_cierre: null,
    });
    expect(cabecera.retencion_detalle).toHaveLength(1);
    const auditoria = await prisma.db.auditoria.findMany({
      where: { nombre_tabla: 'retencion_cabecera', id_registro: id },
    });
    expect(auditoria.map((a) => [a.operacion, a.id_usuario])).toEqual([['INSERCION', cliente.id]]);
  });

  it('ida y vuelta con varios pasajeros: una línea por itinerario y el cupo de todos los segmentos', async () => {
    const pasajeros = { adults: 2, children: 1, infants: 1 };
    const oferta = await buscarOferta(
      app,
      [
        { origin: 'UIO', destination: 'GYE', departureDate: fechaEn(31) },
        { origin: 'GYE', destination: 'UIO', departureDate: fechaEn(34) },
      ],
      pasajeros,
    );
    const segmentos = oferta.itineraries.flatMap((it) =>
      it.segments.map((s) => ({
        id: s.segmentId,
        cabina: CABINAS[it.pricingOptions[0].cabinClass],
      })),
    );
    const antes = await Promise.all(segmentos.map((s) => cupo(prisma, s.id, s.cabina)));

    const respuesta = await retener(app, cliente.token, cuerpoDe(oferta, pasajeros)).expect(201);
    creadas.push(respuesta.body.holdId);
    esperarContrato('HoldResponse', respuesta.body);
    expect(respuesta.body.lockedPrice).toEqual(precioEsperado(oferta, pasajeros));

    const despues = await Promise.all(segmentos.map((s) => cupo(prisma, s.id, s.cabina)));
    // Los infantes viajan en brazos: 3 asientos por segmento, no 4
    expect(despues.map((c) => c.disponibles)).toEqual(antes.map((c) => c.disponibles - 3));
    const lineas = await prisma.db.retencion_detalle.count({
      where: { retencion_id: respuesta.body.holdId },
    });
    expect(lineas).toBe(2);
  });

  it('una oferta de ida y vuelta exige una selección por cada itinerario (422)', async () => {
    const oferta = await buscarOferta(
      app,
      [
        { origin: 'UIO', destination: 'GYE', departureDate: fechaEn(32) },
        { origin: 'GYE', destination: 'UIO', departureDate: fechaEn(35) },
      ],
      { adults: 1 },
    );
    const cuerpo = cuerpoDe(oferta, { adults: 1 });
    const respuesta = await retener(app, cliente.token, {
      ...cuerpo,
      itinerarySelections: cuerpo.itinerarySelections.slice(0, 1),
    });
    expect(respuesta.status).toBe(422);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.invalidParams).toEqual([
      { name: 'itinerarySelections', reason: expect.stringMatching(/has 2 itineraries/) },
    ]);
  });

  it('GET: HoldStatusResponse con los segundos que quedan según el reloj', async () => {
    const id = creadas[0];
    const respuesta = await con(app, cliente.token)('get', `${HOLD}/${id}`).expect(200);
    esperarContrato('HoldStatusResponse', respuesta.body);
    expect(respuesta.body.status).toBe('HELD');
    const restantes = respuesta.body.remainingSeconds;
    // Exacto contra la hora del reloj de prueba: no depende del tiempo real entre pruebas (el
    // reloj de WSL salta)
    const vence = new Date(respuesta.body.expiresAt).getTime();
    expect(restantes).toBe(Math.floor((vence - reloj.ahora().getTime()) / 1000));
    reloj.adelantar(1);
    const despues = await con(app, cliente.token)('get', `${HOLD}/${id}`).expect(200);
    expect(despues.body.remainingSeconds).toBe(restantes - 60);
  });
});

describe('POST /offers/hold sobre un catálogo propio', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let c: AppCatalogo;
  let k: CadenaBusqueda;
  let duena: { id: string; token: string };
  let otro: { id: string; token: string };
  let tokenAdmin: string;
  const pendientes: string[] = [];

  const ofertaCadena = (pasajeros: Pasajeros = { adults: 1 }) =>
    buscarOferta(
      c.app,
      [{ origin: k.origen, destination: k.destino, departureDate: k.fecha }],
      pasajeros,
    );
  /** Busca en la cadena y retiene la primera opción (201); el hold se libera al terminar la prueba. */
  const retenerCadena = async (pasajeros: Pasajeros, clave = randomUUID(), token = duena.token) => {
    const oferta = await ofertaCadena(pasajeros);
    const respuesta = await retener(c.app, token, cuerpoDe(oferta, pasajeros), clave).expect(201);
    pendientes.push(respuesta.body.holdId);
    return respuesta;
  };
  const cupoCadena = () => cupo(c.prisma, k.salida);

  beforeAll(async () => {
    c = await crearAppCatalogo({ reloj, limites });
    k = await crearCadena(c);
    duena = await tokenDeCliente(c.app);
    otro = await tokenDeCliente(c.app);
    tokenAdmin = (await iniciarSesion(c.app, await crearUsuario(c.app, { administrador: true })))
      .access_token;
  });
  beforeEach(() => {
    reloj.alPresente();
    // Cada prueba busca y retiene varias veces: el límite se prueba aparte
    limites.reiniciar();
  });
  afterEach(async () => {
    // Cada prueba empieza con los 2 cupos libres
    reloj.alPresente();
    while (pendientes.length > 0) {
      const id = pendientes.pop()!;
      const propietario = (
        await c.prisma.db.retencion_cabecera.findUniqueOrThrow({ where: { id } })
      ).id_propietario;
      const token = propietario === otro.id ? otro.token : duena.token;
      const respuesta = await con(c.app, token)('delete', `${HOLD}/${id}`);
      expect([204, 409]).toContain(respuesta.status);
    }
  });
  afterAll(async () => {
    await darDeBajaCadena(c, k);
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  it('sin cupo para todos: 409 OFFER_NO_LONGER_AVAILABLE y no cambia nada (ni guarda la clave)', async () => {
    const oferta = await ofertaCadena({ adults: 1 });
    const clave = randomUUID();
    const respuesta = await retener(c.app, duena.token, cuerpoDe(oferta, { adults: 3 }), clave);
    expect(respuesta.status).toBe(409);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.code).toBe('OFFER_NO_LONGER_AVAILABLE');
    expect(await cupoCadena()).toEqual({ totales: 2, disponibles: 2, retenidos: 0 });
    expect(
      await c.prisma.db.retencion_cabecera.count({ where: { oferta_id: oferta.offerId } }),
    ).toBe(0);
    expect(await c.prisma.db.clave_idempotencia.count({ where: { clave } })).toBe(0);

    // La misma clave sirve después para un cuerpo que sí cabe
    const segunda = await retener(
      c.app,
      duena.token,
      cuerpoDe(oferta, { adults: 2 }),
      clave,
    ).expect(201);
    pendientes.push(segunda.body.holdId);
    expect(await cupoCadena()).toEqual({ totales: 2, disponibles: 0, retenidos: 2 });
  });

  it('los infantes no toman cupo', async () => {
    await retenerCadena({ adults: 2, infants: 2 });
    expect((await cupoCadena()).disponibles).toBe(0);
  });

  it('una oferta que no existe o ya venció: 409 OFFER_NO_LONGER_AVAILABLE', async () => {
    const oferta = await ofertaCadena();
    const inexistente = await retener(c.app, duena.token, {
      ...cuerpoDe(oferta, { adults: 1 }),
      offerId: randomUUID(),
    });
    expect(inexistente.status).toBe(409);
    expect(inexistente.body).toMatchObject({
      code: 'OFFER_NO_LONGER_AVAILABLE',
      detail: expect.stringMatching(/not found or has expired/),
    });

    reloj.adelantar(31);
    const vencida = await retener(c.app, duena.token, cuerpoDe(oferta, { adults: 1 }));
    expect(vencida.status).toBe(409);
    esperarProblemDetails(vencida);
    expect(vencida.body.code).toBe('OFFER_NO_LONGER_AVAILABLE');
    expect((await cupoCadena()).disponibles).toBe(2);
  });

  it('el precio queda congelado: un cambio de tarifa no lo toca, y un hold nuevo toma el nuevo', async () => {
    const retenido = await retenerCadena({ adults: 1 });
    expect(retenido.body.lockedPrice).toEqual({
      currency: 'USD',
      baseFare: '50.10',
      taxes: '10.20',
      total: '60.30',
    });
    await c
      .admin('patch', `${ADMIN}/fares/${k.tarifa}`, {
        prices: [{ passengerType: 'ADULT', baseFare: '70.00', taxes: '14.00' }],
      })
      .expect(200);
    try {
      const consulta = await con(c.app, duena.token)(
        'get',
        `${HOLD}/${retenido.body.holdId}`,
      ).expect(200);
      expect(consulta.body.lockedPrice).toEqual(retenido.body.lockedPrice);
      const nuevo = await retenerCadena({ adults: 1 });
      expect(nuevo.body.lockedPrice.total).toBe('84.00');
    } finally {
      await c
        .admin('patch', `${ADMIN}/fares/${k.tarifa}`, {
          prices: [{ passengerType: 'ADULT', baseFare: '50.10', taxes: '10.20' }],
        })
        .expect(200);
    }
  });

  it('una tarifa dada de baja después de buscar: 409', async () => {
    const oferta = await ofertaCadena();
    await c.admin('delete', `${ADMIN}/fares/${k.tarifa}`).expect(204);
    try {
      const respuesta = await retener(c.app, duena.token, cuerpoDe(oferta, { adults: 1 }));
      expect(respuesta.status).toBe(409);
      expect(respuesta.body.code).toBe('OFFER_NO_LONGER_AVAILABLE');
    } finally {
      await c.admin('post', `${ADMIN}/fares/${k.tarifa}/reactivate`).expect(200);
    }
  });

  describe('idempotencia', () => {
    it('la misma clave con el mismo cuerpo repite la respuesta sin crear otro hold', async () => {
      const oferta = await ofertaCadena();
      const clave = randomUUID();
      const cuerpo = cuerpoDe(oferta, { adults: 1 });
      const primera = await retener(c.app, duena.token, cuerpo, clave).expect(201);
      pendientes.push(primera.body.holdId);
      // Los valores por defecto cuentan como enviados: {adults: 1} y {} son el mismo cuerpo
      const segunda = await retener(
        c.app,
        duena.token,
        { ...cuerpo, passengersBreakdown: {} },
        clave,
      ).expect(201);
      expect(segunda.body).toEqual(primera.body);
      expect(segunda.headers['idempotent-replayed']).toBe('true');
      expect(
        await c.prisma.db.retencion_cabecera.count({ where: { oferta_id: oferta.offerId } }),
      ).toBe(1);
      expect((await cupoCadena()).disponibles).toBe(1);

      // Aunque el hold ya no esté HELD, la clave devuelve la respuesta original
      await con(c.app, duena.token)('delete', `${HOLD}/${primera.body.holdId}`).expect(204);
      const tercera = await retener(c.app, duena.token, cuerpo, clave).expect(201);
      expect(tercera.body).toEqual(primera.body);
      expect((await cupoCadena()).disponibles).toBe(2);
    });

    it('la misma clave con otro cuerpo: 422 y no toca el cupo', async () => {
      const oferta = await ofertaCadena();
      const clave = randomUUID();
      const primera = await retener(
        c.app,
        duena.token,
        cuerpoDe(oferta, { adults: 1 }),
        clave,
      ).expect(201);
      pendientes.push(primera.body.holdId);
      const otraCuerpo = await retener(c.app, duena.token, cuerpoDe(oferta, { adults: 2 }), clave);
      expect(otraCuerpo.status).toBe(422);
      esperarProblemDetails(otraCuerpo);
      expect(otraCuerpo.body.invalidParams).toEqual([
        { name: 'Idempotency-Key', reason: expect.any(String) },
      ]);
      expect((await cupoCadena()).disponibles).toBe(1);
    });

    it('la clave es de cada usuario: otro usuario con la misma clave crea su propio hold', async () => {
      const clave = randomUUID();
      const mia = await retenerCadena({ adults: 1 }, clave);
      const suya = await retenerCadena({ adults: 1 }, clave, otro.token);
      expect(suya.body.holdId).not.toBe(mia.body.holdId);
      expect((await cupoCadena()).disponibles).toBe(0);
    });

    it('dos peticiones simultáneas con la misma clave crean un solo hold', async () => {
      const oferta = await ofertaCadena();
      const clave = randomUUID();
      const cuerpo = cuerpoDe(oferta, { adults: 1 });
      const respuestas = await Promise.all(
        [1, 2, 3].map(() => retener(c.app, duena.token, cuerpo, clave)),
      );
      expect(respuestas.map((r) => r.status)).toEqual([201, 201, 201]);
      const ids = new Set(respuestas.map((r) => r.body.holdId));
      expect(ids.size).toBe(1);
      pendientes.push(...ids);
      expect(
        await c.prisma.db.retencion_cabecera.count({ where: { oferta_id: oferta.offerId } }),
      ).toBe(1);
      expect(await cupoCadena()).toEqual({ totales: 2, disponibles: 1, retenidos: 1 });
    });

    it('una clave vencida (24 horas) vale como nueva', async () => {
      const oferta = await ofertaCadena();
      const clave = randomUUID();
      const primera = await retener(
        c.app,
        duena.token,
        cuerpoDe(oferta, { adults: 1 }),
        clave,
      ).expect(201);
      pendientes.push(primera.body.holdId);
      await c.prisma.db.$executeRaw`
        UPDATE vuelos.clave_idempotencia
           SET fecha_creacion = now() - interval '25 hours', fecha_expiracion = now() - interval '1 hour'
         WHERE clave = ${clave}::uuid`;
      const segunda = await retener(
        c.app,
        duena.token,
        cuerpoDe(await ofertaCadena(), { adults: 1 }),
        clave,
      ).expect(201);
      pendientes.push(segunda.body.holdId);
      expect(segunda.body.holdId).not.toBe(primera.body.holdId);
      expect(await c.prisma.db.clave_idempotencia.count({ where: { clave } })).toBe(1);
    });
  });

  describe('validación', () => {
    let oferta: Oferta;
    let cuerpo: ReturnType<typeof cuerpoDe>;
    beforeAll(async () => {
      oferta = await ofertaCadena();
      cuerpo = cuerpoDe(oferta, { adults: 1 });
    });

    it.each([
      ['sin Idempotency-Key', null, {}, 'Idempotency-Key'],
      ['Idempotency-Key que no es uuid', 'no-es-uuid', {}, 'Idempotency-Key'],
      ['offerId que no es uuid', undefined, { offerId: 'abc' }, 'offerId'],
      ['sin selecciones', undefined, { itinerarySelections: [] }, 'itinerarySelections'],
      [
        'cabina fuera del contrato',
        undefined,
        {
          itinerarySelections: [
            { itineraryId: randomUUID(), cabinClass: 'COACH', fareBrand: 'BUSCA' },
          ],
        },
        'itinerarySelections[0].cabinClass',
      ],
      [
        'fareBrand en minúsculas',
        undefined,
        {
          itinerarySelections: [
            { itineraryId: randomUUID(), cabinClass: 'ECONOMY', fareBrand: 'busca' },
          ],
        },
        'itinerarySelections[0].fareBrand',
      ],
      [
        'más infantes que adultos',
        undefined,
        { passengersBreakdown: { adults: 1, infants: 2 } },
        'passengersBreakdown.infants',
      ],
      [
        'más de 9 pasajeros con asiento',
        undefined,
        { passengersBreakdown: { adults: 5, children: 5 } },
        'passengersBreakdown',
      ],
      [
        'sin passengersBreakdown',
        undefined,
        { passengersBreakdown: undefined },
        'passengersBreakdown',
      ],
      ['un campo de más', undefined, { price: '1.00' }, 'price'],
    ])('%s: 400 VALIDATION_FAILED', async (_caso, clave, cambio, campo) => {
      const respuesta = await retener(
        c.app,
        duena.token,
        { ...cuerpo, ...cambio },
        clave === undefined ? randomUUID() : clave,
      );
      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.invalidParams.map((p: { name: string }) => p.name)).toContain(campo);
      // El valor recibido en la cabecera no se repite en el error
      expect(JSON.stringify(respuesta.body)).not.toContain('no-es-uuid');
    });

    it('un itinerario repetido: 400', async () => {
      const [seleccion] = cuerpo.itinerarySelections;
      const respuesta = await retener(c.app, duena.token, {
        ...cuerpo,
        itinerarySelections: [seleccion, seleccion],
      });
      expect(respuesta.status).toBe(400);
      expect(respuesta.body.invalidParams[0].name).toBe('itinerarySelections[1].itineraryId');
    });

    it('un itinerario que no es de la oferta, o una familia que la aerolínea no tiene: 422', async () => {
      const ajeno = await retener(c.app, duena.token, {
        ...cuerpo,
        itinerarySelections: [{ ...cuerpo.itinerarySelections[0], itineraryId: randomUUID() }],
      });
      expect(ajeno.status).toBe(422);
      esperarProblemDetails(ajeno);
      expect(ajeno.body.invalidParams[0].name).toBe('itinerarySelections[0].itineraryId');

      for (const cambio of [{ fareBrand: 'NOEXISTE' }, { cabinClass: 'FIRST' }]) {
        const respuesta = await retener(c.app, duena.token, {
          ...cuerpo,
          itinerarySelections: [{ ...cuerpo.itinerarySelections[0], ...cambio }],
        });
        expect(respuesta.status).toBe(422);
        expect(respuesta.body.invalidParams[0].name).toBe('itinerarySelections[0].fareBrand');
      }
      expect((await cupoCadena()).disponibles).toBe(2);
    });
  });

  describe('consultar y liberar', () => {
    it('liberar devuelve el cupo; después GET da RELEASED y otro DELETE no cambia nada', async () => {
      const retenido = await retenerCadena({ adults: 2 });
      const id = retenido.body.holdId;
      expect((await cupoCadena()).disponibles).toBe(0);

      const liberado = await con(c.app, duena.token)('delete', `${HOLD}/${id}`).expect(204);
      expect(liberado.text).toBe('');
      expect(await cupoCadena()).toEqual({ totales: 2, disponibles: 2, retenidos: 0 });

      const consulta = await con(c.app, duena.token)('get', `${HOLD}/${id}`).expect(200);
      esperarContrato('HoldStatusResponse', consulta.body);
      expect(consulta.body).toMatchObject({
        status: 'RELEASED',
        remainingSeconds: 0,
        expiresAt: retenido.body.expiresAt,
        lockedPrice: retenido.body.lockedPrice,
      });

      await con(c.app, duena.token)('delete', `${HOLD}/${id}`).expect(204);
      expect((await cupoCadena()).disponibles).toBe(2);
      const cabecera = await c.prisma.db.retencion_cabecera.findUniqueOrThrow({ where: { id } });
      expect(cabecera.estado).toBe('LIBERADA');
      expect(cabecera.fecha_cierre).not.toBeNull();
      const auditoria = await c.prisma.db.auditoria.findMany({
        where: { nombre_tabla: 'retencion_cabecera', id_registro: id },
        orderBy: { id: 'asc' },
      });
      expect(auditoria.map((a) => [a.operacion, a.id_usuario])).toEqual([
        ['INSERCION', duena.id],
        ['ACTUALIZACION', duena.id],
      ]);
    });

    it('el hold de otro usuario no existe para él (404 en GET y DELETE); el administrador lo consulta', async () => {
      const id = (await retenerCadena({ adults: 1 })).body.holdId;
      for (const metodo of ['get', 'delete'] as const) {
        const respuesta = await con(c.app, otro.token)(metodo, `${HOLD}/${id}`);
        expect(respuesta.status).toBe(404);
        esperarProblemDetails(respuesta);
        expect(respuesta.body.detail).toBe(`Hold ${id} was not found`);
      }
      const inexistente = randomUUID();
      const noHay = await con(c.app, otro.token)('get', `${HOLD}/${inexistente}`);
      expect(noHay.body.detail).toBe(`Hold ${inexistente} was not found`);

      const admin = await con(c.app, tokenAdmin)('get', `${HOLD}/${id}`).expect(200);
      expect(admin.body.status).toBe('HELD');
      // Liberar es solo del dueño
      await con(c.app, tokenAdmin)('delete', `${HOLD}/${id}`).expect(404);
      expect(await estadoEnBase(c.prisma, id)).toBe('RETENIDA');
      expect((await cupoCadena()).disponibles).toBe(1);
    });

    it('un holdId que no es uuid: 400', async () => {
      const respuesta = await con(c.app, duena.token)('get', `${HOLD}/no-es-uuid`);
      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
    });
  });

  describe('vencimiento', () => {
    it('perezoso al consultar: GET de un hold vencido da EXPIRED y el cupo vuelve, auditado sin usuario', async () => {
      const id = (await retenerCadena({ adults: 2 })).body.holdId;
      reloj.adelantar(15);
      const consulta = await con(c.app, duena.token)('get', `${HOLD}/${id}`).expect(200);
      esperarContrato('HoldStatusResponse', consulta.body);
      expect(consulta.body).toMatchObject({ status: 'EXPIRED', remainingSeconds: 0 });
      expect(await cupoCadena()).toEqual({ totales: 2, disponibles: 2, retenidos: 0 });
      const auditoria = await c.prisma.db.auditoria.findMany({
        where: { nombre_tabla: 'retencion_cabecera', id_registro: id },
        orderBy: { id: 'asc' },
      });
      expect(auditoria.map((a) => [a.operacion, a.id_usuario])).toEqual([
        ['INSERCION', duena.id],
        ['ACTUALIZACION', null],
      ]);
      // Liberar uno vencido no cambia nada
      await con(c.app, duena.token)('delete', `${HOLD}/${id}`).expect(204);
      expect(await estadoEnBase(c.prisma, id)).toBe('EXPIRADA');
      expect((await cupoCadena()).disponibles).toBe(2);
    });

    it('un segundo antes de vencer sigue HELD', async () => {
      const id = (await retenerCadena({ adults: 1 })).body.holdId;
      reloj.adelantar(15 - 1 / 60);
      const consulta = await con(c.app, duena.token)('get', `${HOLD}/${id}`).expect(200);
      expect(consulta.body).toMatchObject({ status: 'HELD', remainingSeconds: 1 });
    });

    it('perezoso al competir por el cupo: un hold vencido no impide retener', async () => {
      // Quien buscó antes de que se tomara el cupo compite con la misma oferta. (Una búsqueda
      // nueva no lo vería: la búsqueda no vence holds; el proceso periódico lo hace a tiempo)
      const oferta = await ofertaCadena({ adults: 2 });
      const vencido = (await retenerCadena({ adults: 2 })).body.holdId;
      // El reloj de la app sigue dentro de la vigencia de la oferta (30 minutos)
      reloj.adelantar(16);
      const ganador = await retener(c.app, otro.token, cuerpoDe(oferta, { adults: 2 })).expect(201);
      pendientes.push(ganador.body.holdId);
      expect(await estadoEnBase(c.prisma, vencido)).toBe('EXPIRADA');
      expect(await cupoCadena()).toEqual({ totales: 2, disponibles: 0, retenidos: 2 });
    });

    it('DELETE de un hold vencido que nadie cerró lo deja EXPIRED y devuelve el cupo', async () => {
      const id = (await retenerCadena({ adults: 1 })).body.holdId;
      reloj.adelantar(20);
      await con(c.app, duena.token)('delete', `${HOLD}/${id}`).expect(204);
      expect(await estadoEnBase(c.prisma, id)).toBe('EXPIRADA');
      expect((await cupoCadena()).disponibles).toBe(2);
    });

    it('el proceso periódico vence los holds y devuelve el cupo una sola vez, aunque corra dos veces a la vez', async () => {
      const ids = [
        (await retenerCadena({ adults: 1 })).body.holdId,
        (await retenerCadena({ adults: 1 })).body.holdId,
      ];
      expect((await cupoCadena()).disponibles).toBe(0);
      const proceso = c.app.get(VencimientoRetenciones);

      // Antes de la hora no vence nada de esta cadena
      await proceso.ejecutar();
      expect((await cupoCadena()).disponibles).toBe(0);

      reloj.adelantar(16);
      const [una, otra] = await Promise.all([proceso.ejecutar(), proceso.ejecutar()]);
      expect(una).toBe(otra);
      expect(una.retenciones).toBeGreaterThanOrEqual(2);
      for (const id of ids) expect(await estadoEnBase(c.prisma, id)).toBe('EXPIRADA');
      expect(await cupoCadena()).toEqual({ totales: 2, disponibles: 2, retenidos: 0 });

      // Otra corrida no devuelve nada más
      await proceso.ejecutar();
      expect((await cupoCadena()).disponibles).toBe(2);
    });

    it('el proceso borra las claves de idempotencia vencidas', async () => {
      const clave = randomUUID();
      await retenerCadena({ adults: 1 }, clave);
      reloj.adelantar(24 * 60 + 1);
      const resultado = await c.app.get(VencimientoRetenciones).ejecutar();
      expect(resultado.claves).toBeGreaterThanOrEqual(1);
      expect(await c.prisma.db.clave_idempotencia.count({ where: { clave } })).toBe(0);
    });
  });

  it('consumir (para la fase 7): pasa a CONSUMED sin devolver el cupo, y ya no se libera', async () => {
    const servicio = c.app.get(RetencionService);
    const id = (await retenerCadena({ adults: 1 })).body.holdId;
    const consumir = (propietario: string) =>
      c.prisma.transaccionAuditada((tx) => servicio.consumir(id, propietario, tx));

    expect(await consumir(otro.id)).toBe('no-existe');
    expect(await consumir(duena.id)).toBe('consumida');
    expect(await consumir(duena.id)).toBe('ya-consumida');
    const consulta = await con(c.app, duena.token)('get', `${HOLD}/${id}`).expect(200);
    expect(consulta.body).toMatchObject({ status: 'CONSUMED', remainingSeconds: 0 });
    expect(await cupoCadena()).toEqual({ totales: 2, disponibles: 1, retenidos: 1 });

    const liberar = await con(c.app, duena.token)('delete', `${HOLD}/${id}`);
    expect(liberar.status).toBe(409);
    esperarProblemDetails(liberar);
    expect((await cupoCadena()).disponibles).toBe(1);

    // Uno vencido no se consume
    const vencido = (await retenerCadena({ adults: 1 })).body.holdId;
    reloj.adelantar(15);
    expect(
      await c.prisma.transaccionAuditada((tx) => servicio.consumir(vencido, duena.id, tx)),
    ).toBe('vencida');
    expect(await estadoEnBase(c.prisma, vencido)).toBe('RETENIDA');

    // El cupo consumido es de la reserva: queda tomado (la cadena se da de baja igual)
    pendientes.splice(pendientes.indexOf(id), 1);
  });
});

describe('Concurrencia sobre los últimos cupos', () => {
  const N = 5;
  let c: AppCatalogo;
  let k: CadenaBusqueda;
  let clientes: Array<{ id: string; token: string }>;
  const limites = new LimitesReiniciables();

  beforeAll(async () => {
    c = await crearAppCatalogo({ limites });
    k = await crearCadena(c);
    await c
      .admin('patch', `${ADMIN}/departures/${k.salida}`, {
        cabins: [{ cabinClass: 'ECONOMY', totalSeats: N }],
      })
      .expect(200);
    clientes = await Promise.all(Array.from({ length: 4 }, () => tokenDeCliente(c.app)));
  });
  beforeEach(() => limites.reiniciar());
  afterAll(async () => {
    await darDeBajaCadena(c, k);
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  it(`20 holds simultáneos con claves distintas por ${N} cupos: exactamente ${N} ganan y el cupo nunca baja de 0`, async () => {
    const oferta = await buscarOferta(
      c.app,
      [{ origin: k.origen, destination: k.destino, departureDate: k.fecha }],
      { adults: 1 },
    );
    const cuerpo = cuerpoDe(oferta, { adults: 1 });
    const respuestas = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        retener(c.app, clientes[i % clientes.length].token, cuerpo),
      ),
    );
    const ganadoras = respuestas.filter((r) => r.status === 201);
    const perdedoras = respuestas.filter((r) => r.status !== 201);
    expect(ganadoras).toHaveLength(N);
    expect(perdedoras.map((r) => [r.status, r.body.code])).toEqual(
      Array.from({ length: 20 - N }, () => [409, 'OFFER_NO_LONGER_AVAILABLE']),
    );
    expect(await cupo(c.prisma, k.salida)).toEqual({ totales: N, disponibles: 0, retenidos: N });

    // Liberarlas todas a la vez devuelve exactamente N
    await Promise.all(
      ganadoras.map((r) => {
        const dueno = clientes[respuestas.indexOf(r) % clientes.length];
        return con(c.app, dueno.token)('delete', `${HOLD}/${r.body.holdId}`).expect(204);
      }),
    );
    expect(await cupo(c.prisma, k.salida)).toEqual({ totales: N, disponibles: N, retenidos: 0 });
  });

  it('holds de varios pasajeros compitiendo: nunca se reparte más de lo que hay', async () => {
    const oferta = await buscarOferta(
      c.app,
      [{ origin: k.origen, destination: k.destino, departureDate: k.fecha }],
      { adults: 2 },
    );
    const cuerpo = cuerpoDe(oferta, { adults: 2 });
    const respuestas = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        retener(c.app, clientes[i % clientes.length].token, cuerpo),
      ),
    );
    // 5 cupos y 2 por hold: ganan 2 y sobra 1
    expect(respuestas.filter((r) => r.status === 201)).toHaveLength(2);
    expect(await cupo(c.prisma, k.salida)).toEqual({ totales: N, disponibles: 1, retenidos: 4 });
    for (const [i, r] of respuestas.entries()) {
      if (r.status === 201) {
        await con(c.app, clientes[i % clientes.length].token)(
          'delete',
          `${HOLD}/${r.body.holdId}`,
        ).expect(204);
      }
    }
    expect((await cupo(c.prisma, k.salida)).disponibles).toBe(N);
  });
});

describe('Seguridad de /offers/hold', () => {
  let app: INestApplication;
  let cliente: { id: string; token: string };
  const cuerpo = {
    offerId: randomUUID(),
    itinerarySelections: [{ itineraryId: randomUUID(), cabinClass: 'ECONOMY', fareBrand: 'BASIC' }],
    passengersBreakdown: { adults: 1 },
  };

  beforeAll(async () => {
    app = await crearApp();
    cliente = await tokenDeCliente(app);
  });
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  it('sin token: 401 en las tres operaciones', async () => {
    const id = randomUUID();
    for (const [metodo, ruta] of [
      ['post', HOLD],
      ['get', `${HOLD}/${id}`],
      ['delete', `${HOLD}/${id}`],
    ] as const) {
      const respuesta = await con(app)(metodo, ruta)
        .set('Idempotency-Key', randomUUID())
        .send(cuerpo);
      expect(respuesta.status).toBe(401);
      esperarProblemDetails(respuesta);
    }
  });

  it('sin el scope: 403 (flights:hold para crear y liberar, flights:read para consultar)', async () => {
    const id = randomUUID();
    const soloLectura = firmarToken(
      app,
      { scope: 'flights:read' },
      { subject: cliente.id, expiresIn: 60 },
    );
    const sinLectura = firmarToken(
      app,
      { scope: 'flights:hold' },
      { subject: cliente.id, expiresIn: 60 },
    );
    const crear = await retener(app, soloLectura, cuerpo);
    expect(crear.status).toBe(403);
    esperarProblemDetails(crear);
    expect(crear.body.detail).toMatch(/flights:hold/);
    expect((await con(app, soloLectura)('delete', `${HOLD}/${id}`)).status).toBe(403);
    const consultar = await con(app, sinLectura)('get', `${HOLD}/${id}`);
    expect(consultar.status).toBe(403);
    expect(consultar.body.detail).toMatch(/flights:read/);
  });
});

describe('Límite de POST /offers/hold', () => {
  let app: INestApplication;
  let cliente: { id: string; token: string };
  const cuerpo = {
    offerId: randomUUID(),
    itinerarySelections: [{ itineraryId: randomUUID(), cabinClass: 'ECONOMY', fareBrand: 'BASIC' }],
    passengersBreakdown: { adults: 1 },
  };

  beforeAll(async () => {
    app = await crearApp([], { reloj: new RelojDePrueba() });
    cliente = await tokenDeCliente(app);
  });
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  it('30 holds por minuto e IP; el siguiente es 429 con Retry-After', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await retener(app, cliente.token, cuerpo)).status).toBe(409);
    }
    const excedida = await retener(app, cliente.token, cuerpo);
    expect(excedida.status).toBe(429);
    esperarProblemDetails(excedida);
    expect(excedida.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(excedida.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // GET no gasta ese contador
    expect((await con(app, cliente.token)('get', `${HOLD}/${randomUUID()}`)).status).toBe(404);
  });
});
