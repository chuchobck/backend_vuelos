import { randomUUID } from 'node:crypto';
import {
  DOMINIO_PRUEBAS,
  crearUsuario,
  desactivarUsuariosDePrueba,
  firmarToken,
  iniciarSesion,
} from './utils/auth';
import { ADMIN, AppCatalogo, crearAppCatalogo } from './utils/catalogo';
import { esperarProblemDetails } from './utils/problem-details';
import * as request from 'supertest';

const USUARIOS = `${ADMIN}/users`;
const CLAVE = 'una frase larga de prueba 123';

type Admin = { id: string; email: string; createdAt: string; active: boolean };

describe('/admin/users', () => {
  let c: AppCatalogo;
  const correo = () => `e2e-adm-${randomUUID()}@${DOMINIO_PRUEBAS}`;
  const crear = (email = correo(), password = CLAVE) =>
    c.admin('post', USUARIOS, { email, password });
  const alta = async (): Promise<Admin & { password: string }> => {
    const email = correo();
    const r = await crear(email).expect(201);
    return { ...(r.body as Admin), password: CLAVE };
  };
  /** Un access token sin pasar por el límite de /auth/login (5 por minuto e IP). */
  const tokenDe = async (u: Admin & { password: string }) =>
    (await iniciarSesion(c.app, { id: u.id, correo: u.email, contrasena: u.password }))
      .access_token;
  const login = (email: string, password: string) =>
    request(c.app.getHttpServer()).post('/flights/v1/auth/login').send({ email, password });

  beforeAll(async () => {
    c = await crearAppCatalogo();
  });
  afterAll(async () => {
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  describe('autorización', () => {
    const rutas: Array<['get' | 'post' | 'delete', string]> = [
      ['get', USUARIOS],
      ['post', USUARIOS],
      ['delete', `${USUARIOS}/${randomUUID()}`],
    ];
    it.each(rutas)('401 sin token: %s %s', async (metodo, ruta) => {
      const r = await c.anonimo(metodo, ruta, metodo === 'post' ? {} : undefined).expect(401);
      esperarProblemDetails({ status: 401, type: r.type, body: r.body });
    });
    it.each(rutas)('403 con token de cliente: %s %s', async (metodo, ruta) => {
      const r = await c.cliente(metodo, ruta, metodo === 'post' ? {} : undefined).expect(403);
      esperarProblemDetails({ status: 403, type: r.type, body: r.body });
    });
  });

  describe('POST (crear)', () => {
    it('201 con { id, email, createdAt, active } y nunca el hash', async () => {
      const email = correo();
      const r = await crear(email).expect(201);
      expect(Object.keys(r.body).sort()).toEqual(['active', 'createdAt', 'email', 'id']);
      expect(r.body).toMatchObject({ email, active: true });
      expect(new Date(r.body.createdAt).toISOString()).toBe(r.body.createdAt);
      expect(JSON.stringify(r.body)).not.toMatch(/argon2|hash|password/i);
    });

    it('guarda un hash argon2id con el rol administrador, y la auditoría nombra al autor', async () => {
      const nuevo = await alta();
      const fila = await c.prisma.db.usuario.findUniqueOrThrow({
        where: { id: nuevo.id },
        include: { usuario_rol: { include: { rol: true } } },
      });
      expect(fila.hash_contrasena).toMatch(/^\$argon2id\$/);
      expect(fila.hash_contrasena).not.toContain(CLAVE);
      expect(fila.usuario_rol.map((ur) => [ur.rol.codigo, ur.activo])).toEqual([
        ['administrador', true],
      ]);
      const evento = await c.prisma.db.auditoria.findFirstOrThrow({
        where: { nombre_tabla: 'usuario', id_registro: nuevo.id, operacion: 'INSERCION' },
      });
      // El actor es el administrador que hizo la petición, no el usuario creado
      expect(evento.id_usuario).toBe(c.idAdmin);
      expect(JSON.stringify(evento.datos_nuevos)).not.toContain('argon2id$v=19$m');
    });

    it('normaliza el correo como /auth/register (minúsculas y sin espacios)', async () => {
      const base = correo();
      const r = await crear(`  ${base.toUpperCase()}  `).expect(201);
      expect(r.body.email).toBe(base);
    });

    it('el nuevo administrador inicia sesión y tiene flights:admin; su rol lo fijó el servidor', async () => {
      const nuevo = await alta();
      const sesion = await login(nuevo.email, nuevo.password).expect(200);
      expect(sesion.body.scope.split(' ')).toContain('flights:admin');
      const yo = await request(c.app.getHttpServer())
        .get('/flights/v1/auth/me')
        .set('Authorization', `Bearer ${sesion.body.access_token}`)
        .expect(200);
      expect(yo.body.roles).toEqual(['administrador']);
      await request(c.app.getHttpServer())
        .get(USUARIOS)
        .set('Authorization', `Bearer ${sesion.body.access_token}`)
        .expect(200);
    });

    it('409 si el correo ya existe (también con otras mayúsculas), sin crear nada', async () => {
      const email = correo();
      await crear(email).expect(201);
      const r = await crear(email.toUpperCase()).expect(409);
      esperarProblemDetails({ status: 409, type: r.type, body: r.body });
      expect(await c.prisma.db.usuario.count({ where: { correo: email } })).toBe(1);
    });

    it('409 también si el correo es de un cliente', async () => {
      const cliente = await crearUsuario(c.app);
      await crear(cliente.correo).expect(409);
    });

    it('400 si falta un campo, el correo no es válido o la contraseña mide menos de 12 o más de 128', async () => {
      const casos: object[] = [
        {},
        { email: correo() },
        { password: CLAVE },
        { email: 'no-es-un-correo', password: CLAVE },
        { email: correo(), password: 'a'.repeat(11) },
        { email: correo(), password: 'a'.repeat(129) },
        { email: correo(), password: 12345678901234 },
      ];
      for (const cuerpo of casos) {
        const r = await c.admin('post', USUARIOS, cuerpo).expect(400);
        esperarProblemDetails({ status: 400, type: r.type, body: r.body });
      }
      // Los límites exactos sí valen
      await crear(correo(), 'a'.repeat(12)).expect(201);
      await crear(correo(), 'a'.repeat(128)).expect(201);
    });

    it('400 si el cuerpo trae un rol (el rol lo fija el servidor); no se crea la cuenta', async () => {
      for (const extra of [
        { role: 'cliente' },
        { rol: 'administrador' },
        { roles: ['x'], scopes: ['flights:admin'] },
      ]) {
        const email = correo();
        const r = await c.admin('post', USUARIOS, { email, password: CLAVE, ...extra }).expect(400);
        esperarProblemDetails({ status: 400, type: r.type, body: r.body });
        expect(await c.prisma.db.usuario.count({ where: { correo: email } })).toBe(0);
      }
    });
  });

  describe('GET (listar)', () => {
    it('lista administradores con { id, email, createdAt, active }, sin clientes ni hashes', async () => {
      const nuevo = await alta();
      const cliente = await crearUsuario(c.app);
      const r = await c.admin('get', `${USUARIOS}?limit=50`).expect(200);
      const items = r.body.items as Admin[];
      expect(items.find((a) => a.id === nuevo.id)).toEqual({
        id: nuevo.id,
        email: nuevo.email,
        createdAt: nuevo.createdAt,
        active: true,
      });
      expect(items.find((a) => a.id === cliente.id)).toBeUndefined();
      expect(items.find((a) => a.id === c.idAdmin)).toBeDefined();
      expect(items.every((a) => a.active)).toBe(true);
      expect(JSON.stringify(r.body)).not.toMatch(/argon2|hash/i);
      for (const a of items)
        expect(Object.keys(a).sort()).toEqual(['active', 'createdAt', 'email', 'id']);
    });

    it('pagina por cursor, del más reciente al más viejo, sin repetir', async () => {
      const creados = [await alta(), await alta(), await alta()];
      const todos = (await c.admin('get', `${USUARIOS}?limit=50`).expect(200)).body
        .items as Admin[];
      const recorridos: Admin[] = [];
      let cursor: string | undefined;
      let paginas = 0;
      do {
        const r = await c
          .admin('get', `${USUARIOS}?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
          .expect(200);
        recorridos.push(...(r.body.items as Admin[]));
        cursor = r.body.nextCursor;
        if (cursor) expect(r.body.items).toHaveLength(2);
        paginas++;
      } while (cursor && paginas < 100);
      expect(recorridos.map((a) => a.id)).toEqual(todos.map((a) => a.id));
      const ids = recorridos.map((a) => a.id);
      for (const nuevo of creados) expect(ids).toContain(nuevo.id);
      const fechas = recorridos.map((a) => Date.parse(a.createdAt));
      expect([...fechas].sort((x, y) => y - x)).toEqual(fechas);
    });

    it('400 con un cursor inventado, un límite fuera de rango o un parámetro desconocido', async () => {
      for (const consulta of [
        'cursor=nada',
        'limit=0',
        'limit=51',
        'includeInactive=quizas',
        'x=1',
      ]) {
        const r = await c.admin('get', `${USUARIOS}?${consulta}`).expect(400);
        esperarProblemDetails({ status: 400, type: r.type, body: r.body });
      }
    });
  });

  describe('DELETE (baja lógica)', () => {
    it('da de baja: 204, la cuenta queda inactiva (no se borra) y deja de salir en la lista', async () => {
      const objetivo = await alta();
      await c.admin('delete', `${USUARIOS}/${objetivo.id}`).expect(204);

      const fila = await c.prisma.db.usuario.findUniqueOrThrow({ where: { id: objetivo.id } });
      expect(fila.activo).toBe(false);

      const activos = (await c.admin('get', `${USUARIOS}?limit=50`).expect(200)).body
        .items as Admin[];
      expect(activos.find((a) => a.id === objetivo.id)).toBeUndefined();
      const todos = (await c.admin('get', `${USUARIOS}?limit=50&includeInactive=true`).expect(200))
        .body.items as Admin[];
      expect(todos.find((a) => a.id === objetivo.id)).toMatchObject({
        id: objetivo.id,
        active: false,
      });

      const evento = await c.prisma.db.auditoria.findFirstOrThrow({
        where: { nombre_tabla: 'usuario', id_registro: objetivo.id, operacion: 'ACTUALIZACION' },
      });
      expect(evento.id_usuario).toBe(c.idAdmin);
      expect(evento.datos_nuevos).toEqual({ activo: false });
    });

    it('revoca sus refresh tokens: no puede renovar la sesión ni volver a entrar', async () => {
      const objetivo = await alta();
      const sesion = {
        body: await iniciarSesion(c.app, {
          id: objetivo.id,
          correo: objetivo.email,
          contrasena: objetivo.password,
        }),
      };
      await c.admin('delete', `${USUARIOS}/${objetivo.id}`).expect(204);

      const tokens = await c.prisma.db.token_refresco.findMany({
        where: { usuario_id: objetivo.id },
      });
      expect(tokens.length).toBeGreaterThanOrEqual(1);
      for (const t of tokens) {
        expect(t.fecha_revocacion).not.toBeNull();
        expect(t.motivo_revocacion).toBe('USUARIO_INACTIVO');
      }
      const renovacion = await request(c.app.getHttpServer())
        .post('/flights/v1/auth/refresh')
        .send({ refresh_token: sesion.body.refresh_token })
        .expect(401);
      esperarProblemDetails({ status: 401, type: renovacion.type, body: renovacion.body });
      await login(objetivo.email, objetivo.password).expect(401);
    });

    it('idempotente: repetir la baja responde 204 igual', async () => {
      const objetivo = await alta();
      await c.admin('delete', `${USUARIOS}/${objetivo.id}`).expect(204);
      await c.admin('delete', `${USUARIOS}/${objetivo.id}`).expect(204);
    });

    it('409 si es la propia cuenta, y la cuenta sigue activa', async () => {
      const yo = await alta();
      const r = await request(c.app.getHttpServer())
        .delete(`${USUARIOS}/${yo.id}`)
        .set('Authorization', `Bearer ${await tokenDe(yo)}`)
        .expect(409);
      esperarProblemDetails({ status: 409, type: r.type, body: r.body });
      expect(r.body.detail).toMatch(/your own account/);
      expect((await c.prisma.db.usuario.findUniqueOrThrow({ where: { id: yo.id } })).activo).toBe(
        true,
      );
    });

    it('404 si no existe, si es un cliente o si no es un uuid (400)', async () => {
      const cliente = await crearUsuario(c.app);
      for (const id of [randomUUID(), cliente.id]) {
        const r = await c.admin('delete', `${USUARIOS}/${id}`).expect(404);
        esperarProblemDetails({ status: 404, type: r.type, body: r.body });
      }
      expect(
        (await c.prisma.db.usuario.findUniqueOrThrow({ where: { id: cliente.id } })).activo,
      ).toBe(true);
      const mal = await c.admin('delete', `${USUARIOS}/no-es-un-uuid`).expect(400);
      esperarProblemDetails({ status: 400, type: mal.type, body: mal.body });
    });

    it('dos administradores que se dan de baja a la vez no dejan al sistema sin ninguno', async () => {
      const a = await alta();
      const b = await alta();
      const [ta, tb] = [await tokenDe(a), await tokenDe(b)];
      const borrar = (token: string, id: string) =>
        request(c.app.getHttpServer())
          .delete(`${USUARIOS}/${id}`)
          .set('Authorization', `Bearer ${token}`);
      const antes = await c.prisma.db.usuario.count({
        where: {
          activo: true,
          usuario_rol: { some: { activo: true, rol: { codigo: 'administrador' } } },
        },
      });
      const respuestas = await Promise.all([borrar(ta, b.id), borrar(tb, a.id)]);
      // Nunca un 500 ni un bloqueo: cada baja o se hace (204) o la rechaza la regla (409)
      for (const r of respuestas) expect([204, 409]).toContain(r.status);
      const despues = await c.prisma.db.usuario.count({
        where: {
          activo: true,
          usuario_rol: { some: { activo: true, rol: { codigo: 'administrador' } } },
        },
      });
      expect(despues).toBeGreaterThanOrEqual(1);
      expect(despues).toBeLessThan(antes + 1);
    });
  });

  describe('último administrador activo', () => {
    it('409: no se puede dar de baja al único administrador que queda', async () => {
      const otrosAdmins = await c.prisma.db.usuario.count({
        where: {
          activo: true,
          usuario_rol: { some: { activo: true, rol: { codigo: 'administrador' } } },
          NOT: { correo: { endsWith: `@${DOMINIO_PRUEBAS}` } },
        },
      });
      if (otrosAdmins > 0) {
        // Con un administrador real en la base (semilla) la regla no se puede aislar sin tocarlo
        console.warn(
          `Prueba omitida: hay ${otrosAdmins} administrador(es) activo(s) fuera de las pruebas`,
        );
        return;
      }
      // Solo queda activo el objetivo: los demás administradores de la prueba se dan de baja en
      // la base; el token de uno de ellos sigue vigente (el access token no se revoca).
      const objetivo = await alta();
      await c.prisma.transaccionAuditada((tx) =>
        tx.usuario.updateMany({
          where: {
            id: { not: objetivo.id },
            correo: { endsWith: `@${DOMINIO_PRUEBAS}` },
            usuario_rol: { some: { activo: true, rol: { codigo: 'administrador' } } },
          },
          data: { activo: false },
        }),
      );
      const r = await c.admin('delete', `${USUARIOS}/${objetivo.id}`).expect(409);
      esperarProblemDetails({ status: 409, type: r.type, body: r.body });
      expect(r.body.detail).toMatch(/last active administrator/);
      expect(
        (await c.prisma.db.usuario.findUniqueOrThrow({ where: { id: objetivo.id } })).activo,
      ).toBe(true);
      // Un token forjado con la firma de la API no cambia la regla
      const falso = firmarToken(
        c.app,
        { scope: 'flights:admin' },
        { subject: randomUUID(), expiresIn: 60 },
      );
      await request(c.app.getHttpServer())
        .delete(`${USUARIOS}/${objetivo.id}`)
        .set('Authorization', `Bearer ${falso}`)
        .expect(409);
    });
  });
});
