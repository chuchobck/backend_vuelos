import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { desactivarUsuariosDePrueba } from './utils/auth';
import { fechaEn } from './utils/busqueda';
import { ADMIN, AppCatalogo, crearAppCatalogo } from './utils/catalogo';
import { erroresContraContrato } from './utils/contrato';
import { LimitesReiniciables } from './utils/limites';
import { estadoEnBase } from './utils/postventa';
import { esperarProblemDetails } from './utils/problem-details';
import {
  buscarYRetener,
  con,
  cuerpoReserva,
  cupoDe,
  nuevoCliente,
  pasajero,
  reservar,
  RESERVAS,
} from './utils/reserva';

const RESERVAS_ADMIN = `${ADMIN}/bookings`;

type Cliente = { id: string; token: string };
type Cuerpo = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- se valida con Ajv

interface Reservada {
  id: string;
  pnr: string;
  salida: string;
  vuelo: string;
}

/** Una reserva confirmada de UIO-GYE de la semilla, a nombre del cliente. */
async function reservarDe(
  app: INestApplication,
  cliente: Cliente,
  dias: number,
  fareBrand = 'CLASSIC',
): Promise<Reservada> {
  const retenido = await buscarYRetener(
    app,
    cliente.token,
    [['UIO', 'GYE', fechaEn(dias)]],
    { adults: 1 },
    { directa: true, fareBrand },
  );
  const r = await reservar(
    app,
    cliente.token,
    cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]),
  );
  expect([201, 202]).toContain(r.status);
  const segmento = r.body.itineraries[0].segments[0];
  return {
    id: r.body.bookingId,
    pnr: r.body.pnr,
    salida: segmento.segmentId,
    vuelo: segmento.flightNumber,
  };
}

