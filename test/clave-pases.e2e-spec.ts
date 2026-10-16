import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { validarEntorno } from '../src/config/entorno';
import {
  CodigoPase,
  DatosCodigo,
} from '../src/modules/vuelos/operaciones/pase-abordar/codigo-pase';

/**
 * La clave de los códigos de barras de los pases sale de BOARDING_PASS_SECRET o, si no está, de
 * JWT_SECRET, con la misma derivación de siempre: un pase emitido con JWT_SECRET sigue
 * verificando cuando ese valor pasa a BOARDING_PASS_SECRET (para quitar JWT_SECRET con
 * AUTH_MODE=external).
 */

const SECRETO = 'secreto-de-prueba-de-los-pases-0123456789';
const OTRO = 'otro-secreto-de-prueba-de-los-pases-98765';

const DATOS: DatosCodigo = {
  pnr: 'ABC234',
  numeroBoleto: '0451234567890',
  numeroVuelo: 'LA1400',
  fechaSalida: new Date('2026-10-22T00:00:00.000Z'),
  origen: 'UIO',
  destino: 'GYE',
  asiento: '12A',
  secuencia: 1,
};

/** Un ConfigService con solo estas variables (no lee process.env). */
function config(valores: Record<string, string>): ConfigService {
  return {
    get: (clave: string) => valores[clave],
    getOrThrow: (clave: string) => {
      if (valores[clave] === undefined) throw new Error(`falta ${clave}`);
      return valores[clave];
    },
  } as unknown as ConfigService;
}

/** La fórmula original (antes de BOARDING_PASS_SECRET), escrita aparte de CodigoPase. */
function codigoComoAntes(secretoJwt: string, datos: DatosCodigo): string {
  const clave = createHmac('sha256', secretoJwt)
    .update('quinde-vuelos:codigo-pase-abordar')
    .digest();
  const cuerpo = 'BP1|ABC234|0451234567890|LA1400|20261022|UIOGYE|12A|001';
  expect(datos.pnr).toBe('ABC234');
  return `${cuerpo}|${createHmac('sha256', clave).update(cuerpo).digest('hex').slice(0, 12)}`;
}

describe('Clave de los códigos de los pases de abordar', () => {
  it('sin BOARDING_PASS_SECRET usa JWT_SECRET con la fórmula de siempre', () => {
    const pase = new CodigoPase(config({ JWT_SECRET: SECRETO }));
    expect(pase.generar(DATOS)).toBe(codigoComoAntes(SECRETO, DATOS));
  });

  it('un pase emitido con JWT_SECRET verifica con BOARDING_PASS_SECRET del mismo valor y sin JWT_SECRET', () => {
    const emitido = codigoComoAntes(SECRETO, DATOS);
    const pase = new CodigoPase(config({ BOARDING_PASS_SECRET: SECRETO }));
    expect(pase.verificar(emitido)).toMatchObject({ pnr: 'ABC234', asiento: '12A' });
    expect(pase.generar(DATOS)).toBe(emitido);
  });

  it('BOARDING_PASS_SECRET manda sobre JWT_SECRET; con otro valor, un pase anterior no verifica', () => {
    const emitido = codigoComoAntes(SECRETO, DATOS);
    const pase = new CodigoPase(config({ BOARDING_PASS_SECRET: OTRO, JWT_SECRET: SECRETO }));
    expect(pase.verificar(emitido)).toBeNull();
    expect(pase.generar(DATOS)).toBe(codigoComoAntes(OTRO, DATOS));
  });

  describe('validación del entorno', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      WEBHOOK_SECRET_KEY: 'k'.repeat(32),
      JWT_SECRET: 'j'.repeat(32),
      PORT: '3000',
      NODE_ENV: 'test',
    };

    it('es opcional; vacía cuenta como no definida', () => {
      expect(() => validarEntorno(base)).not.toThrow();
      expect(() => validarEntorno({ ...base, BOARDING_PASS_SECRET: '' })).not.toThrow();
      expect(() => validarEntorno({ ...base, BOARDING_PASS_SECRET: 'p'.repeat(32) })).not.toThrow();
    });

    it('si se define, al menos 32 caracteres; el error nombra la variable y no su valor', () => {
      const corta = 'valor-corto-que-no-debe-aparecer';
      expect(corta.length).toBeLessThan(33);
      let mensaje = '';
      try {
        validarEntorno({ ...base, BOARDING_PASS_SECRET: corta.slice(0, 31) });
      } catch (error) {
        mensaje = (error as Error).message;
      }
      expect(mensaje).toMatch(/BOARDING_PASS_SECRET debe tener al menos 32 caracteres/);
      expect(mensaje).not.toContain(corta.slice(0, 31));
    });
  });
});
