import { Controller, Get, INestApplication, LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { Scopes } from '../src/common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../src/common/decorators/usuario-actual.decorator';
import { EMISOR_POR_DEFECTO } from '../src/modules/auth/seguridad/token-acceso.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { CadenaBusqueda } from './utils/busqueda';
import type { AppCatalogo } from './utils/catalogo';
import { AUDIENCIA, IdentidadFalsa, nuevaClave, OpcionesToken } from './utils/identidad-falsa';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

/**
 * AUTH_MODE=external: la API verifica los tokens RS256 de un servicio de identidad por su JWKS
 * (aquí, IdentidadFalsa). La configuración se valida al importar AppModule, así que las
 * variables se fijan antes y todo lo que importa AppModule (crear-app, catalogo, busqueda,
 * reserva) se importa después, dentro de beforeAll.
 */

/** Rutas que solo existen en la prueba. */
@Controller('prueba-auth-externa')
class ControllerDePrueba {
  constructor(private readonly prisma: PrismaService) {}

  @Get('yo')
  yo(@UsuarioActual() usuario: UsuarioAutenticado) {
    return usuario;
  }

  @Scopes('flights:read')
  @Get('lectura')
  lectura() {
    return { ok: true };
  }

  /** Lo que vería un trigger de auditoría dentro de una escritura de esta petición. */
  @Get('actor')
  actor() {
    return this.prisma.transaccionAuditada(async (tx) => {
      const [fila] = await tx.$queryRaw<Array<{ usuario: string }>>`
        SELECT current_setting('app.id_usuario', true) AS usuario`;
      return fila;
    });
  }
}

/** Todo lo que la API escribe en el log mientras corre este archivo, para revisarlo al final. */
class LogEnMemoria implements LoggerService {
  readonly lineas: string[] = [];
  log(mensaje: unknown, ...resto: unknown[]) {
    this.guardar('LOG', mensaje, resto);
  }
  warn(mensaje: unknown, ...resto: unknown[]) {
    this.guardar('WARN', mensaje, resto);
  }
  error(mensaje: unknown, ...resto: unknown[]) {
    this.guardar('ERROR', mensaje, resto);
  }
  debug(mensaje: unknown, ...resto: unknown[]) {
    this.guardar('DEBUG', mensaje, resto);
  }
  verbose(mensaje: unknown, ...resto: unknown[]) {
    this.guardar('VERBOSE', mensaje, resto);
  }
  texto(): string {
    return this.lineas.join('\n');
  }
  private guardar(nivel: string, mensaje: unknown, resto: unknown[]) {
    const extra = resto.map((r) => (r instanceof Error ? `${r.message} ${r.stack}` : String(r)));
    this.lineas.push([nivel, String(mensaje), ...extra].join(' '));
  }
}

const PRUEBA = '/flights/v1/prueba-auth-externa';
const DESAFIO_INVALIDO = (detalle: string) =>
  `Bearer realm="quinde-vuelos-api", error="invalid_token", error_description="${detalle}"`;

const reloj = new RelojDePrueba();
const limites = new LimitesReiniciables();
const log = new LogEnMemoria();
/** Todo token armado en este archivo: ninguno puede aparecer en el log ni en la auditoría. */
const emitidos: string[] = [];
const inicio = new Date();

let identidad: IdentidadFalsa;
let crearApp: typeof import('./utils/crear-app').crearApp;
const entornoAnterior: Record<string, string | undefined> = {};

function token(opciones: OpcionesToken = {}): string {
  const firmado = identidad.firmar(opciones);
  emitidos.push(firmado);
  return firmado;
}

function claimsDe(firmado: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(firmado.split('.')[1], 'base64url').toString());
}

async function appExterna(): Promise<INestApplication> {
  const app = await crearApp([ControllerDePrueba], { reloj, limites });
  app.useLogger(log);
  return app;
}

/** Adelanta el reloj de la prueba en segundos (RelojDePrueba cuenta en minutos). */
const adelantar = (segundos: number) => reloj.adelantar(segundos / 60);

