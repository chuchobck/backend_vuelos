import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { desactivarUsuariosDePrueba, firmarToken } from './utils/auth';
import { erroresContraContrato } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { con, nuevoCliente } from './utils/reserva';

const WEBHOOKS = '/flights/v1/webhooks';
const SECRETO = 'un-secreto-compartido-largo';

/** localhost resuelve a loopback: fuera de producción es un destino permitido. */
const urlNueva = () => `http://localhost:9/hooks/${randomUUID()}`;

type Cliente = { id: string; token: string };

describe('/webhooks: registrar, listar y dar de baja', () => {
  const limites = new LimitesReiniciables();
  let app: INestApplication;
  let prisma: PrismaService;
  let cliente: Cliente;
  let otro: Cliente;

  const registrar = (token: string, cuerpo: object) =>
    con(app, token)('post', WEBHOOKS).send(cuerpo);
  const cuerpo = (cambios: object = {}) => ({
    url: urlNueva(),
    events: ['booking.confirmed', 'hold.expired'],
    secret: SECRETO,
    ...cambios,
  });

  beforeAll(async () => {
    app = await crearApp([], { limites });
    prisma = app.get(PrismaService);
    cliente = await nuevoCliente(app);
    otro = await nuevoCliente(app);
  });
  beforeEach(() => limites.reiniciar());
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  describe('POST /webhooks', () => {
    it('201 con la suscripción (cumple WebhookSubscription) y el secreto enmascarado', async () => {
      const solicitud = cuerpo({ events: ['hold.expired', 'booking.confirmed'] });
      const respuesta = await registrar(cliente.token, solicitud).expect(201);
      expect(erroresContraContrato('WebhookSubscription', respuesta.body)).toEqual([]);
      expect(respuesta.body).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        url: solicitud.url,
        // en el orden del contrato
        events: ['booking.confirmed', 'hold.expired'],
        secret: '****argo',
      });
      expect(respuesta.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(respuesta.body)).not.toContain(SECRETO);
    });

    it('guarda el secreto cifrado: ni en claro en la tabla ni en la auditoría', async () => {
      const { body } = await registrar(cliente.token, cuerpo()).expect(201);
      const fila = await prisma.db.webhook_cabecera.findUniqueOrThrow({ where: { id: body.id } });
      expect(fila.secreto).toMatch(/^v1\./);
      expect(fila.secreto).not.toContain(SECRETO);
      const auditoria = await prisma.db.auditoria.findMany({
        where: { nombre_tabla: 'webhook_cabecera', id_registro: body.id },
      });
      expect(auditoria).toHaveLength(1);
      expect(auditoria[0]).toMatchObject({ operacion: 'INSERCION', id_usuario: cliente.id });
      const texto = JSON.stringify(auditoria[0].datos_nuevos);
      expect(texto).not.toContain(SECRETO);
      expect(texto).not.toContain(fila.secreto);
    });

    it('GET devuelve el secreto enmascarado (se descifra para mostrar sus 4 últimos)', async () => {
      const { body } = await registrar(cliente.token, cuerpo({ secret: 'otro-secreto-1234567' }));
      const lista = await con(app, cliente.token)('get', WEBHOOKS).expect(200);
      expect(lista.body.find((w: { id: string }) => w.id === body.id).secret).toBe('****4567');
    });

    it.each([
      ['url que no es URL', { url: 'no es una url' }, 'url'],
      ['url con otro protocolo', { url: 'ftp://localhost/hook' }, 'url'],
      ['url con credenciales', { url: 'http://usuario:clave@localhost:9/hook' }, 'url'],
      ['events vacío', { events: [] }, 'events'],
      ['events con un valor que no existe', { events: ['booking.exploded'] }, 'events'],
      ['events con duplicados', { events: ['booking.confirmed', 'booking.confirmed'] }, 'events'],
      ['events que no es lista', { events: 'booking.confirmed' }, 'events'],
      ['secret de 15 caracteres', { secret: 'a'.repeat(15) }, 'secret'],
      ['secret con espacios', { secret: 'un secreto con espacios' }, 'secret'],
      ['secret que no es texto', { secret: 1234567890123456 }, 'secret'],
    ])('400 con %s, y el error nombra el campo', async (_nombre, cambios, campo) => {
      const respuesta = await registrar(cliente.token, cuerpo(cambios)).expect(400);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.invalidParams.map((p: { name: string }) => p.name)).toContain(campo);
    });

    it('400 si falta algún campo', async () => {
      for (const campo of ['url', 'events', 'secret']) {
        const { [campo]: _quitado, ...resto } = cuerpo() as Record<string, unknown>;
        await registrar(cliente.token, resto).expect(400);
      }
    });

    it('el error de validación no repite el secreto ni la URL', async () => {
      const url = 'http://localhost:9/hook?token=supersecretotoken';
      const respuesta = await registrar(cliente.token, cuerpo({ url, events: [] })).expect(400);
      expect(JSON.stringify(respuesta.body)).not.toContain('supersecretotoken');
      const corto = await registrar(cliente.token, cuerpo({ secret: 'corto-pero-unico' })).expect(
        201,
      );
      expect(corto.status).toBe(201);
      const malo = await registrar(cliente.token, cuerpo({ secret: 'abcdef-secreto-' })).expect(
        400,
      );
      expect(JSON.stringify(malo.body)).not.toContain('abcdef-secreto-');
    });

    describe('SSRF: destinos que no se aceptan', () => {
      it.each([
        ['metadata de la nube', 'http://169.254.169.254/latest/meta-data'],
        ['red privada 10/8', 'http://10.0.0.5/hook'],
        ['red privada 172.16/12', 'http://172.16.0.1/hook'],
        ['red privada 192.168/16', 'http://192.168.1.10/hook'],
        ['link-local IPv6', 'http://[fe80::1]/hook'],
        ['IPv6 única local', 'http://[fd00::1]/hook'],
        ['IPv4 dentro de IPv6', 'http://[::ffff:10.0.0.1]/hook'],
        ['esta red', 'http://0.0.0.0/hook'],
        ['operador compartido', 'http://100.64.0.1/hook'],
      ])('400: %s', async (_nombre, url) => {
        const respuesta = await registrar(cliente.token, cuerpo({ url })).expect(400);
        esperarProblemDetails(respuesta);
        expect(respuesta.body.invalidParams[0].name).toBe('url');
        // el detalle no repite la URL
        expect(JSON.stringify(respuesta.body)).not.toContain('169.254');
      });

      it('400 si el nombre no se resuelve', async () => {
        const url = `https://no-existe-${randomUUID()}.invalid/hook`;
        await registrar(cliente.token, cuerpo({ url })).expect(400);
      });

      it('http solo hacia localhost: http a una IP pública se rechaza', async () => {
        await registrar(cliente.token, cuerpo({ url: 'http://8.8.8.8/hook' })).expect(400);
      });

      it('no deja nada guardado', async () => {
        const antes = await prisma.db.webhook_cabecera.count({
          where: { id_propietario: cliente.id },
        });
        await registrar(cliente.token, cuerpo({ url: 'http://10.1.1.1/x' })).expect(400);
        expect(
          await prisma.db.webhook_cabecera.count({ where: { id_propietario: cliente.id } }),
        ).toBe(antes);
      });
    });

    it('409 si el usuario ya tiene esa URL activa; otro usuario sí puede', async () => {
      const solicitud = cuerpo();
      await registrar(cliente.token, solicitud).expect(201);
      const repetida = await registrar(cliente.token, solicitud).expect(409);
      esperarProblemDetails(repetida);
      await registrar(otro.token, solicitud).expect(201);
    });

    it('con la URL de una suscripción dada de baja se puede registrar de nuevo', async () => {
      const solicitud = cuerpo();
      const { body } = await registrar(cliente.token, solicitud).expect(201);
      await con(app, cliente.token)('delete', `${WEBHOOKS}/${body.id}`).expect(204);
      await registrar(cliente.token, solicitud).expect(201);
    });

    it('401 sin token y 403 sin el scope flights:webhooks', async () => {
      await con(app)('post', WEBHOOKS).send(cuerpo()).expect(401);
      const sinScope = firmarToken(
        app,
        { scope: 'flights:read' },
        { subject: cliente.id, expiresIn: 60 },
      );
      const respuesta = await registrar(sinScope, cuerpo()).expect(403);
      esperarProblemDetails(respuesta);
    });
  });

  describe('límite de 10 suscripciones activas por usuario', () => {
    it('la 11 responde 409; dar una de baja libera el cupo; es por usuario', async () => {
      const dueno = await nuevoCliente(app);
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push((await registrar(dueno.token, cuerpo()).expect(201)).body.id);
      }
      limites.reiniciar();
      const excedida = await registrar(dueno.token, cuerpo()).expect(409);
      esperarProblemDetails(excedida);
      expect(excedida.body.detail).toMatch(/10/);
      // otro usuario no se ve afectado
      await registrar(otro.token, cuerpo()).expect(201);
      await con(app, dueno.token)('delete', `${WEBHOOKS}/${ids[0]}`).expect(204);
      await registrar(dueno.token, cuerpo()).expect(201);
    });

    it('altas simultáneas no pasan de 10 (candado por usuario)', async () => {
      const dueno = await nuevoCliente(app);
      for (let i = 0; i < 8; i++) await registrar(dueno.token, cuerpo()).expect(201);
      limites.reiniciar();
      const estados = await Promise.all(
        Array.from({ length: 5 }, () => registrar(dueno.token, cuerpo()).then((r) => r.status)),
      );
      expect(estados.filter((s) => s === 201)).toHaveLength(2);
      expect(estados.filter((s) => s === 409)).toHaveLength(3);
      const activas = await prisma.db.webhook_cabecera.count({
        where: { id_propietario: dueno.id, activo: true },
      });
      expect(activas).toBe(10);
    });
  });

  describe('GET /webhooks', () => {
    it('solo las suscripciones activas del usuario, sin las de otros ni las dadas de baja', async () => {
      const dueno = await nuevoCliente(app);
      const a = (await registrar(dueno.token, cuerpo()).expect(201)).body;
      const b = (await registrar(dueno.token, cuerpo()).expect(201)).body;
      await registrar(otro.token, cuerpo()).expect(201);
      await con(app, dueno.token)('delete', `${WEBHOOKS}/${b.id}`).expect(204);
      const lista = await con(app, dueno.token)('get', WEBHOOKS).expect(200);
      expect(lista.body).toEqual([a]);
      for (const w of lista.body) {
        expect(erroresContraContrato('WebhookSubscription', w)).toEqual([]);
      }
      expect(lista.headers['cache-control']).toBe('no-store');
    });

    it('un usuario sin suscripciones recibe []', async () => {
      const nuevo = await nuevoCliente(app);
      const lista = await con(app, nuevo.token)('get', WEBHOOKS).expect(200);
      expect(lista.body).toEqual([]);
    });

    it('401 sin token', async () => {
      await con(app)('get', WEBHOOKS).expect(401);
    });
  });

  describe('DELETE /webhooks/{id}', () => {
    it('204 y baja lógica: la fila sigue, con activo = false, y queda en la auditoría', async () => {
      const { body } = await registrar(cliente.token, cuerpo()).expect(201);
      const respuesta = await con(app, cliente.token)('delete', `${WEBHOOKS}/${body.id}`).expect(
        204,
      );
      expect(respuesta.text).toBe('');
      const fila = await prisma.db.webhook_cabecera.findUniqueOrThrow({ where: { id: body.id } });
      expect(fila.activo).toBe(false);
      const auditoria = await prisma.db.auditoria.findMany({
        where: {
          nombre_tabla: 'webhook_cabecera',
          id_registro: body.id,
          operacion: 'ACTUALIZACION',
        },
      });
      expect(auditoria).toHaveLength(1);
      expect(auditoria[0].id_usuario).toBe(cliente.id);
      expect(auditoria[0].datos_nuevos).toEqual({ activo: false });
    });

    it('404 si es de otro usuario (y no la toca), no existe o ya estaba dada de baja', async () => {
      const { body } = await registrar(cliente.token, cuerpo()).expect(201);
      const ajena = await con(app, otro.token)('delete', `${WEBHOOKS}/${body.id}`).expect(404);
      esperarProblemDetails(ajena);
      expect(
        (await prisma.db.webhook_cabecera.findUniqueOrThrow({ where: { id: body.id } })).activo,
      ).toBe(true);
      await con(app, cliente.token)('delete', `${WEBHOOKS}/${randomUUID()}`).expect(404);
      await con(app, cliente.token)('delete', `${WEBHOOKS}/${body.id}`).expect(204);
      await con(app, cliente.token)('delete', `${WEBHOOKS}/${body.id}`).expect(404);
    });

    it('400 si el id no es un uuid; 401 sin token', async () => {
      esperarProblemDetails(await con(app, cliente.token)('delete', `${WEBHOOKS}/abc`).expect(400));
      await con(app)('delete', `${WEBHOOKS}/${randomUUID()}`).expect(401);
    });
  });
});
