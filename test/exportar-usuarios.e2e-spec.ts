import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearUsuario, desactivar, UsuarioDePrueba } from './utils/auth';
import { crearApp } from './utils/crear-app';

const RAIZ = resolve(__dirname, '..');
const SCRIPT = join(RAIZ, 'scripts', 'exportar-usuarios.cjs');

/**
 * Las tres tablas tal como las crea identity_vuelos (db/esquema_identidad.sql, 2026-10-15):
 * el SQL exportado tiene que cargar en ellas sin cambios. Van en un esquema propio de la
 * prueba, no en `identidad`.
 */
const TABLAS_IDENTITY = `
CREATE TABLE usuario (
    id               uuid         NOT NULL DEFAULT gen_random_uuid(),
    correo           text         NOT NULL,
    hash_contrasena  text         NOT NULL,
    activo           boolean      NOT NULL DEFAULT true,
    fecha_creacion   timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_usuario PRIMARY KEY (id),
    CONSTRAINT uq_usuario_correo UNIQUE (correo),
    CONSTRAINT ck_usuario_correo CHECK (
            correo = lower(btrim(correo))
        AND char_length(correo) <= 254
        AND correo ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
    ),
    CONSTRAINT ck_usuario_hash_contrasena CHECK (hash_contrasena ~ '^\\$argon2id\\$v=19\\$[a-z]=[0-9]+(,[a-z]=[0-9]+)*\\$[A-Za-z0-9+/]+\\$[A-Za-z0-9+/]+$')
);
CREATE TABLE rol (
    id           bigint   GENERATED ALWAYS AS IDENTITY,
    codigo       text     NOT NULL,
    descripcion  text     NOT NULL,
    activo       boolean  NOT NULL DEFAULT true,
    CONSTRAINT pk_rol PRIMARY KEY (id),
    CONSTRAINT uq_rol_codigo UNIQUE (codigo),
    CONSTRAINT ck_rol_codigo CHECK (codigo ~ '^[a-z_]+$'),
    CONSTRAINT ck_rol_descripcion CHECK (btrim(descripcion) <> '')
);
CREATE TABLE usuario_rol (
    id                bigint       GENERATED ALWAYS AS IDENTITY,
    usuario_id        uuid         NOT NULL,
    rol_id            bigint       NOT NULL,
    activo            boolean      NOT NULL DEFAULT true,
    fecha_asignacion  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_usuario_rol PRIMARY KEY (id),
    CONSTRAINT uq_usuario_rol UNIQUE (usuario_id, rol_id),
    CONSTRAINT fk_usuario_rol_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE RESTRICT,
    CONSTRAINT fk_usuario_rol_rol FOREIGN KEY (rol_id) REFERENCES rol (id) ON DELETE RESTRICT
);`;

interface Corrida {
  codigo: number;
  salida: string;
}

function exportar(url: string, ...argumentos: string[]): Promise<Corrida> {
  return new Promise((resolver) => {
    execFile(
      process.execPath,
      [SCRIPT, ...argumentos],
      { cwd: RAIZ, env: { ...process.env, DATABASE_URL: url } },
      (error, stdout, stderr) => {
        const codigo = error ? Number((error as { code?: unknown }).code ?? 1) : 0;
        resolver({ codigo, salida: `${stdout}${stderr}` });
      },
    );
  });
}