beforeAll(async () => {
  identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
  const entorno = {
    AUTH_MODE: 'external',
    JWT_ISSUER: identidad.emisor,
    JWT_AUDIENCE: AUDIENCIA,
    RATE_LIMIT_MAX: '100000',
  };
  for (const [nombre, valor] of Object.entries(entorno)) {
    entornoAnterior[nombre] = process.env[nombre];
    process.env[nombre] = valor;
  }
  ({ crearApp } = await import('./utils/crear-app'));
});

afterAll(async () => {
  await identidad.detener();
  for (const [nombre, valor] of Object.entries(entornoAnterior)) {
    if (valor === undefined) delete process.env[nombre];
    else process.env[nombre] = valor;
  }
});

describe('AUTH_MODE=external: tokens del servicio de identidad', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await identidad.reiniciar();
    reloj.alPresente();
    app = await appExterna();
  });
  afterAll(() => app.close());
  beforeEach(() => limites.reiniciar());

  it('el token de una persona llega al controller con su sub, sus scopes y su jti', async () => {
    const sub = randomUUID();
    const firmado = token({ sub, scope: 'flights:read flights:hold' });

    const respuesta = await http().get(`${PRUEBA}/yo`).set('Authorization', `Bearer ${firmado}`);

    expect(respuesta.status).toBe(200);
    // Sin clienteId: solo lo llevan los tokens de un cliente máquina a máquina
    expect(respuesta.body).toEqual({
      id: sub,
      scopes: ['flights:read', 'flights:hold'],
      idToken: claimsDe(firmado).jti,
    });
  });

  it('el de un cliente máquina a máquina trae su client_id; la auditoría guarda su sub', async () => {
    const sub = randomUUID();
    const firmado = token({ sub, clientId: 'cli-bff-vuelos', scope: 'flights:read' });

    const yo = await http().get(`${PRUEBA}/yo`).set('Authorization', `Bearer ${firmado}`);
    const actor = await http().get(`${PRUEBA}/actor`).set('Authorization', `Bearer ${firmado}`);

    expect(yo.status).toBe(200);
    expect(yo.body).toEqual({
      id: sub,
      scopes: ['flights:read'],
      idToken: claimsDe(firmado).jti,
      clienteId: 'cli-bff-vuelos',
    });
    expect(actor.body).toEqual({ usuario: sub });
    // La línea de acceso de /yo (ya escrita: /actor se pidió después)
    expect(log.texto()).toMatch(
      new RegExp(`GET ${PRUEBA}/yo 200 .* user=${sub} client=cli-bff-vuelos`),
    );
  });

  it('un scope que la API no conoce se ignora y se avisa una sola vez', async () => {
    for (let i = 0; i < 2; i++) {
      const respuesta = await http()
        .get(`${PRUEBA}/yo`)
        .set('Authorization', `Bearer ${token({ scope: 'flights:read flights:teleport' })}`)
        .expect(200);
      expect(respuesta.body.scopes).toEqual(['flights:read']);
    }
    const avisos = log.lineas.filter((l) => l.includes('Scope desconocido'));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('flights:teleport (se ignora)');
  });

  it('los scopes salen del token: sin flights:book, POST /bookings es 403 insufficient_scope', async () => {
    const firmado = token({ clientId: 'cli-solo-hold', scope: 'flights:read flights:hold' });

    const respuesta = await http()
      .post('/flights/v1/bookings')
      .set('Authorization', `Bearer ${firmado}`)
      .send({});

    expect(respuesta.status).toBe(403);
    esperarProblemDetails(respuesta);
    expect(respuesta.headers['www-authenticate']).toBe(
      'Bearer realm="quinde-vuelos-api", error="insufficient_scope", ' +
        'error_description="Missing required scopes: flights:book", scope="flights:book"',
    );
  });

  it('las rutas públicas no piden token', async () => {
    await http().get('/flights/v1/health').expect(200);
  });

  it('tolera 30 s de diferencia de reloj en exp, no más', async () => {
    const casi = token({ venceEn: -20 });
    const vencido = token({ venceEn: -40 });
    await http().get(`${PRUEBA}/yo`).set('Authorization', `Bearer ${casi}`).expect(200);
    const respuesta = await http().get(`${PRUEBA}/yo`).set('Authorization', `Bearer ${vencido}`);
    expect(respuesta.status).toBe(401);
    expect(respuesta.headers['www-authenticate']).toBe(
      DESAFIO_INVALIDO('The access token expired'),
    );
  });

  it('el JWKS se bajó una sola vez para todas esas peticiones', () => {
    expect(identidad.descargas).toBe(1);
  });

  describe('un token falso o manipulado es 401 invalid_token, nunca 200', () => {
    const alterarScope = (firmado: string, scope: string) => {
      const [cabecera, , firma] = firmado.split('.');
      const claims = { ...claimsDe(firmado), scope };
      return `${cabecera}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${firma}`;
    };
    const ahora = () => Math.floor(reloj.ahora().getTime() / 1000);
    const secretoLocal = () => app.get(ConfigService).getOrThrow<string>('JWT_SECRET');

    const casos: Array<[string, () => string]> = [
      ['alg none', () => token({ sinFirma: true })],
      [
        'HS256 firmado con la clave pública (PEM) como secreto',
        () => token({ secretoHs256: identidad.claveActual.pem }),
      ],
      ['alg PS256 en la cabecera', () => token({ alg: 'PS256' })],
      ['un kid que el JWKS no tiene', () => token({ clave: nuevaClave() })],
      [
        'el kid de la clave real con la firma de otra',
        () => token({ clave: nuevaClave(), kid: identidad.claveActual.kid }),
      ],
      ['sin kid', () => token({ kid: null })],
      ['vencido', () => token({ venceEn: -3600 })],
      ['con nbf en el futuro', () => token({ claims: { nbf: ahora() + 3600 } })],
      ['de otro emisor', () => token({ iss: 'https://identity.otro.example' })],
      ['del emisor con barra final', () => token({ iss: `${identidad.emisor}/` })],
      ['para otra audiencia', () => token({ aud: 'otra-api' })],
      ['sin exp', () => token({ sin: ['exp'] })],
      ['sin iat', () => token({ sin: ['iat'] })],
      ['sin jti', () => token({ sin: ['jti'] })],
      ['con jti vacío', () => token({ claims: { jti: '' } })],
      ['sin sub', () => token({ sin: ['sub'] })],
      ['sin iss', () => token({ sin: ['iss'] })],
      ['sin aud', () => token({ sin: ['aud'] })],
      ['typ JWT', () => token({ typ: 'JWT' })],
      ['sin typ', () => token({ typ: null })],
      [
        'con el scope cambiado después de firmar',
        () => alterarScope(token({ scope: 'flights:read' }), 'flights:read flights:admin'),
      ],
      ['con un sub que no es uuid', () => token({ sub: 'admin' })],
      ['con el scope en una lista', () => token({ scope: ['flights:admin'] })],
      ['con un client_id que no es texto', () => token({ clientId: 42 })],
      [
        'HS256 del modo local (JWT_SECRET)',
        () => {
          const firmado = jwt.sign({ scope: 'flights:admin' }, secretoLocal(), {
            algorithm: 'HS256',
            subject: randomUUID(),
            issuer: EMISOR_POR_DEFECTO,
            audience: EMISOR_POR_DEFECTO,
            jwtid: randomUUID(),
            expiresIn: 900,
          });
          emitidos.push(firmado);
          return firmado;
        },
      ],
      [
        'HS256 con JWT_SECRET y los claims y la cabecera del servicio de identidad',
        () => token({ secretoHs256: secretoLocal(), scope: 'flights:admin' }),
      ],
      ['que no es un JWT', () => 'no-es-un-jwt'],
    ];

    it.each(casos)('%s', async (_caso, crear) => {
      const firmado = crear();
      const respuesta = await http().get(`${PRUEBA}/yo`).set('Authorization', `Bearer ${firmado}`);

      expect(respuesta.status).toBe(401);
      esperarProblemDetails(respuesta);
      expect(respuesta.headers['www-authenticate']).toMatch(
        /^Bearer realm=.*error="invalid_token"/,
      );
      expect(JSON.stringify(respuesta.body)).not.toContain(firmado.split('.')[2] || firmado);
    });

    it('el log dice el motivo y el kid de cada rechazo', () => {
      const texto = log.texto();
      for (const motivo of [
        'alg-no-permitido',
        'kid-desconocido',
        'firma-invalida',
        'iss-check_failed',
        'aud-check_failed',
        'exp-missing',
        'typ-check_failed',
        'sub-no-uuid',
        'scope-no-texto',
        'client_id-invalido',
      ]) {
        expect(texto).toContain(`Token rechazado: ${motivo} (kid `);
      }
      expect(texto).toContain(`(kid ${identidad.claveActual.kid})`);
    });
  });
});

