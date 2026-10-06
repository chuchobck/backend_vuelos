import { Controller, Get, INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { Publico } from '../src/common/decorators/publico.decorator';
import { Scopes } from '../src/common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../src/common/decorators/usuario-actual.decorator';
import { validarEntorno } from '../src/config/entorno';
import { scopesDeRoles } from '../src/modules/auth/scopes';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  CONTRASENA_PRUEBA,
  crearUsuario,
  desactivar,
  desactivarUsuariosDePrueba,
  firmarToken,
  iniciarSesion,
} from './utils/auth';
import { crearApp } from './utils/crear-app';
import { RelojDePrueba } from './utils/reloj';
import { esperarProblemDetails } from './utils/problem-details';

/** Rutas que solo existen en la prueba, una por cada caso del guard. */
@Controller('prueba-auth')
class ControllerDePrueba {
  constructor(private readonly prisma: PrismaService) {}

  @Publico()
  @Get('publica')
  publica(@UsuarioActual() usuario?: UsuarioAutenticado) {
    return { usuario: usuario ?? null };
  }

  @Get('protegida')
  protegida(@UsuarioActual() usuario: UsuarioAutenticado) {
    return usuario;
  }

  @Scopes('flights:read')
  @Get('lectura')
  lectura() {
    return { ok: true };
  }

  @Scopes('flights:admin')
  @Get('admin')
  admin() {
    return { ok: true };
  }

  @Scopes('flights:book', 'flights:admin')
  @Get('varios')
  varios() {
    return { ok: true };
  }

  /** Lo que vería un trigger de auditoría dentro de una escritura de esta petición. */
  @Get('actor')
  actor() {
    return this.prisma.transaccionAuditada(async (tx) => {
      const [fila] = await tx.$queryRaw<Array<{ usuario: string; ip: string }>>`
        SELECT current_setting('app.id_usuario', true) AS usuario,
               current_setting('app.direccion_ip', true) AS ip`;
      return fila;
    });
  }
}

const PRUEBA = '/flights/v1/prueba-auth';
const UUID = '6f1c2a40-1111-4222-8333-944455556666';

