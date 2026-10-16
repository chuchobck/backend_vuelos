#!/usr/bin/env node
/**
 * Devuelve a PENDIENTE eventos FALLIDO de la bandeja hacia el notifier (evento_saliente,
 * WEBHOOKS_MODE=notifier): los que el notifier rechazó (400, 409, 422...) una vez corregida la
 * causa, o los que pasaron 48 h sin poder publicarse.
 *
 *   npm run eventos:reencolar -- <eventId>
 *   npm run eventos:reencolar -- --todos-los-fallidos
 *
 * Cada uno vuelve con los intentos en cero, para publicar ya y con 48 h nuevas de reintentos. El
 * sobre NO cambia: se publica el mismo, byte a byte (si el notifier ya lo tenía, responde 200).
 * Por pantalla solo salen la cantidad y los eventId: ni el sobre ni el dueño.
 */
const path = require('node:path');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function main() {
  const argumento = process.argv[2];
  const todos = argumento === '--todos-los-fallidos';
  if (!todos && !(argumento && UUID.test(argumento))) {
    throw new ErrorDeUso('Uso: npm run eventos:reencolar -- <eventId> | --todos-los-fallidos');
  }
  const url = urlDeLaBase();
  const esquema = esquemaDeUrl(url);
  const cliente = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await cliente.connect();
  try {
    const { rows } = await cliente.query(
      `UPDATE ${esquema}.evento_saliente
          SET estado = 'PENDIENTE', intentos = 0, proximo_intento = now(),
              arrendamiento_hasta = NULL, reintentar_hasta = now() + interval '48 hours'
        WHERE estado = 'FALLIDO' AND ($1::boolean OR id_evento = $2::uuid)
       RETURNING id_evento::text AS id`,
      [todos, todos ? null : argumento],
    );
    if (rows.length === 0) {
      console.log(
        todos
          ? 'No hay eventos FALLIDO.'
          : `${argumento} no está FALLIDO (o no existe): nada que hacer.`,
      );
      if (!todos) process.exitCode = 1;
      return;
    }
    console.log(
      `Reencolados ${rows.length} eventos (vuelven a PENDIENTE, se publican en la próxima corrida del relevo):`,
    );
    for (const { id } of rows.slice(0, 50)) console.log(`  ${id}`);
    if (rows.length > 50) console.log(`  ... y ${rows.length - 50} más`);
  } finally {
    await cliente.end();
  }
}

main().catch((error) => {
  console.error(
    `No se pudo reencolar: ${error instanceof ErrorDeUso ? error.message : (error.code ?? error.message)}`,
  );
  process.exitCode = 2;
});