describe('AUTH_MODE=external: retenciones y reservas de un cliente máquina a máquina', () => {
  const subCliente = randomUUID();
  const scopesCliente = 'flights:read flights:hold flights:book flights:cancel';
  let c: AppCatalogo;
  let k: CadenaBusqueda;
  let tokenCliente: string;
  let tokenOtro: string;
  let utilidades: typeof import('./utils/reserva') & typeof import('./utils/busqueda');

  beforeAll(async () => {
    await identidad.reiniciar();
    reloj.alPresente();
    const [reserva, busqueda, catalogo] = await Promise.all([
      import('./utils/reserva'),
      import('./utils/busqueda'),
      import('./utils/catalogo'),
    ]);
    const { ADMIN } = catalogo;
    utilidades = { ...reserva, ...busqueda };

    const app = await appExterna();
    // Un administrador del servicio de identidad: el core no tiene su cuenta
    const tokenAdmin = token({ scope: 'flights:admin' });
    const peticion =
      (firmado?: string) =>
      (metodo: 'get' | 'post' | 'patch' | 'delete', ruta: string, cuerpo?: object) => {
        let prueba = request(app.getHttpServer())[metodo](ruta);
        if (firmado) prueba = prueba.set('Authorization', `Bearer ${firmado}`);
        return cuerpo === undefined ? prueba : prueba.send(cuerpo);
      };
    c = {
      app,
      prisma: app.get(PrismaService),
      admin: peticion(tokenAdmin),
      cliente: peticion(token({ scope: 'flights:read' })),
      anonimo: peticion(),
      idAdmin: claimsDe(tokenAdmin).sub as string,
      cerrar: () => app.close(),
    };
    k = await busqueda.crearCadena(c);
    await c
      .admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, {
        ticketPrefix: await catalogo.codigos.prefijoBoleto(c.prisma),
      })
      .expect(200);
    await c
      .admin('patch', `${ADMIN}/departures/${k.salida}`, {
        cabins: [{ cabinClass: 'ECONOMY', totalSeats: 6 }],
      })
      .expect(200);

    tokenCliente = token({ sub: subCliente, clientId: 'cli-agencia-e2e', scope: scopesCliente });
    tokenOtro = token({ scope: scopesCliente });
  });

  afterAll(async () => {
    reloj.alPresente();
    const { cancelarReservasDe } = await import('./utils/postventa');
    const { ADMIN } = await import('./utils/catalogo');
    await cancelarReservasDe(c.app, tokenCliente);
    await c.admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: null });
    await utilidades.darDeBajaCadena(c, k);
    await c.cerrar();
  });
  beforeEach(() => limites.reiniciar());

  it('su hold y su reserva son suyos: él los ve, otro recibe 404', async () => {
    const { buscarYRetener, con, cuerpoReserva, pasajero, reservar, HOLD, RESERVAS } = utilidades;
    const retenido = await buscarYRetener(c.app, tokenCliente, [[k.origen, k.destino, k.fecha]], {
      adults: 1,
    });

    await con(c.app, tokenCliente)('get', `${HOLD}/${retenido.holdId}`).expect(200);
    await con(c.app, tokenOtro)('get', `${HOLD}/${retenido.holdId}`).expect(404);
    const hold = await c.prisma.db.retencion_cabecera.findUniqueOrThrow({
      where: { id: retenido.holdId },
    });
    expect(hold.id_propietario).toBe(subCliente);

    const reserva = (
      await reservar(
        c.app,
        tokenCliente,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]),
      ).expect(201)
    ).body as { bookingId: string };

    await con(c.app, tokenCliente)('get', `${RESERVAS}/${reserva.bookingId}`).expect(200);
    await con(c.app, tokenOtro)('get', `${RESERVAS}/${reserva.bookingId}`).expect(404);
    const deOtro = await con(c.app, tokenOtro)('get', RESERVAS).expect(200);
    expect(deOtro.body.items).toEqual([]);

    // La auditoría del hold lleva el sub del cliente (su id en el servicio de identidad)
    const [auditoria] = await c.prisma.db.$queryRaw<Array<{ id_usuario: string }>>`
      SELECT id_usuario FROM vuelos.auditoria
       WHERE nombre_tabla = 'retencion_cabecera' AND id_registro = ${retenido.holdId}
         AND operacion::text = 'INSERCION'`;
    expect(auditoria.id_usuario).toBe(subCliente);
  });
});