describe('Autorización', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await crearApp([ControllerDePrueba]);
  });

  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  describe('JwtAuthGuard', () => {
    it('una ruta pública responde sin token', async () => {
      await http().get('/flights/v1/health').expect(200);
      const respuesta = await http().get(`${PRUEBA}/publica`).expect(200);
      expect(respuesta.body).toEqual({ usuario: null });
    });

    it('una ruta protegida sin token responde 401 con WWW-Authenticate: Bearer', async () => {
      const respuesta = await http().get(`${PRUEBA}/protegida`);

      expect(respuesta.status).toBe(401);
      esperarProblemDetails(respuesta);
      expect(respuesta.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'A bearer access token is required',
      });
      // Sin credenciales, RFC 6750 pide el desafío sin código de error
      expect(respuesta.headers['www-authenticate']).toBe('Bearer realm="quinde-vuelos-api"');
    });

    it.each([
      ['otro esquema', 'Basic dXN1YXJpbzpjbGF2ZQ=='],
      ['Bearer sin token', 'Bearer '],
      ['dos tokens', 'Bearer a.b.c d.e.f'],
    ])('%s cuenta como petición sin token', async (_caso, cabecera) => {
      const respuesta = await http().get(`${PRUEBA}/protegida`).set('Authorization', cabecera);
      expect(respuesta.status).toBe(401);
      expect(respuesta.headers['www-authenticate']).toBe('Bearer realm="quinde-vuelos-api"');
    });

    it('con un token válido deja pasar y entrega el usuario al controller', async () => {
      const usuario = await crearUsuario(app);
      const sesion = await iniciarSesion(app, usuario);

      const respuesta = await http()
        .get(`${PRUEBA}/protegida`)
        // El esquema no distingue mayúsculas (RFC 7235)
        .set('Authorization', `bearer ${sesion.access_token}`)
        .expect(200);

      expect(respuesta.body).toEqual({
        id: usuario.id,
        scopes: scopesDeRoles(['cliente']),
        idToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
    });

    it('el sub del token llega a app.id_usuario: la auditoría registra al usuario', async () => {
      const usuario = await crearUsuario(app);
      const sesion = await iniciarSesion(app, usuario);

      const respuesta = await http()
        .get(`${PRUEBA}/actor`)
        .set('Authorization', `Bearer ${sesion.access_token}`)
        .expect(200);

      expect(respuesta.body.usuario).toBe(usuario.id);
      expect(respuesta.body.ip).toMatch(/127\.0\.0\.1|::1/);
    });

    describe('tokens que se rechazan con 401 invalid_token', () => {
      const casos: Array<[string, (app: INestApplication) => string, string]> = [
        [
          'vencido',
          (a) => firmarToken(a, { scope: 'flights:read' }, { subject: UUID, expiresIn: -10 }),
          'The access token expired',
        ],
        [
          'con la firma manipulada (scope cambiado)',
          (a) => {
            const [cabecera, , firma] = firmarToken(
              a,
              { scope: 'flights:read' },
              { subject: UUID, expiresIn: 60 },
            ).split('.');
            const claims = Buffer.from(
              JSON.stringify({
                sub: UUID,
                scope: 'flights:admin',
                exp: 9999999999,
                iat: 1,
                jti: 'x',
              }),
            ).toString('base64url');
            return `${cabecera}.${claims}.${firma}`;
          },
          'The access token is invalid',
        ],
        [
          'firmado con otra clave',
          (a) =>
            firmarToken(
              a,
              { scope: 'flights:read' },
              { subject: UUID, expiresIn: 60, clave: 'otra-clave-de-al-menos-32-caracteres!!' },
            ),
          'The access token is invalid',
        ],
        [
          'con aud incorrecta',
          (a) =>
            firmarToken(a, { scope: '' }, { subject: UUID, expiresIn: 60, audience: 'otra-api' }),
          'The access token is invalid',
        ],
        [
          'con iss incorrecto',
          (a) =>
            firmarToken(a, { scope: '' }, { subject: UUID, expiresIn: 60, issuer: 'otro-idp' }),
          'The access token is invalid',
        ],
        [
          'con alg none',
          () =>
            [
              Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
              Buffer.from(JSON.stringify({ sub: UUID, scope: 'flights:admin' })).toString(
                'base64url',
              ),
              '',
            ].join('.'),
          'The access token is invalid',
        ],
        [
          'sin exp',
          (a) => firmarToken(a, { scope: '' }, { subject: UUID }),
          'The access token is invalid',
        ],
        [
          'con un sub que no es uuid',
          (a) => firmarToken(a, { scope: '' }, { subject: 'admin', expiresIn: 60 }),
          'The access token is invalid',
        ],
      ];

      it.each(casos)('%s', async (_caso, crearToken, detalle) => {
        const token = crearToken(app);
        const respuesta = await http()
          .get(`${PRUEBA}/protegida`)
          .set('Authorization', `Bearer ${token}`);

        expect(respuesta.status).toBe(401);
        esperarProblemDetails(respuesta);
        expect(respuesta.body.detail).toBe(detalle);
        expect(respuesta.headers['www-authenticate']).toBe(
          `Bearer realm="quinde-vuelos-api", error="invalid_token", error_description="${detalle}"`,
        );
        // El token nunca vuelve en la respuesta
        expect(JSON.stringify(respuesta.body)).not.toContain(token.split('.')[2] || token);
      });
    });

    it('un token emitido antes de desactivar la cuenta sigue sirviendo hasta que vence', async () => {
      // Límite conocido: el access token es un JWT sin estado (15 minutos). /auth/me y
      // /auth/refresh sí miran la base y lo rechazan.
      const usuario = await crearUsuario(app);
      const sesion = await iniciarSesion(app, usuario);
      await desactivar(app, usuario);

      await http()
        .get(`${PRUEBA}/protegida`)
        .set('Authorization', `Bearer ${sesion.access_token}`)
        .expect(200);
    });
  });

  describe('ScopesGuard', () => {
    let cliente: string;
    let administrador: string;

    beforeAll(async () => {
      cliente = (await iniciarSesion(app, await crearUsuario(app))).access_token;
      administrador = (await iniciarSesion(app, await crearUsuario(app, { administrador: true })))
        .access_token;
    });

    it('con el scope requerido deja pasar', async () => {
      await http().get(`${PRUEBA}/lectura`).set('Authorization', `Bearer ${cliente}`).expect(200);
      await http()
        .get(`${PRUEBA}/admin`)
        .set('Authorization', `Bearer ${administrador}`)
        .expect(200);
    });

    it('sin el scope responde 403 diciendo cuáles faltan', async () => {
      const respuesta = await http()
        .get(`${PRUEBA}/varios`)
        .set('Authorization', `Bearer ${cliente}`);

      expect(respuesta.status).toBe(403);
      esperarProblemDetails(respuesta);
      expect(respuesta.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'Missing required scopes: flights:admin',
      });
      expect(respuesta.headers['www-authenticate']).toBe(
        'Bearer realm="quinde-vuelos-api", error="insufficient_scope", ' +
          'error_description="Missing required scopes: flights:admin", ' +
          'scope="flights:book flights:admin"',
      );
    });

    it('un token sin scopes no entra a ninguna ruta con @Scopes', async () => {
      const token = firmarToken(app, { scope: '' }, { subject: UUID, expiresIn: 60 });
      const respuesta = await http()
        .get(`${PRUEBA}/lectura`)
        .set('Authorization', `Bearer ${token}`);
      expect(respuesta.status).toBe(403);
      expect(respuesta.body.detail).toBe('Missing required scopes: flights:read');
    });

    it('sin token, el 401 de JwtAuthGuard llega antes que el 403', async () => {
      await http().get(`${PRUEBA}/admin`).expect(401);
    });
  });

  describe('Swagger', () => {
    it('documenta @Scopes como el contrato y las rutas protegidas con bearer', async () => {
      const { body: documento } = await http().get('/api/docs-json').expect(200);

      expect(Object.keys(documento.components.securitySchemes)).toEqual([
        'bearer',
        'OAuth2Security',
      ]);
      expect(documento.paths[`${PRUEBA}/varios`].get.security).toEqual(
        expect.arrayContaining([
          { OAuth2Security: ['flights:book', 'flights:admin'] },
          { bearer: [] },
        ]),
      );
      expect(Object.keys(documento.paths[`${PRUEBA}/varios`].get.responses)).toEqual(
        expect.arrayContaining(['401', '403']),
      );
      expect(documento.paths['/flights/v1/auth/me'].get.security).toEqual([{ bearer: [] }]);
      expect(documento.paths['/flights/v1/auth/login'].post.security).toBeUndefined();
      expect(documento.tags.map((t: { name: string }) => t.name)).toContain('Auth');
    });
  });
});

