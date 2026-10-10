import 'reflect-metadata';
import {
  censurar,
  CLAVES_SENSIBLES,
  esClaveSensible,
  VALOR_CENSURADO,
  ValorJson,
} from '../src/modules/vuelos/administracion/auditoria/censura';
import { aEventoAuditoria } from '../src/modules/vuelos/administracion/auditoria/auditoria.mapper';

// Piezas puras de la auditoría, sin la API ni la base (el runner solo corre test/*.e2e-spec.ts).

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.firmafirmafirma';

describe('censura de la auditoría', () => {
  it('la lista incluye al menos las claves que exige la política', () => {
    for (const clave of [
      'hash_contrasena',
      'password',
      'contrasena',
      'hash_token',
      'token',
      'refresh',
      'secret',
      'secreto',
      'authorization',
    ]) {
      expect(CLAVES_SENSIBLES).toContain(clave);
    }
  });

  it('censura la clave sensible, sin importar mayúsculas ni prefijos y sufijos', () => {
    for (const clave of [
      'hash_contrasena',
      'HASH_CONTRASENA',
      'password',
      'newPassword',
      'access_token',
      'refresh_token',
      'hash_token',
      'client_secret',
      'secreto',
      'Authorization',
    ]) {
      expect(esClaveSensible(clave)).toBe(true);
      expect(censurar({ [clave]: 'valor-privado' })).toEqual({ [clave]: VALOR_CENSURADO });
    }
  });

  it('deja intactas las columnas comunes', () => {
    const fila = { id: 'x', correo: 'a@b.ec', activo: true, total: 12.5, nota: null };
    expect(censurar(fila)).toEqual(fila);
    expect(esClaveSensible('correo')).toBe(false);
    expect(esClaveSensible('fecha_creacion')).toBe(false);
  });

  it('baja recursivamente por objetos y arreglos', () => {
    const entrada: ValorJson = {
      a: { b: { c: { secreto: 's1', ok: 1 } } },
      lista: [{ token: 't1' }, [{ password: 'p1' }], 'texto'],
    };
    expect(censurar(entrada)).toEqual({
      a: { b: { c: { secreto: VALOR_CENSURADO, ok: 1 } } },
      lista: [{ token: VALOR_CENSURADO }, [{ password: VALOR_CENSURADO }], 'texto'],
    });
  });

  it('censura también un objeto o un arreglo completo bajo una clave sensible', () => {
    expect(censurar({ token: { access: 'a', refresh: 'b' }, secret: ['x'] })).toEqual({
      token: VALOR_CENSURADO,
      secret: VALOR_CENSURADO,
    });
  });

  it('censura un hash argon2 o un JWT aunque su clave no lo diga', () => {
    expect(censurar({ campo_raro: HASH, otro: JWT, nota: 'hola' })).toEqual({
      campo_raro: VALOR_CENSURADO,
      otro: VALOR_CENSURADO,
      nota: 'hola',
    });
  });

  it('no modifica el original', () => {
    const original = { hash_contrasena: HASH, anidado: { token: 'x' } };
    const copia = JSON.stringify(original);
    censurar(original);
    expect(JSON.stringify(original)).toBe(copia);
  });

  it('un JSON demasiado profundo se censura entero en vez de desbordar la pila', () => {
    let profundo: ValorJson = 'fin';
    for (let i = 0; i < 100; i++) profundo = { n: profundo };
    expect(JSON.stringify(censurar(profundo))).toContain(VALOR_CENSURADO);
  });

  it('un evento de la tabla usuario nunca saca el hash, aunque el disparador no lo enmascarara', () => {
    const evento = aEventoAuditoria({
      id: 7n,
      fecha: new Date('2026-10-01T12:00:00Z'),
      tabla: 'usuario',
      operacion: 'INSERCION',
      idRegistro: 'u1',
      idUsuario: 'admin-1',
      direccionIp: '203.0.113.7',
      anteriores: null,
      nuevos: { id: 'u1', correo: 'ana@example.com', hash_contrasena: HASH, activo: true },
    });
    expect(evento).toMatchObject({
      id: '7',
      occurredAt: '2026-10-01T12:00:00.000Z',
      table: 'usuario',
      operation: 'INSERT',
      recordId: 'u1',
      userId: 'admin-1',
      ipAddress: '203.0.113.7',
      before: null,
      after: {
        id: 'u1',
        correo: 'ana@example.com',
        hash_contrasena: VALOR_CENSURADO,
        activo: true,
      },
    });
    expect(JSON.stringify(evento)).not.toContain('argon2');
  });

  it('traduce las operaciones de la base al inglés', () => {
    const base = {
      id: 1n,
      fecha: new Date(0),
      tabla: 't',
      idRegistro: '1',
      idUsuario: null,
      direccionIp: null,
    };
    const op = (operacion: 'INSERCION' | 'ACTUALIZACION' | 'ELIMINACION') =>
      aEventoAuditoria({ ...base, operacion, anteriores: {}, nuevos: {} }).operation;
    expect([op('INSERCION'), op('ACTUALIZACION'), op('ELIMINACION')]).toEqual([
      'INSERT',
      'UPDATE',
      'DELETE',
    ]);
  });
});