describe('/admin/bookings', () => {
  const limites = new LimitesReiniciables();
  let c: AppCatalogo;
  let ana: Cliente;
  let beto: Cliente;
  let correoAna: string;
  let correoBeto: string;
  let deAna: Reservada[];
  let deBeto: Reservada;

  const cancelar = (id: string, cuerpo: object = {}, clave: string | null = randomUUID()) => {
    const prueba = c.admin('post', `${RESERVAS_ADMIN}/${id}/cancel`, cuerpo);
    return clave === null ? prueba : prueba.set('Idempotency-Key', clave);
  };

  beforeAll(async () => {
    c = await crearAppCatalogo({ limites });
    ana = await nuevoCliente(c.app);
    beto = await nuevoCliente(c.app);
    const correo = async (cliente: Cliente) =>
      (await con(c.app, cliente.token)('get', `${ADMIN.replace('/admin', '')}/auth/me`).expect(200))
        .body.email as string;
    correoAna = await correo(ana);
    correoBeto = await correo(beto);
    deAna = [await reservarDe(c.app, ana, 67), await reservarDe(c.app, ana, 68)];
    deBeto = await reservarDe(c.app, beto, 67, 'BASIC');
  });

  afterAll(async () => {
    for (const reserva of [...deAna, deBeto]) {
      // Lo que las pruebas no cancelaron se cancela con el flujo normal: el cupo vuelve
      const dueno = reserva === deBeto ? beto : ana;
      const detalle = await con(c.app, dueno.token)('get', `${RESERVAS}/${reserva.id}`);
      if (detalle.body.status === 'CONFIRMED') {
        limites.reiniciar();
        await cancelar(reserva.id).catch(() => undefined);
      }
    }
    await c.prisma.transaccionAuditada((tx) =>
      tx.webhook_cabecera.updateMany({
        where: { id_propietario: { in: [ana.id, beto.id] }, activo: true },
        data: { activo: false },
      }),
    );
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  beforeEach(() => limites.reiniciar());

  describe('autorización', () => {
    const rutas: Array<['get' | 'post', string]> = [
      ['get', RESERVAS_ADMIN],
      ['get', `${RESERVAS_ADMIN}/${randomUUID()}`],
      ['post', `${RESERVAS_ADMIN}/${randomUUID()}/cancel`],
    ];
    it.each(rutas)('401 sin token: %s %s', async (metodo, ruta) => {
      const r = await c.anonimo(metodo, ruta, metodo === 'post' ? {} : undefined).expect(401);
      esperarProblemDetails({ status: 401, type: r.type, body: r.body });
    });
    it.each(rutas)(
      '403 con el token de un cliente, aunque sea el dueño: %s %s',
      async (metodo, ruta) => {
        const r = await con(c.app, ana.token)(metodo, ruta)
          .set('Idempotency-Key', randomUUID())
          .send({});
        expect(r.status).toBe(403);
        esperarProblemDetails({ status: 403, type: r.type, body: r.body });
      },
    );
  });

  describe('GET (lista)', () => {
    it('trae las reservas de todos los clientes con su dueño, y el cliente sigue viendo solo las suyas', async () => {
      const r = await c.admin('get', `${RESERVAS_ADMIN}?pnr=${deBeto.pnr}`).expect(200);
      expect(r.body.items).toHaveLength(1);
      expect(r.body.items[0]).toMatchObject({
        bookingId: deBeto.id,
        pnr: deBeto.pnr,
        status: 'CONFIRMED',
        origin: 'UIO',
        destination: 'GYE',
        owner: { id: beto.id, email: correoBeto },
      });
      expect(Object.keys(r.body.items[0]).sort()).toEqual(
        [
          'bookingId',
          'departureDate',
          'destination',
          'grandTotal',
          'origin',
          'owner',
          'pnr',
          'status',
        ].sort(),
      );
      expect(
        erroresContraContrato('BookingListResponse', {
          items: r.body.items.map(({ owner: _o, ...resumen }: Cuerpo) => resumen),
        }),
      ).toEqual([]);

      const todas = await c.admin('get', `${RESERVAS_ADMIN}?limit=50`).expect(200);
      const duenos = new Set((todas.body.items as Cuerpo[]).map((i) => i.owner.id));
      expect(duenos.has(ana.id) && duenos.has(beto.id)).toBe(true);

      // El listado del cliente no cambió: solo las suyas, sin `owner`
      const suyas = await con(c.app, beto.token)('get', `${RESERVAS}?limit=50`).expect(200);
      expect((suyas.body.items as Cuerpo[]).map((i) => i.bookingId)).toEqual([deBeto.id]);
      expect(suyas.body.items[0].owner).toBeUndefined();
    });

    it('ownerEmail: solo las del cliente (correo exacto, en cualquier mayúscula)', async () => {
      for (const email of [correoAna, correoAna.toUpperCase()]) {
        const r = await c
          .admin('get', `${RESERVAS_ADMIN}?ownerEmail=${encodeURIComponent(email)}`)
          .expect(200);
        expect((r.body.items as Cuerpo[]).map((i) => i.bookingId).sort()).toEqual(
          deAna.map((x) => x.id).sort(),
        );
      }
      const nadie = await c
        .admin('get', `${RESERVAS_ADMIN}?ownerEmail=nadie-${randomUUID()}@example.com`)
        .expect(200);
      expect(nadie.body).toEqual({ items: [] });
    });

    it('pnr, status y fechas de creación (días UTC incluidos)', async () => {
      const [primera] = deAna;
      const porPnr = await c
        .admin('get', `${RESERVAS_ADMIN}?pnr=${primera.pnr.toLowerCase()}`)
        .expect(200);
      expect((porPnr.body.items as Cuerpo[]).map((i) => i.bookingId)).toEqual([primera.id]);

      const hoy = new Date().toISOString().slice(0, 10);
      const filtros = `ownerEmail=${encodeURIComponent(correoAna)}`;
      const confirmadas = await c
        .admin('get', `${RESERVAS_ADMIN}?${filtros}&status=CONFIRMED`)
        .expect(200);
      expect(confirmadas.body.items).toHaveLength(2);
      const canceladas = await c
        .admin('get', `${RESERVAS_ADMIN}?${filtros}&status=CANCELLED`)
        .expect(200);
      expect(canceladas.body.items).toEqual([]);
      const dia = await c
        .admin('get', `${RESERVAS_ADMIN}?${filtros}&createdFrom=${hoy}&createdTo=${hoy}`)
        .expect(200);
      expect(dia.body.items).toHaveLength(2);
      const futuro = await c
        .admin('get', `${RESERVAS_ADMIN}?${filtros}&createdFrom=2999-01-01`)
        .expect(200);
      expect(futuro.body.items).toEqual([]);
    });

    it('flightNumber: las reservas que vuelan ese vuelo (y solo esas)', async () => {
      const r = await c
        .admin('get', `${RESERVAS_ADMIN}?flightNumber=${deBeto.vuelo}&limit=50`)
        .expect(200);
      const ids = (r.body.items as Cuerpo[]).map((i) => i.bookingId);
      expect(ids).toContain(deBeto.id);
      const sinVuelo = await c.admin('get', `${RESERVAS_ADMIN}?flightNumber=ZZ9999`).expect(200);
      expect(sinVuelo.body).toEqual({ items: [] });
      // Combinado con otro dueño no hay coincidencia
      const cruce = await c
        .admin(
          'get',
          `${RESERVAS_ADMIN}?flightNumber=ZZ9999&ownerEmail=${encodeURIComponent(correoBeto)}`,
        )
        .expect(200);
      expect(cruce.body.items).toEqual([]);
    });

    it('pagina por cursor sin repetir ni saltar y del más reciente al más viejo', async () => {
      const filtro = `ownerEmail=${encodeURIComponent(correoAna)}`;
      const completa = (await c.admin('get', `${RESERVAS_ADMIN}?${filtro}&limit=50`).expect(200))
        .body.items as Cuerpo[];
      expect(completa).toHaveLength(2);
      const primera = await c.admin('get', `${RESERVAS_ADMIN}?${filtro}&limit=1`).expect(200);
      expect(primera.body.items).toHaveLength(1);
      expect(primera.body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      const segunda = await c
        .admin('get', `${RESERVAS_ADMIN}?${filtro}&limit=1&cursor=${primera.body.nextCursor}`)
        .expect(200);
      expect(segunda.body.items).toHaveLength(1);
      expect(segunda.body.nextCursor).toBeUndefined();
      expect([primera.body.items[0].bookingId, segunda.body.items[0].bookingId]).toEqual(
        completa.map((i) => i.bookingId),
      );
    });

    it.each([
      ['pnr inválido', 'pnr=abc'],
      ['status inválido', 'status=VIEJA'],
      ['createdFrom que no es fecha', 'createdFrom=ayer'],
      ['createdTo antes de createdFrom', 'createdFrom=2026-05-02&createdTo=2026-05-01'],
      ['ownerEmail que no es un correo', 'ownerEmail=no-es-correo'],
      ['flightNumber inválido', 'flightNumber=vuelo'],
      ['limit sobre el máximo', 'limit=51'],
      ['cursor inventado', 'cursor=nada'],
      ['parámetro desconocido', 'foo=bar'],
    ])('400 ProblemDetails: %s', async (_nombre, consulta) => {
      const r = await c.admin('get', `${RESERVAS_ADMIN}?${consulta}`).expect(400);
      esperarProblemDetails({ status: 400, type: r.type, body: r.body });
    });
  });

  describe('GET /{bookingId} (detalle)', () => {
    it('es el detalle del cliente, de cualquier dueño, más owner', async () => {
      const [primera] = deAna;
      const admin = await c.admin('get', `${RESERVAS_ADMIN}/${primera.id}`).expect(200);
      const { owner, ...detalle } = admin.body as Cuerpo;
      expect(owner).toEqual({ id: ana.id, email: correoAna });
      const delCliente = await con(c.app, ana.token)('get', `${RESERVAS}/${primera.id}`).expect(
        200,
      );
      expect(detalle).toEqual(delCliente.body);
      expect(erroresContraContrato('BookingDetail', detalle)).toEqual([]);
      expect(detalle.passengers).toHaveLength(1);
      expect(detalle.tickets.length).toBeGreaterThanOrEqual(1);
      // El cliente ajeno no la ve, el administrador sí
      await con(c.app, beto.token)('get', `${RESERVAS}/${primera.id}`).expect(404);
    });

    it('404 si no existe y 400 si no es un uuid', async () => {
      const r = await c.admin('get', `${RESERVAS_ADMIN}/${randomUUID()}`).expect(404);
      esperarProblemDetails({ status: 404, type: r.type, body: r.body });
      const mal = await c.admin('get', `${RESERVAS_ADMIN}/no-es-uuid`).expect(400);
      esperarProblemDetails({ status: 400, type: mal.type, body: mal.body });
    });
  });

  describe('POST /{bookingId}/cancel', () => {
    it('400 sin Idempotency-Key o con una que no es uuid; 404 si no existe; 400 con campos de más', async () => {
      const [primera] = deAna;
      for (const clave of [null, 'no-es-uuid']) {
        const r = await cancelar(primera.id, {}, clave);
        expect(r.status).toBe(400);
        esperarProblemDetails({ status: 400, type: r.type, body: r.body });
      }
      const extra = await cancelar(primera.id, { quoteId: randomUUID() });
      expect(extra.status).toBe(400);
      const sinReserva = await cancelar(randomUUID());
      expect(sinReserva.status).toBe(404);
      esperarProblemDetails({ status: 404, type: sinReserva.type, body: sinReserva.body });
      expect((await estadoEnBase(c.prisma, primera.id)).estado).toBe('CONFIRMADA');
    });

    describe('cancelación administrativa', () => {
      const clave = randomUUID();
      let reserva: Reservada;
      let antes: Awaited<ReturnType<typeof cupoDe>>;
      let respuesta: Cuerpo;
      let webhookDeAna: string;

      beforeAll(async () => {
        limites.reiniciar();
        reserva = deAna[1];
        // Una suscripción de Ana a booking.cancelled, puesta directo en la base (sin SSRF ni red):
        // sus webhooks deben enterarse igual que con una cancelación hecha por ella.
        const tipo = await c.prisma.db.tipo_evento.findUniqueOrThrow({
          where: { codigo: 'booking.cancelled' },
        });
        webhookDeAna = (
          await c.prisma.transaccionAuditada((tx) =>
            tx.webhook_cabecera.create({
              data: {
                id_propietario: ana.id,
                url: `https://hooks.example.test/e2e-${randomUUID()}`,
                secreto: 'secreto-ficticio-que-no-se-usa',
                webhook_detalle: { create: { tipo_evento_id: tipo.id } },
              },
            }),
          )
        ).id;
        antes = await cupoDe(c.prisma, reserva.salida);
        const r = await cancelar(reserva.id, { reason: 'Vuelo cancelado por la aerolínea' }, clave);
        expect(r.status).toBe(200);
        respuesta = r.body;
      });

      it('200 con la reserva CANCELLED, boletos reembolsados y el historial', () => {
        expect(respuesta.status).toBe('CANCELLED');
        expect(respuesta.owner).toEqual({ id: ana.id, email: correoAna });
        const { owner: _owner, ...detalle } = respuesta;
        expect(erroresContraContrato('BookingDetail', detalle)).toEqual([]);
        expect(respuesta.tickets.map((t: { status: string }) => t.status)).toEqual(['REFUNDED']);
        expect(respuesta.passengers[0].assignedSeats).toEqual([]);
        expect(
          respuesta.changes.slice(-2).map((x: { description: string }) => x.description),
        ).toEqual([
          expect.stringMatching(/^Cancellation accepted; refund of/),
          expect.stringMatching(/^Booking cancelled; .* refunded$/),
        ]);
      });

      it('libera asientos y cupo una sola vez, igual que la cancelación del cliente', async () => {
        expect((await cupoDe(c.prisma, reserva.salida)).disponibles).toBe(antes.disponibles + 1);
        expect(await estadoEnBase(c.prisma, reserva.id)).toMatchObject({
          estado: 'CANCELADA',
          asientos: 0,
          boletos: 'REEMBOLSADO',
        });
      });

      it('el dueño la ve CANCELLED y la lista filtra por status', async () => {
        const delCliente = await con(c.app, ana.token)('get', `${RESERVAS}/${reserva.id}`).expect(
          200,
        );
        expect(delCliente.body.status).toBe('CANCELLED');
        const lista = await c
          .admin(
            'get',
            `${RESERVAS_ADMIN}?status=CANCELLED&ownerEmail=${encodeURIComponent(correoAna)}`,
          )
          .expect(200);
        expect((lista.body.items as Cuerpo[]).map((i) => i.bookingId)).toEqual([reserva.id]);
      });

      it('deja rastro en la auditoría a nombre del administrador y encola los eventos del dueño', async () => {
        const eventos = await c.prisma.db.auditoria.findMany({
          where: {
            nombre_tabla: 'reserva_cabecera',
            id_registro: reserva.id,
            operacion: 'ACTUALIZACION',
          },
          orderBy: { id: 'asc' },
        });
        // Los cambios de estado de la cancelación; los anteriores (la compra) son del cliente
        const deLaCancelacion = eventos.filter((e) =>
          ['CANCELACION_PENDIENTE', 'CANCELADA'].includes(
            (e.datos_nuevos as { estado?: string }).estado ?? '',
          ),
        );
        expect(deLaCancelacion.map((e) => (e.datos_nuevos as { estado: string }).estado)).toEqual([
          'CANCELACION_PENDIENTE',
          'CANCELADA',
        ]);
        expect(new Set(deLaCancelacion.map((e) => e.id_usuario))).toEqual(new Set([c.idAdmin]));
        // El mismo evento que una cancelación normal: los webhooks del dueño lo reciben
        const entregas = await c.prisma.db.webhook_entrega.findMany({
          where: { webhook_id: webhookDeAna },
          include: { tipo_evento: { select: { codigo: true } } },
        });
        expect(entregas.map((e) => e.tipo_evento.codigo)).toEqual(['booking.cancelled']);
        expect(entregas[0].payload).toMatchObject({
          eventType: 'booking.cancelled',
          data: { bookingId: reserva.id, status: 'CANCELLED' },
        });
      });

      it('la misma clave repite el resultado (Idempotent-Replayed); otra clave es 409 ALREADY_CANCELLED', async () => {
        const repetida = await cancelar(
          reserva.id,
          { reason: 'Vuelo cancelado por la aerolínea' },
          clave,
        );
        expect(repetida.status).toBe(200);
        expect(repetida.headers['idempotent-replayed']).toBe('true');
        expect(repetida.body.status).toBe('CANCELLED');

        const otraClave = await cancelar(reserva.id, {});
        expect(otraClave.status).toBe(409);
        esperarProblemDetails({ status: 409, type: otraClave.type, body: otraClave.body });
        expect(otraClave.body.code).toBe('ALREADY_CANCELLED');

        // La misma clave con otro cuerpo no es un reintento: 422
        const otroCuerpo = await cancelar(reserva.id, { reason: 'Otro motivo' }, clave);
        expect(otroCuerpo.status).toBe(422);
        expect((await cupoDe(c.prisma, reserva.salida)).disponibles).toBe(antes.disponibles + 1);
      });
    });

    it('BASIC no reembolsa: igual se cancela (200) y los boletos quedan VOIDED', async () => {
      const r = await cancelar(deBeto.id, {});
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('CANCELLED');
      expect(r.body.owner.id).toBe(beto.id);
      expect(r.body.tickets.map((t: { status: string }) => t.status)).toEqual(['VOIDED']);
    });

    it('dos cancelaciones simultáneas con claves distintas cancelan una sola vez', async () => {
      const nueva = await reservarDe(c.app, ana, 69);
      const antes = await cupoDe(c.prisma, nueva.salida);
      const respuestas = await Promise.all([1, 2, 3].map(() => cancelar(nueva.id, {})));
      expect(respuestas.filter((r) => r.status === 200)).toHaveLength(1);
      for (const r of respuestas.filter((x) => x.status !== 200)) expect(r.status).toBe(409);
      expect((await cupoDe(c.prisma, nueva.salida)).disponibles).toBe(antes.disponibles + 1);
    });
  });
});
