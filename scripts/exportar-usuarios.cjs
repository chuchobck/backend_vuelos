#!/usr/bin/env node
/**
 * Exportación única de las cuentas del core al servicio de identidad (identity_vuelos), para
 * pasar a AUTH_MODE=external sin que nadie pierda su cuenta ni sus reservas (procedimiento
 * completo en docs/DEPLOY.md, "Cambio de modo de autenticación"):
 *
 *   npm run auth:exportar-usuarios -- <archivo .sql fuera del repositorio>
 *   psql "<URL de la base de identity>" -v ON_ERROR_STOP=1 -f <archivo>
 *
 * - Lee usuario, rol y usuario_rol del esquema del core (el `?schema=` de DATABASE_URL, o
 *   vuelos) en una transacción de solo lectura: no cambia ni borra nada del core.
 * - Escribe un SQL para el esquema `identidad` de identity_vuelos (db/esquema_identidad.sql, con
 *   las mismas columnas) con los mismos id, que son el `sub` de los tokens y el `id_propietario`
 *   de retenciones, reservas y webhooks, y los hashes argon2id tal cual: las contraseñas siguen
 *   sirviendo. Los roles se enlazan por código, no por id (los id de rol no coinciden).
 * - Cargarlo es idempotente: todo va con ON CONFLICT DO NOTHING. Un correo que en identity ya
 *   tiene otro id no se pisa; un NOTICE dice cuántos hay (sin decir cuáles).
 * - Los tokens de refresco no se exportan: después del cambio cada persona inicia sesión de nuevo.
 *
 * El archivo tiene correos y hashes: se crea con permisos 600, nunca dentro del repositorio (y
 * .gitignore lo ignora por si acaso) y no pisa uno que ya exista. Por pantalla solo salen
 * cantidades y la ruta del archivo: ni un correo ni un hash.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const RAIZ_REPOSITORIO = path.resolve(__dirname, '..');
const ESQUEMA_DESTINO = 'identidad';
const PERMISOS = 0o600;

class ErrorDeUso extends Error {}

function rutaDeSalida(argumento) {
  if (!argumento) {
    throw new ErrorDeUso(
      'Falta el archivo de salida: npm run auth:exportar-usuarios -- <ruta fuera del repositorio>',
    );
  }
  const ruta = path.resolve(argumento);
  // La carpeta real (sin enlaces simbólicos) también tiene que quedar fuera del repositorio
  let carpetaReal;
  try {
    carpetaReal = fs.realpathSync(path.dirname(ruta));
  } catch {
    throw new ErrorDeUso(`La carpeta de ${ruta} no existe`);
  }
  const raizReal = fs.realpathSync(RAIZ_REPOSITORIO);
  for (const [candidata, raiz] of [
    [ruta, RAIZ_REPOSITORIO],
    [path.join(carpetaReal, path.basename(ruta)), raizReal],
  ]) {
    if (candidata === raiz || candidata.startsWith(raiz + path.sep)) {
      throw new ErrorDeUso(
        'El archivo tiene correos y hashes de contraseñas: tiene que quedar fuera del repositorio',
      );
    }
  }
  return ruta;
}

/** El esquema del core: el `?schema=` de la URL (como PrismaService) o vuelos. */
function esquemaDeUrl(url) {
  const esquema = new URL(url).searchParams.get('schema') ?? 'vuelos';
  if (!/^[a-z_][a-z0-9_]*$/.test(esquema))
    throw new ErrorDeUso('El ?schema= de DATABASE_URL no es válido');
  return esquema;
}

function urlDeLaBase() {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(path.join(RAIZ_REPOSITORIO, '.env'));
    } catch {
      // sin .env: se avisa abajo
    }
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new ErrorDeUso('Falta DATABASE_URL (variable de entorno o .env)');
  return url;
}

async function leerCuentas(url) {
  const esquema = esquemaDeUrl(url);
  const cliente = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await cliente.connect();
  try {
    // Una sola foto consistente de las tres tablas, sin poder escribir nada
    await cliente.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await cliente.query("SET LOCAL TIME ZONE 'UTC'");
    const usuarios = await cliente.query(
      `SELECT id::text AS id, correo, hash_contrasena, activo, fecha_creacion::text AS fecha_creacion
         FROM ${esquema}.usuario ORDER BY fecha_creacion, id`,
    );
    const roles = await cliente.query(
      `SELECT codigo, descripcion, activo FROM ${esquema}.rol ORDER BY id`,
    );
    const asignaciones = await cliente.query(
      `SELECT ur.usuario_id::text AS usuario_id, r.codigo AS codigo_rol, ur.activo,
              ur.fecha_asignacion::text AS fecha_asignacion
         FROM ${esquema}.usuario_rol ur JOIN ${esquema}.rol r ON r.id = ur.rol_id
        ORDER BY ur.id`,
    );
    await cliente.query('COMMIT');
    return { usuarios: usuarios.rows, roles: roles.rows, asignaciones: asignaciones.rows };
  } finally {
    await cliente.end();
  }
}

/** Un literal de SQL: comillas simples duplicadas (standard_conforming_strings va en on). */
function literal(valor) {
  if (typeof valor === 'boolean') return valor ? 'true' : 'false';
  return `'${String(valor).replace(/'/g, "''")}'`;
}

