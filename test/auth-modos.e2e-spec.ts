import 'reflect-metadata';
import { Controller, Get, INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { validarEntorno } from '../src/config/entorno';
import { EMISOR_POR_DEFECTO } from '../src/modules/auth/seguridad/token-acceso.service';
import { crearApp } from './utils/crear-app';
import { IdentidadFalsa } from './utils/identidad-falsa';
import { RelojDePrueba } from './utils/reloj';

@Controller('prueba-auth-modos')
class ControllerDePrueba {
  @Get('protegida')
  protegida() {
    return { ok: true };
  }
}

describe('AUTH_MODE=local (sin la variable): los tokens del servicio de identidad no sirven', () => {
  const reloj = new RelojDePrueba();
  let app: INestApplication;
  let identidad: IdentidadFalsa;

  beforeAll(async () => {
    identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
    app = await crearApp([ControllerDePrueba], { reloj });
  });
  afterAll(async () => {
    await app.close();
    await identidad.detener();
  });

  it.each([
    ['con su emisor y su audiencia', {}],
    [
      'aunque traiga el iss y el aud de la API',
      { iss: EMISOR_POR_DEFECTO, aud: EMISOR_POR_DEFECTO },
    ],
  ])('un token RS256 %s es 401 y no se baja ningún JWKS', async (_caso, opciones) => {
    const respuesta = await request(app.getHttpServer())
      .get('/flights/v1/prueba-auth-modos/protegida')
      .set('Authorization', `Bearer ${identidad.firmar({ scope: 'flights:admin', ...opciones })}`);

    expect(respuesta.status).toBe(401);
    expect(respuesta.headers['www-authenticate']).toContain('error="invalid_token"');
    expect(identidad.descargas).toBe(0);
  });
});

describe('Validación del entorno de AUTH_MODE=external', () => {
  const base = {
    DATABASE_URL: 'postgresql://u@localhost:5432/booking_db',
    PORT: '3000',
    NODE_ENV: 'production',
    WEBHOOK_SECRET_KEY: 'w'.repeat(40),
  };
  const externo = {
    ...base,
    AUTH_MODE: 'external',
    JWT_ISSUER: 'https://identity.quinde.example',
    JWT_AUDIENCE: 'quinde-vuelos-api',
    BOARDING_PASS_SECRET: 'b'.repeat(40),
  };

  /** El mensaje de error, que nombra la variable y nunca trae el valor. */
  function errorCon(variables: Record<string, string | undefined>): string {
    try {
      validarEntorno(variables);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('validarEntorno aceptó la configuración');
  }

  it('con JWT_ISSUER, JWT_AUDIENCE y la clave de los pases arranca sin JWT_SECRET', () => {
    expect(() => validarEntorno(externo)).not.toThrow();
  });

  it.each<[string, Record<string, string | undefined>, string, string | undefined]>([
    ['sin JWT_ISSUER', { JWT_ISSUER: undefined }, 'JWT_ISSUER es obligatoria', undefined],
    ['sin JWT_AUDIENCE', { JWT_AUDIENCE: undefined }, 'JWT_AUDIENCE es obligatoria', undefined],
    [
      'con un JWT_ISSUER con ruta',
      { JWT_ISSUER: 'https://identity.quinde.example/realms/secreto-x' },
      'JWT_ISSUER debe ser',
      'secreto-x',
    ],
    [
      'con un JWT_ISSUER http en producción',
      { JWT_ISSUER: 'http://identity-secreto.quinde.example' },
      'https con NODE_ENV=production',
      'identity-secreto',
    ],
    [
      'con un JWKS_URL con usuario y clave',
      { JWKS_URL: 'https://yo:clave-secreta@identity.quinde.example/jwks' },
      'JWKS_URL debe ser',
      'clave-secreta',
    ],
    [
      'con un AUTH_MODE desconocido',
      { AUTH_MODE: 'oidc-secreto' },
      'AUTH_MODE debe ser uno de',
      'oidc-secreto',
    ],
    [
      'sin JWT_SECRET ni BOARDING_PASS_SECRET',
      { BOARDING_PASS_SECRET: undefined },
      'BOARDING_PASS_SECRET es obligatoria con AUTH_MODE=external',
      undefined,
    ],
  ])(
    '%s no arranca y el mensaje nombra la variable, no su valor',
    (_caso, cambios, mensaje, valor) => {
      const texto = errorCon({ ...externo, ...cambios });
      expect(texto).toContain(mensaje);
      if (valor) expect(texto).not.toContain(valor);
    },
  );

  it('JWT_ISSUER http vale fuera de producción (verificación local)', () => {
    expect(() =>
      validarEntorno({ ...externo, NODE_ENV: 'development', JWT_ISSUER: 'http://localhost:3001' }),
    ).not.toThrow();
  });

  it('en local, JWT_SECRET sigue siendo obligatoria', () => {
    expect(errorCon(base)).toContain('JWT_SECRET es obligatoria con AUTH_MODE=local');
  });
});