describe('Límites de auth', () => {
  const anterior = process.env.RATE_LIMIT_MAX;
  afterEach(() => {
    if (anterior === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = anterior;
  });

  it('el login admite 5 intentos por minuto: los 401 cuentan y el sexto es 429', async () => {
    const app = await crearApp([], { reloj: new RelojDePrueba() });
    try {
      const usuario = await crearUsuario(app);
      const http = () => request(app.getHttpServer());

      for (let i = 0; i < 5; i++) {
        await http()
          .post('/flights/v1/auth/login')
          .send({ email: usuario.correo, password: 'contraseña equivocada!!' })
          .expect(401);
      }
      // Ni la contraseña correcta entra hasta que pase la ventana
      const sexto = await http()
        .post('/flights/v1/auth/login')
        .send({ email: usuario.correo, password: CONTRASENA_PRUEBA });

      expect(sexto.status).toBe(429);
      esperarProblemDetails(sexto);
      expect(sexto.body.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(Number(sexto.headers['retry-after'])).toBeGreaterThanOrEqual(1);

      // El contador es por ruta: el refresh sigue abierto
      await http()
        .post('/flights/v1/auth/refresh')
        .send({ refresh_token: 'A'.repeat(43) })
        .expect(401);
    } finally {
      await desactivarUsuariosDePrueba(app);
      await app.close();
    }
  });

  it('el 401 de una ruta protegida cuenta para el límite global; un 404 no', async () => {
    process.env.RATE_LIMIT_MAX = '3';
    const app = await crearApp([ControllerDePrueba], { reloj: new RelojDePrueba() });
    try {
      const http = () => request(app.getHttpServer());
      for (let i = 0; i < 3; i++) await http().get(`${PRUEBA}/protegida`).expect(401);
      await http().get('/flights/v1/ruta-que-no-existe').expect(404);

      // El límite es el primer guard: corta antes de mirar el token
      const excedida = await http().get(`${PRUEBA}/protegida`);
      expect(excedida.status).toBe(429);
      expect(excedida.body.code).toBe('RATE_LIMIT_EXCEEDED');
    } finally {
      await app.close();
    }
  });
});

describe('Ningún secreto en logs ni en respuestas', () => {
  it('las contraseñas y los tokens no aparecen en la salida de la API', async () => {
    const salida: string[] = [];
    const escribir = { out: process.stdout.write, err: process.stderr.write };
    // Se guarda lo que la API escribe y no se muestra, para no llenar la salida de Jest
    const capturar = (() => (trozo: string | Uint8Array) => {
      salida.push(String(trozo));
      return true;
    }) as () => typeof process.stdout.write;

    const app = await crearApp([], { logs: true });
    process.stdout.write = capturar();
    process.stderr.write = capturar();
    const respuestas: string[] = [];
    const tokens: string[] = [];
    try {
      const http = () => request(app.getHttpServer());
      const usuario = await crearUsuario(app);
      const sesion = await iniciarSesion(app, usuario);
      const rotado = await http()
        .post('/flights/v1/auth/refresh')
        .send({ refresh_token: sesion.refresh_token });
      tokens.push(sesion.access_token, sesion.refresh_token, rotado.body.refresh_token);

      respuestas.push(
        JSON.stringify(
          (
            await http()
              .post('/flights/v1/auth/login')
              .send({ email: usuario.correo, password: 'contraseña equivocada!!' })
          ).body,
        ),
        // Reutilización: deja un aviso en el log
        JSON.stringify(
          (
            await http()
              .post('/flights/v1/auth/refresh')
              .send({ refresh_token: sesion.refresh_token })
          ).body,
        ),
        JSON.stringify(
          (
            await http()
              .get('/flights/v1/auth/me')
              .set('Authorization', `Bearer ${sesion.access_token}x`)
          ).body,
        ),
        JSON.stringify(
          (
            await http()
              .post('/flights/v1/auth/register')
              .send({ email: 'x', password: 'pw-corta-7Q9' })
          ).body,
        ),
      );
    } finally {
      process.stdout.write = escribir.out;
      process.stderr.write = escribir.err;
      await desactivarUsuariosDePrueba(app);
      await app.close();
    }

    const todo = salida.join('') + respuestas.join('');
    expect(salida.join('')).toContain('Reutilización de un token de refresco');
    for (const secreto of [
      CONTRASENA_PRUEBA,
      'contraseña equivocada!!',
      'pw-corta-7Q9',
      ...tokens,
    ]) {
      expect(todo).not.toContain(secreto);
    }
  });
});

describe('JWT_SECRET en la validación del entorno', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    WEBHOOK_SECRET_KEY: 'k'.repeat(32),
    PORT: '3000',
    NODE_ENV: 'test',
  };

  it('es obligatoria y de al menos 32 caracteres', () => {
    expect(() => validarEntorno(base)).toThrow(/JWT_SECRET es obligatoria/);
    expect(() => validarEntorno({ ...base, JWT_SECRET: 'x'.repeat(31) })).toThrow(
      /al menos 32 caracteres/,
    );
    expect(() => validarEntorno({ ...base, JWT_SECRET: 'x'.repeat(32) })).not.toThrow();
  });

  it('JWT_ISSUER y JWT_AUDIENCE son opcionales y sin espacios', () => {
    const conClave = { ...base, JWT_SECRET: 'x'.repeat(32) };
    expect(() =>
      validarEntorno({ ...conClave, JWT_ISSUER: 'otro', JWT_AUDIENCE: 'api' }),
    ).not.toThrow();
    expect(() => validarEntorno({ ...conClave, JWT_ISSUER: 'con espacio' })).toThrow(/JWT_ISSUER/);
  });
});
