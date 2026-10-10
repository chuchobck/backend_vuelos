import { randomUUID } from 'node:crypto';
import { VALOR_CENSURADO } from '../src/modules/vuelos/administracion/auditoria/censura';
import { crearUsuario, desactivarUsuariosDePrueba } from './utils/auth';
import { ADMIN, AppCatalogo, codigos, crearAppCatalogo, sufijo } from './utils/catalogo';
import { esperarProblemDetails } from './utils/problem-details';

const AUDITORIA = `${ADMIN}/audit-log`;
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g';

type Evento = {
  id: string;
  occurredAt: string;
  table: string;
  operation: string;
  recordId: string;
  userId: string | null;
  ipAddress: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

describe('GET /admin/audit-log', () => {
  let c: AppCatalogo;
  let iso2: string;
  let idPais: string;
  const nombre = `Pais ${sufijo()}`;
  const nombreNuevo = `${nombre} auditado`;

  beforeAll(async () => {
    c = await crearAppCatalogo();
    // Un país con un alta, un cambio y una baja, hechos por el administrador de la prueba
    iso2 = await codigos.pais(c.prisma);
    await c
      .admin('post', `${ADMIN}/countries`, {
        code: iso2,
        iso3: await codigos.paisIso3(c.prisma),
        name: nombre,
      })
      .expect(201);
    await c.admin('patch', `${ADMIN}/countries/${iso2}`, { name: nombreNuevo }).expect(200);
    await c.admin('delete', `${ADMIN}/countries/${iso2}`).expect(204);
    idPais = (
      await c.prisma.db.pais.findUniqueOrThrow({ where: { codigo_iso2: iso2 } })
    ).id.toString();
  });

  afterAll(async () => {
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  describe('autorización', () => {
    it('401 sin token', async () => {
      const r = await c.anonimo('get', AUDITORIA).expect(401);
      esperarProblemDetails({ status: 401, type: r.type, body: r.body });
    });

    it('403 con el token de un cliente (sin flights:admin)', async () => {
      const r = await c.cliente('get', AUDITORIA).expect(403);
      esperarProblemDetails({ status: 403, type: r.type, body: r.body });
    });
  });

  describe('contenido', () => {
    it('devuelve los eventos del registro, el más reciente primero, con todos los campos', async () => {
      const r = await c.admin('get', `${AUDITORIA}?table=pais&recordId=${idPais}`).expect(200);
      const items = r.body.items as Evento[];
      expect(items.map((e) => e.operation)).toEqual(['UPDATE', 'UPDATE', 'INSERT']);
      expect(r.body.nextCursor).toBeUndefined();
      for (const e of items) {
        expect(Object.keys(e).sort()).toEqual(
          [
            'after',
            'before',
            'id',
            'ipAddress',
            'occurredAt',
            'operation',
            'recordId',
            'table',
            'userId',
          ].sort(),
        );
        expect(e).toMatchObject({ table: 'pais', recordId: idPais, userId: c.idAdmin });
        expect(typeof e.id).toBe('string');
        expect(new Date(e.occurredAt).toISOString()).toBe(e.occurredAt);
        expect(e.ipAddress).toEqual(expect.any(String));
      }
      const [baja, cambio, alta] = items;
      expect(alta.before).toBeNull();
      expect(alta.after).toMatchObject({ codigo_iso2: iso2, nombre });
      // En UPDATE solo viajan las columnas que cambiaron
      expect(cambio.before).toEqual({ nombre });
      expect(cambio.after).toEqual({ nombre: nombreNuevo });
      expect(baja.before).toEqual({ activo: true });
      expect(baja.after).toEqual({ activo: false });
    });

    it('un evento de la tabla usuario nunca devuelve el hash de la contraseña', async () => {
      const nuevo = await crearUsuario(c.app);
      const r = await c.admin('get', `${AUDITORIA}?table=usuario&recordId=${nuevo.id}`).expect(200);
      const items = r.body.items as Evento[];
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items[items.length - 1].operation).toBe('INSERT');
      expect(items[items.length - 1].after).toMatchObject({
        correo: nuevo.correo,
        hash_contrasena: VALOR_CENSURADO,
      });
      expect(JSON.stringify(r.body)).not.toMatch(/argon2/);
    });

    it('censura aunque el log traiga un secreto sin enmascarar, a cualquier profundidad', async () => {
      const idRegistro = randomUUID();
      // El log es de solo inserción: esta fila queda (es de una tabla ficticia "prueba_censura")
      await c.prisma.transaccionAuditada((tx) =>
        tx.auditoria.create({
          data: {
            nombre_tabla: 'prueba_censura',
            operacion: 'INSERCION',
            id_registro: idRegistro,
            datos_nuevos: {
              hash_contrasena: HASH,
              anidado: { refresh_token: 'rt-secreto', lista: [{ secreto: 'webhook-secreto' }] },
              authorization: 'Bearer abc.def.ghi',
              correo: 'visible@example.com',
            },
          },
        }),
      );
      const r = await c
        .admin('get', `${AUDITORIA}?table=prueba_censura&recordId=${idRegistro}`)
        .expect(200);
      expect(r.body.items).toHaveLength(1);
      expect(r.body.items[0].after).toEqual({
        hash_contrasena: VALOR_CENSURADO,
        anidado: { refresh_token: VALOR_CENSURADO, lista: [{ secreto: VALOR_CENSURADO }] },
        authorization: VALOR_CENSURADO,
        correo: 'visible@example.com',
      });
      const texto = JSON.stringify(r.body);
      for (const secreto of ['argon2', 'rt-secreto', 'webhook-secreto', 'abc.def.ghi']) {
        expect(texto).not.toContain(secreto);
      }
    });
  });

  describe('filtros', () => {
    it('operation: UPDATE solo trae cambios y acepta minúsculas', async () => {
      for (const operation of ['UPDATE', 'update']) {
        const r = await c
          .admin('get', `${AUDITORIA}?table=pais&recordId=${idPais}&operation=${operation}`)
          .expect(200);
        expect((r.body.items as Evento[]).map((e) => e.operation)).toEqual(['UPDATE', 'UPDATE']);
      }
      const inserciones = await c
        .admin('get', `${AUDITORIA}?table=pais&recordId=${idPais}&operation=INSERT`)
        .expect(200);
      expect(inserciones.body.items).toHaveLength(1);
      const borrados = await c
        .admin('get', `${AUDITORIA}?table=pais&recordId=${idPais}&operation=DELETE`)
        .expect(200);
      expect(borrados.body.items).toEqual([]);
    });

    it('userId: solo los eventos de ese usuario', async () => {
      const r = await c.admin('get', `${AUDITORIA}?userId=${c.idAdmin}&limit=100`).expect(200);
      const items = r.body.items as Evento[];
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(new Set(items.map((e) => e.userId))).toEqual(new Set([c.idAdmin]));
      const otro = await c.admin('get', `${AUDITORIA}?userId=${randomUUID()}`).expect(200);
      expect(otro.body.items).toEqual([]);
    });

    it('from y to: días UTC con los dos extremos incluidos', async () => {
      const hoy = new Date().toISOString().slice(0, 10);
      const ayer = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const enElDia = await c
        .admin('get', `${AUDITORIA}?table=pais&recordId=${idPais}&from=${hoy}&to=${hoy}`)
        .expect(200);
      expect(enElDia.body.items).toHaveLength(3);
      const soloAyer = await c
        .admin('get', `${AUDITORIA}?table=pais&recordId=${idPais}&from=${ayer}&to=${ayer}`)
        .expect(200);
      // Pasada la medianoche UTC entre el alta y la baja, parte puede caer en ayer: nunca más de 3
      expect(soloAyer.body.items.length).toBeLessThanOrEqual(3);
      const futuro = await c
        .admin('get', `${AUDITORIA}?table=pais&recordId=${idPais}&from=2999-01-01`)
        .expect(200);
      expect(futuro.body.items).toEqual([]);
    });

    it('table sin eventos: lista vacía', async () => {
      const r = await c.admin('get', `${AUDITORIA}?table=no_existe_esta_tabla`).expect(200);
      expect(r.body).toEqual({ items: [] });
    });
  });

  describe('paginación por cursor', () => {
    it('recorre todos los eventos de la tabla en orden estable, sin repetir ni saltar', async () => {
      const todos = (await c.admin('get', `${AUDITORIA}?table=pais&limit=100`).expect(200)).body
        .items as Evento[];
      expect(todos.length).toBeGreaterThanOrEqual(3);

      const recorridas: Evento[] = [];
      let cursor: string | undefined;
      let paginas = 0;
      do {
        const r = await c
          .admin('get', `${AUDITORIA}?table=pais&limit=2${cursor ? `&cursor=${cursor}` : ''}`)
          .expect(200);
        const pagina = r.body.items as Evento[];
        expect(pagina.length).toBeLessThanOrEqual(2);
        recorridas.push(...pagina);
        cursor = r.body.nextCursor;
        paginas++;
        // Una página con siguiente está llena
        if (cursor) expect(pagina).toHaveLength(2);
      } while (cursor && paginas < 200);

      expect(recorridas.map((e) => e.id)).toEqual(todos.map((e) => e.id));
      const tiempos = recorridas.map((e) => Date.parse(e.occurredAt));
      expect([...tiempos].sort((a, b) => b - a)).toEqual(tiempos);
    });

    it('el cursor es opaco (base64url) y uno inventado es 400', async () => {
      const pagina = await c.admin('get', `${AUDITORIA}?limit=1`).expect(200);
      expect(pagina.body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      for (const cursor of [
        'no-es-un-cursor',
        Buffer.from('1|2|3').toString('base64url'),
        Buffer.from('2026-01-01T00:00:00Z|abc').toString('base64url'),
        Buffer.from('basura|5').toString('base64url'),
      ]) {
        const r = await c.admin('get', `${AUDITORIA}?cursor=${cursor}`).expect(400);
        esperarProblemDetails({ status: 400, type: r.type, body: r.body });
      }
    });
  });

  describe('validación (400 ProblemDetails)', () => {
    it.each([
      ['operation inválida', 'operation=TRUNCATE'],
      ['from que no es fecha', 'from=ayer'],
      ['from que no existe en el calendario', 'from=2026-02-30'],
      ['to que no es fecha', 'to=2026-13-01'],
      ['to antes de from', 'from=2026-05-02&to=2026-05-01'],
      ['limit en cero', 'limit=0'],
      ['limit sobre el máximo (100)', 'limit=101'],
      ['limit que no es número', 'limit=muchos'],
      ['table con caracteres no permitidos', 'table=pais%3B%20DROP'],
      ['parámetro desconocido', 'foo=bar'],
    ])('%s', async (_nombre, consulta) => {
      const r = await c.admin('get', `${AUDITORIA}?${consulta}`).expect(400);
      esperarProblemDetails({ status: 400, type: r.type, body: r.body });
    });

    it('limit=100 es válido', async () => {
      await c.admin('get', `${AUDITORIA}?limit=100`).expect(200);
    });
  });
});
