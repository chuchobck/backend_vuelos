import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashearTokenRefresco } from '../src/modules/auth/seguridad/token-refresco';
import {
  CONTRASENA_PRUEBA,
  DOMINIO_PRUEBAS,
  correoDePrueba,
  crearUsuario,
  desactivar,
  desactivarUsuariosDePrueba,
  iniciarSesion,
} from './utils/auth';
import { crearApp } from './utils/crear-app';
import { esperarProblemDetails } from './utils/problem-details';

const AUTH = '/flights/v1/auth';
const SCOPES_CLIENTE = [
  'flights:read',
  'flights:hold',
  'flights:book',
  'flights:cancel',
  'flights:webhooks',
];

/**
 * Registro, login, refresh, logout y perfil contra la base real. Las cuentas que se crean
 * quedan desactivadas al final (el borrado físico está prohibido).
 *
 * El login por HTTP tiene un límite de 5 por minuto e IP: aquí se usa a lo sumo 4 veces, y
 * la preparación de cada prueba inicia sesión con el service (utils/auth.ts).
 */
describe('Auth', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await crearApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  const tokensDeLaFamilia = (refreshToken: string) =>
    prisma.db.token_refresco
      .findUniqueOrThrow({ where: { hash_token: hashearTokenRefresco(refreshToken) } })
      .then(({ id_familia }) =>
        prisma.db.token_refresco.findMany({
          where: { id_familia },
          orderBy: { fecha_creacion: 'asc' },
        }),
      );

  describe('POST /auth/register', () => {
    it('crea la cuenta con el correo normalizado, el rol cliente y sin datos internos', async () => {
      const correo = correoDePrueba();
      const respuesta = await http()
        .post(`${AUTH}/register`)
        .send({ email: `  ${correo.toUpperCase()} `, password: CONTRASENA_PRUEBA })
        .expect(201);

      expect(respuesta.body).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        email: correo,
        roles: ['cliente'],
        scopes: SCOPES_CLIENTE,
        createdAt: expect.any(String),
      });
      const fila = await prisma.db.usuario.findUniqueOrThrow({ where: { correo } });
      expect(fila.hash_contrasena).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
      expect(JSON.stringify(respuesta.body)).not.toContain('argon2');

      // La auditoría guarda el alta con el propio usuario como autor y el hash enmascarado
      const [alta] = await prisma.db.auditoria.findMany({
        where: { nombre_tabla: 'usuario', id_registro: fila.id, operacion: 'INSERCION' },
      });
      expect(alta.id_usuario).toBe(fila.id);
      expect((alta.datos_nuevos as Record<string, unknown>).hash_contrasena).toBe('***');
    });

    it('un correo ya registrado (con otra capitalización) responde 409', async () => {
      const usuario = await crearUsuario(app);
      const respuesta = await http()
        .post(`${AUTH}/register`)
        .send({ email: usuario.correo.toUpperCase(), password: CONTRASENA_PRUEBA });

      expect(respuesta.status).toBe(409);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.detail).toBe('An account with this email already exists');
    });

    it.each([
      ['contraseña de 11 caracteres', { email: correoDePrueba(), password: 'x'.repeat(11) }],
      ['contraseña de 129 caracteres', { email: correoDePrueba(), password: 'x'.repeat(129) }],
      ['correo inválido', { email: 'no-es-un-correo', password: CONTRASENA_PRUEBA }],
      ['HTML en el correo', { email: `<b>@${DOMINIO_PRUEBAS}`, password: CONTRASENA_PRUEBA }],
      ['un campo extra (rol)', { email: correoDePrueba(), password: CONTRASENA_PRUEBA, rol: 'x' }],
    ])('rechaza %s con 400 y sin repetir la contraseña', async (_caso, cuerpo) => {
      const respuesta = await http().post(`${AUTH}/register`).send(cuerpo);

      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
      expect(JSON.stringify(respuesta.body)).not.toContain(cuerpo.password);
    });

    it('acepta 12 y 128 caracteres, sin reglas de composición', async () => {
      for (const password of ['a'.repeat(12), 'a'.repeat(128)]) {
        await http()
          .post(`${AUTH}/register`)
          .send({ email: correoDePrueba(), password })
          .expect(201);
      }
    });
  });

  describe('POST /auth/login', () => {
    it('con las credenciales correctas entrega los tokens con los nombres de OAuth 2.0', async () => {
      const usuario = await crearUsuario(app);
      const respuesta = await http()
        .post(`${AUTH}/login`)
        .send({ email: usuario.correo.toUpperCase(), password: usuario.contrasena })
        .expect(200);

      expect(respuesta.body).toEqual({
        access_token: expect.stringMatching(/^ey[\w-]+\.[\w-]+\.[\w-]+$/),
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: expect.stringMatching(/^[\w-]{43}$/),
        scope: SCOPES_CLIENTE.join(' '),
      });
      expect(respuesta.headers['cache-control']).toBe('no-store');
      expect(respuesta.headers['pragma']).toBe('no-cache');
    });

    it('contraseña errónea, correo inexistente y cuenta inactiva responden exactamente igual', async () => {
      const usuario = await crearUsuario(app);
      const inactivo = await crearUsuario(app);
      await desactivar(app, inactivo);

      const intentos = await Promise.all([
        http()
          .post(`${AUTH}/login`)
          .send({ email: usuario.correo, password: 'otra frase equivocada' }),
        http().post(`${AUTH}/login`).send({ email: correoDePrueba(), password: CONTRASENA_PRUEBA }),
        // La contraseña es la correcta, pero la cuenta está desactivada
        http()
          .post(`${AUTH}/login`)
          .send({ email: inactivo.correo, password: inactivo.contrasena }),
      ]);

      for (const respuesta of intentos) {
        expect(respuesta.status).toBe(401);
        esperarProblemDetails(respuesta);
        expect(respuesta.headers['www-authenticate']).toBe('Bearer realm="quinde-vuelos-api"');
      }
      const [primero, ...demas] = intentos;
      for (const respuesta of demas) expect(respuesta.body).toEqual(primero.body);
      expect(primero.body.detail).toBe('Invalid email or password');
    });
  });

  describe('POST /auth/refresh', () => {
    it('rota el token: entrega uno nuevo y el usado queda marcado como reemplazado', async () => {
      const sesion = await iniciarSesion(app, await crearUsuario(app));

      const respuesta = await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(200);

      expect(respuesta.body.refresh_token).not.toBe(sesion.refresh_token);
      expect(respuesta.body.access_token).not.toBe(sesion.access_token);
      expect(respuesta.headers['cache-control']).toBe('no-store');

      const [usado, nuevo] = await tokensDeLaFamilia(sesion.refresh_token);
      expect(usado.reemplazado_por_id).toBe(nuevo.id);
      expect(usado.fecha_revocacion).toBeNull();
      expect(nuevo.hash_token).toBe(hashearTokenRefresco(respuesta.body.refresh_token));
      // Solo se guarda el hash: el token no aparece en la fila
      expect(JSON.stringify(nuevo)).not.toContain(respuesta.body.refresh_token);
    });

    it('reusar un token ya rotado revoca la familia completa, también el token vigente', async () => {
      const sesion = await iniciarSesion(app, await crearUsuario(app));
      const segundo = await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(200);

      const reuso = await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token });
      expect(reuso.status).toBe(401);
      esperarProblemDetails(reuso);
      expect(reuso.headers['www-authenticate']).toContain('error="invalid_token"');

      // El dueño legítimo también pierde la sesión: tiene que volver a iniciarla
      await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: segundo.body.refresh_token })
        .expect(401);

      const familia = await tokensDeLaFamilia(sesion.refresh_token);
      expect(familia.map((t) => t.motivo_revocacion)).toEqual(['REUTILIZACION', 'REUTILIZACION']);
    });

    it('dos refresh simultáneos con el mismo token: uno gana y el otro revoca la familia', async () => {
      const sesion = await iniciarSesion(app, await crearUsuario(app));

      const respuestas = await Promise.all(
        [1, 2].map(() =>
          http().post(`${AUTH}/refresh`).send({ refresh_token: sesion.refresh_token }),
        ),
      );

      expect(respuestas.map((r) => r.status).sort()).toEqual([200, 401]);
      const ganador = respuestas.find((r) => r.status === 200)!;
      await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: ganador.body.refresh_token })
        .expect(401);
    });

    it('un token desconocido o con formato inválido responde 401 igual que uno revocado', async () => {
      for (const refresh_token of ['A'.repeat(43), 'corto', 'x'.repeat(200)]) {
        const respuesta = await http().post(`${AUTH}/refresh`).send({ refresh_token });
        expect(respuesta.status).toBe(401);
        expect(respuesta.body.detail).toBe('The refresh token is invalid or expired');
      }
    });

    it('un token vencido responde 401', async () => {
      const sesion = await iniciarSesion(app, await crearUsuario(app));
      await prisma.db.$executeRaw`
        UPDATE vuelos.token_refresco
           SET fecha_creacion = now() - interval '8 days', fecha_expiracion = now() - interval '1 day'
         WHERE hash_token = ${hashearTokenRefresco(sesion.refresh_token)}`;

      await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(401);
    });

    it('si la cuenta se desactivó, responde 401 y revoca la familia', async () => {
      const usuario = await crearUsuario(app);
      const sesion = await iniciarSesion(app, usuario);
      await desactivar(app, usuario);

      await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(401);
      const [token] = await tokensDeLaFamilia(sesion.refresh_token);
      expect(token.motivo_revocacion).toBe('USUARIO_INACTIVO');
    });
  });

  describe('POST /auth/logout', () => {
    it('revoca la sesión del usuario: su refresh deja de servir', async () => {
      const sesion = await iniciarSesion(app, await crearUsuario(app));

      await http()
        .post(`${AUTH}/logout`)
        .set('Authorization', `Bearer ${sesion.access_token}`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(204);

      await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(401);
      const [token] = await tokensDeLaFamilia(sesion.refresh_token);
      expect(token.motivo_revocacion).toBe('CIERRE_SESION');
    });

    it('no toca el refresh de otro usuario y responde 204 igual (no revela si existía)', async () => {
      const ana = await iniciarSesion(app, await crearUsuario(app));
      const beto = await iniciarSesion(app, await crearUsuario(app));

      await http()
        .post(`${AUTH}/logout`)
        .set('Authorization', `Bearer ${ana.access_token}`)
        .send({ refresh_token: beto.refresh_token })
        .expect(204);

      await http().post(`${AUTH}/refresh`).send({ refresh_token: beto.refresh_token }).expect(200);
    });

    it('sin token de acceso responde 401', async () => {
      const respuesta = await http()
        .post(`${AUTH}/logout`)
        .send({ refresh_token: 'A'.repeat(43) });
      expect(respuesta.status).toBe(401);
      expect(respuesta.headers['www-authenticate']).toBe('Bearer realm="quinde-vuelos-api"');
    });
  });

  describe('GET /auth/me', () => {
    it('devuelve el perfil del usuario del token', async () => {
      const admin = await crearUsuario(app, { administrador: true });
      const sesion = await iniciarSesion(app, admin);

      const respuesta = await http()
        .get(`${AUTH}/me`)
        .set('Authorization', `Bearer ${sesion.access_token}`)
        .expect(200);

      expect(respuesta.body).toMatchObject({
        id: admin.id,
        email: admin.correo,
        roles: expect.arrayContaining(['cliente', 'administrador']),
        scopes: [...SCOPES_CLIENTE, 'flights:admin'],
      });
      expect(sesion.scope).toBe([...SCOPES_CLIENTE, 'flights:admin'].join(' '));
    });

    it('con la cuenta desactivada después del login responde 401', async () => {
      const usuario = await crearUsuario(app);
      const sesion = await iniciarSesion(app, usuario);
      await desactivar(app, usuario);

      const respuesta = await http()
        .get(`${AUTH}/me`)
        .set('Authorization', `Bearer ${sesion.access_token}`);
      expect(respuesta.status).toBe(401);
      expect(respuesta.body.detail).toBe('The account is not active');
    });
  });
});