describe('AUTH_MODE=external: el core ya no es emisor', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await identidad.reiniciar();
    reloj.alPresente();
    app = await appExterna();
  });
  afterAll(() => app.close());

  it.each([
    ['post', '/flights/v1/auth/register'],
    ['post', '/flights/v1/auth/login'],
    ['post', '/flights/v1/auth/refresh'],
    ['post', '/flights/v1/auth/logout'],
    ['get', '/flights/v1/auth/me'],
    ['get', '/flights/v1/admin/users'],
    ['post', '/flights/v1/admin/users'],
  ] as const)('%s %s no existe: 404 problem+json', async (metodo, ruta) => {
    const respuesta = await http()
      [metodo](ruta)
      .set('Authorization', `Bearer ${token({ scope: 'flights:admin' })}`)
      .send({});
    expect(respuesta.status).toBe(404);
    esperarProblemDetails(respuesta);
  });

  it('Swagger no muestra /auth ni /admin/users, y el esquema bearer sigue', async () => {
    const documento = (await http().get('/api/docs-json').expect(200)).body as {
      paths: Record<string, unknown>;
      tags: Array<{ name: string }>;
      components: { securitySchemes: Record<string, { description?: string }> };
    };
    const rutas = Object.keys(documento.paths);
    expect(rutas.filter((r) => /\/auth\/|\/admin\/users/.test(r))).toEqual([]);
    expect(rutas).toContain('/flights/v1/admin/audit-log');
    const etiquetas = documento.tags.map((t) => t.name);
    expect(etiquetas).not.toContain('Auth');
    expect(etiquetas).not.toContain('Admin · Administradores');
    expect(documento.components.securitySchemes.bearer.description).toContain(identidad.emisor);
  });
});