function insertarEnTemporal(tabla, filas, columnas) {
  if (filas.length === 0) return `-- ${tabla}: sin filas\n`;
  const valores = filas.map((f) => `    (${columnas.map((c) => literal(f[c])).join(', ')})`);
  return `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES\n${valores.join(',\n')};\n`;
}

function generarSql({ usuarios, roles, asignaciones }, fecha) {
  const d = ESQUEMA_DESTINO;
  return `-- Cuentas del core de Quinde (API de Vuelos) para el servicio de identidad (identity_vuelos).
-- Generado por npm run auth:exportar-usuarios el ${fecha}.
-- PRIVADO: tiene correos y hashes de contraseñas. No lo subas ni lo copies; bórralo al cargarlo.
-- Destino: el esquema ${d} de identity (db/esquema_identidad.sql). Cargar con:
--   psql "<URL de la base de identity>" -v ON_ERROR_STOP=1 -f <este archivo>
-- Idempotente: cargarlo otra vez no cambia nada. No borra ni modifica filas de identity.

SET standard_conforming_strings = on;
BEGIN;

CREATE TEMP TABLE exportacion_rol (codigo text, descripcion text, activo boolean) ON COMMIT DROP;
CREATE TEMP TABLE exportacion_usuario (
    id uuid, correo text, hash_contrasena text, activo boolean, fecha_creacion timestamptz
) ON COMMIT DROP;
CREATE TEMP TABLE exportacion_usuario_rol (
    usuario_id uuid, codigo_rol text, activo boolean, fecha_asignacion timestamptz
) ON COMMIT DROP;

${insertarEnTemporal('exportacion_rol', roles, ['codigo', 'descripcion', 'activo'])}
${insertarEnTemporal('exportacion_usuario', usuarios, ['id', 'correo', 'hash_contrasena', 'activo', 'fecha_creacion'])}
${insertarEnTemporal('exportacion_usuario_rol', asignaciones, ['usuario_id', 'codigo_rol', 'activo', 'fecha_asignacion'])}
-- Qué va a pasar, en cantidades (nunca los correos)
DO $$
DECLARE
    v_nuevos   integer;
    v_estaban  integer;
    v_otro_id  integer;
BEGIN
    SELECT count(*) FILTER (WHERE mismo.id IS NULL AND otro.id IS NULL),
           count(*) FILTER (WHERE mismo.id IS NOT NULL),
           count(*) FILTER (WHERE mismo.id IS NULL AND otro.id IS NOT NULL)
      INTO v_nuevos, v_estaban, v_otro_id
      FROM exportacion_usuario e
      LEFT JOIN ${d}.usuario mismo ON mismo.id = e.id
      LEFT JOIN ${d}.usuario otro ON otro.correo = e.correo AND otro.id <> e.id;
    RAISE NOTICE 'Usuarios: % nuevos, % ya estaban con el mismo id, % con un correo que en identity tiene otro id (no se tocan)',
        v_nuevos, v_estaban, v_otro_id;
END
$$;

INSERT INTO ${d}.rol (codigo, descripcion, activo)
SELECT codigo, descripcion, activo FROM exportacion_rol
ON CONFLICT DO NOTHING;

INSERT INTO ${d}.usuario (id, correo, hash_contrasena, activo, fecha_creacion)
SELECT id, correo, hash_contrasena, activo, fecha_creacion FROM exportacion_usuario
ON CONFLICT DO NOTHING;

-- Solo para las cuentas que quedaron en identity con el mismo id
INSERT INTO ${d}.usuario_rol (usuario_id, rol_id, activo, fecha_asignacion)
SELECT e.usuario_id, r.id, e.activo, e.fecha_asignacion
  FROM exportacion_usuario_rol e
  JOIN ${d}.rol r ON r.codigo = e.codigo_rol
  JOIN ${d}.usuario u ON u.id = e.usuario_id
ON CONFLICT DO NOTHING;

COMMIT;
`;
}

function escribirPrivado(ruta, contenido) {
  // 'wx': falla si ya existe; el modo se fija al crearlo y otra vez por si el umask es raro
  const fd = fs.openSync(ruta, 'wx', PERMISOS);
  try {
    fs.fchmodSync(fd, PERMISOS);
    fs.writeFileSync(fd, contenido);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Un motivo para la pantalla sin la URL ni datos de las filas. */
function motivo(error) {
  if (error instanceof ErrorDeUso) return error.message;
  if (error && error.code === 'EEXIST')
    return 'el archivo ya existe; elige otro nombre (no se pisa)';
  if (error && typeof error.code === 'string') return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const ruta = rutaDeSalida(process.argv[2]);
  if (fs.existsSync(ruta)) throw Object.assign(new Error('existe'), { code: 'EEXIST' });
  const cuentas = await leerCuentas(urlDeLaBase());
  escribirPrivado(ruta, generarSql(cuentas, new Date().toISOString()));

  const activos = cuentas.usuarios.filter((u) => u.activo).length;
  console.log(
    `Exportados ${cuentas.usuarios.length} usuarios (${activos} activos), ` +
      `${cuentas.roles.length} roles y ${cuentas.asignaciones.length} asignaciones de rol.`,
  );
  console.log(`Archivo: ${ruta} (permisos 600). Tiene correos y hashes: bórralo al cargarlo.`);
  console.log(
    `Cargar en identity: psql "<URL de la base de identity>" -v ON_ERROR_STOP=1 -f ${ruta}`,
  );
}

main().catch((error) => {
  console.error(`No se pudo exportar: ${motivo(error)}`);
  process.exitCode = 1;
});