/** Lo que nunca puede salir por pantalla: un correo o un hash. */
function esperarSinDatosPersonales(texto: string, usuarios: UsuarioDePrueba[]) {
  for (const u of usuarios) expect(texto).not.toContain(u.correo);
  expect(texto).not.toMatch(/\$argon2/);
  expect(texto).not.toMatch(/[^\s@'"]+@[^\s@'"]+\.[a-z]{2,}/i);
}

describe('npm run auth:exportar-usuarios', () => {
  let app: INestApplication;
  let url: string;
  let carpeta: string;
  let persona: UsuarioDePrueba;
  let administrador: UsuarioDePrueba;
  let conCorreoTomado: UsuarioDePrueba;

  beforeAll(async () => {
    app = await crearApp();
    url = app.get(ConfigService).getOrThrow<string>('DATABASE_URL');
    carpeta = mkdtempSync(join(tmpdir(), 'exportacion-'));
    persona = await crearUsuario(app);
    administrador = await crearUsuario(app, { administrador: true });
    conCorreoTomado = await crearUsuario(app);
  });

  afterAll(async () => {
    for (const u of [persona, administrador, conCorreoTomado]) await desactivar(app, u);
    rmSync(carpeta, { recursive: true, force: true });
    await app.close();
  });

  function hashDe(usuario: UsuarioDePrueba): Promise<string> {
    return app
      .get(PrismaService)
      .db.usuario.findUniqueOrThrow({ where: { id: usuario.id } })
      .then((u) => u.hash_contrasena);
  }

  it('escribe los mismos id y hashes en un archivo 600 y por pantalla solo da cantidades', async () => {
    const ruta = join(carpeta, 'exportacion-usuarios.sql');
    const antes = await app.get(PrismaService).db.usuario.count();

    const corrida = await exportar(url, ruta);

    expect(corrida.codigo).toBe(0);
    expect(corrida.salida).toMatch(/Exportados \d+ usuarios \(\d+ activos\), 2 roles y \d+ asign/);
    esperarSinDatosPersonales(corrida.salida, [persona, administrador, conCorreoTomado]);
    expect(statSync(ruta).mode & 0o777).toBe(0o600);

    const sql = readFileSync(ruta, 'utf8');
    for (const u of [persona, administrador]) {
      expect(sql).toContain(`('${u.id}', '${u.correo}', '${await hashDe(u)}', true, `);
    }
    expect(sql).toContain(`('${administrador.id}', 'administrador', true, `);
    // Solo leyó: el core no cambió
    expect(await app.get(PrismaService).db.usuario.count()).toBe(antes);
  });

  describe('cargado en las tablas de identity', () => {
    const esquema = `identidad_e2e_${randomBytes(4).toString('hex')}`;
    let bd: Client;
    let sql: string;
    const avisos: string[] = [];
    const otroId = '7f1c1a52-0000-4000-8000-000000000001';

    beforeAll(async () => {
      const ruta = join(carpeta, 'para-cargar.sql');
      expect((await exportar(url, ruta)).codigo).toBe(0);
      // El mismo SQL, apuntado al esquema de la prueba
      sql = readFileSync(ruta, 'utf8').replace(
        /\bidentidad\.(usuario_rol|usuario|rol)\b/g,
        `${esquema}.$1`,
      );

      bd = new Client({ connectionString: url });
      await bd.connect();
      bd.on('notice', (aviso) => {
        avisos.push(aviso.message ?? '');
      });
      await bd.query(`CREATE SCHEMA ${esquema}`);
      await bd.query(`SET search_path TO ${esquema}`);
      await bd.query(TABLAS_IDENTITY);
      // Los roles de la semilla de identity, con otros id que en el core
      await bd.query(`INSERT INTO rol (codigo, descripcion) VALUES ('soporte', 'Rol que corre los id'),
        ('cliente', 'Cliente'), ('administrador', 'Administrador')`);
      // Alguien que ya se registró en identity con ese correo: no se toca
      await bd.query(`INSERT INTO usuario (id, correo, hash_contrasena) VALUES ($1, $2, $3)`, [
        otroId,
        conCorreoTomado.correo,
        await hashDe(persona),
      ]);
      await bd.query('RESET search_path');
    });

    afterAll(async () => {
      // Esquema propio de la prueba, sin datos de negocio: se quita entero
      await bd.query(`DROP SCHEMA IF EXISTS ${esquema} CASCADE`);
      await bd.end();
    });

    async function cuentaEnIdentity(id: string) {
      const { rows } = await bd.query<{ correo: string; hash_contrasena: string; activo: boolean }>(
        `SELECT correo, hash_contrasena, activo FROM ${esquema}.usuario WHERE id = $1`,
        [id],
      );
      return rows[0];
    }

    async function rolesEnIdentity(id: string): Promise<string[]> {
      const { rows } = await bd.query<{ codigo: string }>(
        `SELECT r.codigo FROM ${esquema}.usuario_rol ur JOIN ${esquema}.rol r ON r.id = ur.rol_id
          WHERE ur.usuario_id = $1 ORDER BY r.codigo`,
        [id],
      );
      return rows.map((r) => r.codigo);
    }

    async function totales() {
      const { rows } = await bd.query<{ usuarios: number; roles: number; asignaciones: number }>(
        `SELECT (SELECT count(*) FROM ${esquema}.usuario)::int AS usuarios,
                (SELECT count(*) FROM ${esquema}.rol)::int AS roles,
                (SELECT count(*) FROM ${esquema}.usuario_rol)::int AS asignaciones`,
      );
      return rows[0];
    }

    it('deja cada cuenta con su id, su hash y sus roles (enlazados por código)', async () => {
      await bd.query(sql);

      expect(await cuentaEnIdentity(persona.id)).toEqual({
        correo: persona.correo,
        hash_contrasena: await hashDe(persona),
        activo: true,
      });
      expect(await rolesEnIdentity(persona.id)).toEqual(['cliente']);
      expect(await rolesEnIdentity(administrador.id)).toEqual(['administrador', 'cliente']);

      // El correo que identity ya tenía con otro id queda como estaba
      expect(await cuentaEnIdentity(conCorreoTomado.id)).toBeUndefined();
      expect((await cuentaEnIdentity(otroId))?.correo).toBe(conCorreoTomado.correo);
      expect(await rolesEnIdentity(conCorreoTomado.id)).toEqual([]);

      expect(avisos).toHaveLength(1);
      expect(avisos[0]).toMatch(
        /^Usuarios: \d+ nuevos, 0 ya estaban con el mismo id, 1 con un correo que en identity tiene otro id/,
      );
      esperarSinDatosPersonales(avisos[0], [persona, administrador, conCorreoTomado]);
    });

    it('cargarlo otra vez no cambia nada', async () => {
      const antes = await totales();
      avisos.length = 0;

      await bd.query(sql);

      expect(await totales()).toEqual(antes);
      expect(avisos[0]).toMatch(/^Usuarios: 0 nuevos, \d+ ya estaban con el mismo id, 1 con un/);
    });
  });

  describe('dónde escribe', () => {
    it('no escribe dentro del repositorio', async () => {
      const ruta = join(RAIZ, 'exportacion-usuarios-e2e.sql');
      const corrida = await exportar(url, ruta);
      expect(corrida.codigo).toBe(1);
      expect(corrida.salida).toContain('tiene que quedar fuera del repositorio');
      expect(() => statSync(ruta)).toThrow();
    });

    it('tampoco por un enlace simbólico que lleva al repositorio', async () => {
      const enlace = join(carpeta, 'enlace-al-repositorio');
      symlinkSync(join(RAIZ, 'test'), enlace);
      const corrida = await exportar(url, join(enlace, 'exportacion-usuarios-e2e.sql'));
      expect(corrida.codigo).toBe(1);
      expect(corrida.salida).toContain('tiene que quedar fuera del repositorio');
      expect(() => statSync(join(RAIZ, 'test', 'exportacion-usuarios-e2e.sql'))).toThrow();
    });

    it('no pisa un archivo que ya existe', async () => {
      const ruta = join(carpeta, 'ya-existe.sql');
      writeFileSync(ruta, 'contenido previo');
      const corrida = await exportar(url, ruta);
      expect(corrida.codigo).toBe(1);
      expect(corrida.salida).toContain('el archivo ya existe');
      expect(readFileSync(ruta, 'utf8')).toBe('contenido previo');
    });

    it('sin ruta, explica cómo se usa', async () => {
      const corrida = await exportar(url);
      expect(corrida.codigo).toBe(1);
      expect(corrida.salida).toContain('Falta el archivo de salida');
    });
  });
});