describe('AUTH_MODE=external: el JWKS caído, lento o rotado', () => {
  let app: INestApplication | undefined;
  const http = () => request(app!.getHttpServer());
  const pedir = (firmado: string) =>
    http().get(`${PRUEBA}/yo`).set('Authorization', `Bearer ${firmado}`);

  /** Cada caso, con una app nueva: sin copia del JWKS. */
  beforeEach(async () => {
    await identidad.reiniciar();
    reloj.alPresente();
    limites.reiniciar();
    app = await appExterna();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function esperar503(respuesta: request.Response) {
    expect(respuesta.status).toBe(503);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.code).toBe('AUTH_UNAVAILABLE');
    expect(Number(respuesta.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(respuesta.headers['retry-after'])).toBeLessThanOrEqual(10);
  }

  it('con una copia vigente, un corte del servicio de identidad no se nota', async () => {
    const firmado = token();
    await pedir(firmado).expect(200);
    await identidad.caer();

    for (let i = 0; i < 20; i++) await pedir(firmado).expect(200);
    adelantar(240);
    await pedir(token()).expect(200);
    expect(identidad.descargas).toBe(1);
  });

  it('una copia vencida no se usa: sin servicio es 503 hasta que vuelve', async () => {
    await pedir(token()).expect(200);
    await identidad.caer();
    adelantar(301);

    esperar503(await pedir(token()));

    await identidad.levantar();
    adelantar(11);
    await pedir(token()).expect(200);
  });

  it('sin copia y sin servicio: 503 AUTH_UNAVAILABLE con Retry-After, nunca 200 ni 401', async () => {
    await identidad.caer();

    for (const firmado of [token(), token({ venceEn: -3600 }), token({ clave: nuevaClave() })]) {
      esperar503(await pedir(firmado));
    }
    // Lo que ni siquiera es un JWT, o no trae kid, se rechaza sin pedir claves: sigue en 401
    expect((await pedir('no-es-un-jwt')).status).toBe(401);
    expect((await pedir(token({ kid: null }))).status).toBe(401);
    expect(log.texto()).toContain(
      'No se pudo bajar el JWKS (ECONNREFUSED); no hay una copia vigente',
    );
  });

  it('un JWKS que responde 500 no se pide en cada petición: se espera el enfriamiento', async () => {
    identidad.fallar();
    for (let i = 0; i < 20; i++) esperar503(await pedir(token()));
    expect(identidad.descargas).toBe(1);

    adelantar(11);
    esperar503(await pedir(token()));
    expect(identidad.descargas).toBe(2);

    await identidad.levantar();
    adelantar(11);
    await pedir(token()).expect(200);
    expect(identidad.descargas).toBe(3);
  });

  it('un JWKS lento se corta a los 3 s con 503, no deja la petición colgada', async () => {
    identidad.tardar(6000);
    const antes = Date.now();
    esperar503(await pedir(token()));
    const demora = Date.now() - antes;
    expect(demora).toBeGreaterThanOrEqual(2900);
    expect(demora).toBeLessThan(5000);
    expect(log.texto()).toContain('No se pudo bajar el JWKS (más de 3000 ms)');
  });

  it('rotación: la clave nueva se descubre sola y la quitada deja de valer al vencer la copia', async () => {
    const vieja = identidad.claveActual;
    const conVieja = token();
    await pedir(conVieja).expect(200);

    identidad.rotar();
    adelantar(11);
    const conNueva = token();
    await pedir(conNueva).expect(200);
    await pedir(conVieja).expect(200);
    expect(identidad.descargas).toBe(2);

    identidad.quitar(vieja);
    adelantar(240);
    await pedir(conVieja).expect(200);
    adelantar(120);
    expect((await pedir(conVieja)).status).toBe(401);
    await pedir(conNueva).expect(200);
    expect(identidad.descargas).toBe(3);
  });

  it('100 tokens con kid inventados provocan a lo sumo una descarga más', async () => {
    await pedir(token()).expect(200);
    adelantar(11);

    for (let i = 0; i < 100; i++) {
      expect((await pedir(token({ kid: `kid-inventado-${i}` }))).status).toBe(401);
    }
    expect(identidad.descargas).toBeLessThanOrEqual(2);
  });

  it('un JWKS sin claves no deja pasar a nadie: 401', async () => {
    const firmado = token();
    identidad.vaciar();
    expect((await pedir(firmado)).status).toBe(401);
  });
});

describe('AUTH_MODE=external: nada sensible en el log ni en la auditoría', () => {
  const sensibles = () => [
    ...emitidos.flatMap((t) => [t, t.split('.')[2]].filter((s) => s && s.length > 20)),
    ...identidad.publicadas.map((c) => c.jwk.n),
    'BEGIN PUBLIC KEY',
    '$argon2',
  ];

  it('ningún token, firma ni clave del JWKS aparece en el log', () => {
    expect(emitidos.length).toBeGreaterThan(100);
    const texto = log.texto();
    expect(texto).toContain('JWKS descargado: 1 claves (kid ');
    for (const sensible of sensibles()) expect(texto).not.toContain(sensible);
  });

  it('ni en las filas de auditoría que dejó este archivo', async () => {
    const app = await appExterna();
    try {
      const filas = await app.get(PrismaService).db.$queryRaw<Array<{ fila: string }>>`
        SELECT row_to_json(a)::text AS fila FROM vuelos.auditoria a WHERE fecha_evento >= ${inicio}`;
      expect(filas.length).toBeGreaterThan(0);
      const texto = filas.map((f) => f.fila).join('\n');
      for (const sensible of sensibles()) expect(texto).not.toContain(sensible);
    } finally {
      await app.close();
    }
  });
});
