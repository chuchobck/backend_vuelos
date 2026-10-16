#!/usr/bin/env node
/**
 * Exporta las suscripciones a webhooks del core para importarlas en el notifier
 * (notifier_vuelos, docs/MIGRACION.md), antes de pasar a WEBHOOKS_MODE=notifier
 * (docs/MIGRACION-WEBHOOKS.md):
 *
 *   npm run webhooks:exportar -- <archivo .jsonl fuera del repositorio>
 *   npm run suscripciones:importar -- <archivo>        (en el notifier)
 *
 * - Lee webhook_cabecera y webhook_detalle (DATABASE_URL o el .env) en una transacción de solo
 *   lectura: no cambia ni borra nada del core.
 * - Escribe JSON Lines, una suscripción por línea, con exactamente los campos que acepta el
 *   importador: id, idPropietario, url, secretoCifrado (el valor cifrado tal como está en la base,
 *   nunca el secreto en claro), eventos, activo y fechaCreacion. Las dadas de baja también van.
 * - El archivo tiene URLs y secretos cifrados: se crea con permisos 600, nunca dentro del
 *   repositorio (y .gitignore lo ignora por si acaso) y no pisa uno que ya exista. Por pantalla solo
 *   salen cantidades y la ruta del archivo: ni una URL ni un secreto.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const RAIZ_REPOSITORIO = path.resolve(__dirname, '..');
const PERMISOS = 0o600;

class ErrorDeUso extends Error {}

function rutaDeSalida(argumento) {
  if (!argumento) {
    throw new ErrorDeUso(
      'Falta el archivo de salida: npm run webhooks:exportar -- <ruta fuera del repositorio>',
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
        'El archivo tiene URLs y secretos cifrados: tiene que quedar fuera del repositorio',
      );
    }
  }
  return ruta;
}

/** El esquema del core: el `?schema=` de la URL (como PrismaService) o vuelos. */
function esquemaDeUrl(url) {
  const esquema = new URL(url).searchParams.get('schema') ?? 'vuelos';
  if (!/^[a-z_][a-z0-9_]*$/.test(esquema)) {
    throw new ErrorDeUso('El ?schema= de DATABASE_URL no es válido');
  }
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

async function leerSuscripciones(url) {
  const esquema = esquemaDeUrl(url);
  const cliente = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await cliente.connect();
  try {
    await cliente.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Los eventos en el orden del catálogo (tipo_evento.id), sin repetidos
    const { rows } = await cliente.query(
      `SELECT w.id::text AS id, w.id_propietario AS "idPropietario", w.url, w.secreto AS "secretoCifrado",
              array_agg(t.codigo ORDER BY t.id) AS eventos, w.activo,
              to_char(w.fecha_creacion AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "fechaCreacion"
         FROM ${esquema}.webhook_cabecera w
         JOIN ${esquema}.webhook_detalle d ON d.webhook_id = w.id
         JOIN ${esquema}.tipo_evento t     ON t.id = d.tipo_evento_id
        GROUP BY w.id
        ORDER BY w.fecha_creacion, w.id`,
    );
    const [{ sinEventos }] = (
      await cliente.query(
        `SELECT count(*)::int AS "sinEventos" FROM ${esquema}.webhook_cabecera w
          WHERE NOT EXISTS (SELECT 1 FROM ${esquema}.webhook_detalle d WHERE d.webhook_id = w.id)`,
      )
    ).rows;
    await cliente.query('COMMIT');
    return { suscripciones: rows, sinEventos };
  } finally {
    await cliente.end();
  }
}

/** Una línea con exactamente los siete campos del importador, en su orden. */
function aLinea(s) {
  return JSON.stringify({
    id: s.id,
    idPropietario: s.idPropietario,
    url: s.url,
    secretoCifrado: s.secretoCifrado,
    eventos: s.eventos,
    activo: s.activo,
    fechaCreacion: s.fechaCreacion,
  });
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

/** Un motivo para la pantalla sin la URL de la base ni datos de las filas. */
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
  const { suscripciones, sinEventos } = await leerSuscripciones(urlDeLaBase());
  escribirPrivado(ruta, suscripciones.map((s) => `${aLinea(s)}\n`).join(''));

  const activas = suscripciones.filter((s) => s.activo).length;
  const duenos = new Set(suscripciones.map((s) => s.idPropietario)).size;
  console.log(
    `Exportadas ${suscripciones.length} suscripciones (${activas} activas) de ${duenos} dueños.`,
  );
  if (sinEventos > 0) {
    console.log(`  ${sinEventos} sin ningún evento no se exportaron (el notifier no las acepta).`);
  }
  console.log(
    `Archivo: ${ruta} (permisos 600). Tiene URLs y secretos cifrados: bórralo al importarlo.`,
  );
  console.log(`Importar en el notifier: npm run suscripciones:importar -- ${ruta}`);
}

main().catch((error) => {
  console.error(`No se pudo exportar: ${motivo(error)}`);
  process.exitCode = 1;
});
