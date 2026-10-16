#!/usr/bin/env node
/**
 * Purga a mano la bandeja hacia el notifier (evento_saliente, WEBHOOKS_MODE=notifier) con las
 * mismas reglas que el job PurgaBandeja:
 *
 *   PUBLICADO: se borra pasados EVENT_OUTBOX_RETENTION_DAYS (7) días desde publicado_en.
 *   FALLIDO:   pasados EVENT_OUTBOX_FAILED_RETENTION_DAYS (30) días desde que falló.
 *   PENDIENTE: jamás, tampoco con el arrendamiento vencido.
 *
 *   npm run eventos:purgar -- --dry-run   # cuántas borraría de cada estado; no borra nada
 *   npm run eventos:purgar                # las borra, en sentencias de 1000 filas
 *
 * Lee las dos retenciones de EVENT_OUTBOX_* (entorno o .env), con los mismos límites que la API.
 * La edad se cuenta con el now() de la base (un script fuera de la app no tiene el Reloj). Por
 * pantalla salen solo conteos: ni el sobre, ni el eventId, ni el dueño.
 */
const path = require('node:path');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..');
const LOTE = 1000;

class ErrorDeUso extends Error {}

function urlDeLaBase() {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(path.join(RAIZ, '.env'));
    } catch {
      // sin .env: se avisa abajo
    }
  }
  if (!process.env.DATABASE_URL)
    throw new ErrorDeUso('Falta DATABASE_URL (variable de entorno o .env)');
  return process.env.DATABASE_URL;
}

function esquemaDeUrl(url) {
  const esquema = new URL(url).searchParams.get('schema') ?? 'vuelos';
  if (!/^[a-z_][a-z0-9_]*$/.test(esquema))
    throw new ErrorDeUso('El ?schema= de DATABASE_URL no es válido');
  return esquema;
}

/** Un entero entre `minimo` y `maximo`; el mensaje nombra la variable, nunca su valor. */
function dias(nombre, porDefecto, minimo, maximo) {
  const texto = process.env[nombre];
  if (texto === undefined || texto === '') return porDefecto;
  const valor = Number(texto);
  if (!/^\d+$/.test(texto.trim()) || valor < minimo || valor > maximo)
    throw new ErrorDeUso(`${nombre} debe ser un entero entre ${minimo} y ${maximo}`);
  return valor;
}

async function main() {
  const argumentos = process.argv.slice(2);
  const simulacro = argumentos.includes('--dry-run');
  if (argumentos.some((a) => a !== '--dry-run'))
    throw new ErrorDeUso('Uso: npm run eventos:purgar -- [--dry-run]');
  const url = urlDeLaBase();
  const esquema = esquemaDeUrl(url);
  const publicados = dias('EVENT_OUTBOX_RETENTION_DAYS', 7, 1, 365);
  const fallidos = dias('EVENT_OUTBOX_FAILED_RETENTION_DAYS', 30, 7, 365);

  // Las mismas condiciones que BandejaEventosRepository.purgarLote
  const reglas = {
    PUBLICADO: {
      dias: publicados,
      donde: `estado = 'PUBLICADO' AND publicado_en < now() - $1 * interval '1 day'`,
      orden: 'publicado_en',
    },
    FALLIDO: {
      dias: fallidos,
      donde: `estado = 'FALLIDO' AND proximo_intento < now() - $1 * interval '1 day'`,
      orden: 'proximo_intento',
    },
  };
  const sinArrendamiento = `(arrendamiento_hasta IS NULL OR arrendamiento_hasta <= now())`;

  const cliente = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await cliente.connect();
  try {
    console.log(
      `Reglas: PUBLICADO más de ${publicados} días desde publicado_en; ` +
        `FALLIDO más de ${fallidos} días desde que falló; PENDIENTE nunca.`,
    );
    const total = {};
    for (const [estado, r] of Object.entries(reglas)) {
      if (simulacro) {
        const { rows } = await cliente.query(
          `SELECT count(*)::int AS n FROM ${esquema}.evento_saliente
            WHERE ${r.donde} AND ${sinArrendamiento}`,
          [r.dias],
        );
        total[estado] = rows[0].n;
        continue;
      }
      total[estado] = 0;
      for (;;) {
        const { rowCount } = await cliente.query(
          `DELETE FROM ${esquema}.evento_saliente
            WHERE estado = '${estado}' AND id_evento IN (
                  SELECT id_evento FROM ${esquema}.evento_saliente
                   WHERE ${r.donde} AND ${sinArrendamiento}
                   ORDER BY ${r.orden}, id_evento
                   LIMIT ${LOTE}
                     FOR UPDATE SKIP LOCKED)`,
          [r.dias],
        );
        total[estado] += rowCount;
        if (rowCount < LOTE) break;
      }
    }
    const verbo = simulacro ? 'Borraría' : 'Borradas';
    console.log(`${verbo}: ${total.PUBLICADO} PUBLICADO y ${total.FALLIDO} FALLIDO.`);
    if (simulacro) console.log('(--dry-run: no se borró nada)');
    const { rows } = await cliente.query(
      `SELECT estado::text AS estado, count(*)::int AS n FROM ${esquema}.evento_saliente
        GROUP BY estado ORDER BY estado`,
    );
    console.log(
      `En la bandeja ${simulacro ? 'hay' : 'quedan'}: ` +
        (rows.map((f) => `${f.n} ${f.estado}`).join(', ') || 'nada'),
    );
  } finally {
    await cliente.end();
  }
}

main().catch((error) => {
  console.error(
    `No se pudo purgar: ${error instanceof ErrorDeUso ? error.message : (error.code ?? error.message)}`,
  );
  process.exitCode = 2;
});
