#!/usr/bin/env node
/**
 * Sincronización completa del stock a Booking (fase S1, docs/STOCK-BOOKING.md):
 *
 *   BOOKING_STOCK_ENABLED=true BOOKING_STOCK_SERVICE_ID=<el nuestro> npm run stock:sincronizar -- --dry-run
 *   BOOKING_STOCK_ENABLED=true BOOKING_STOCK_SERVICE_ID=<el nuestro> npm run stock:sincronizar
 *
 * Arranca el core SIN servidor ni procesos periódicos (solo la base y el trabajador del empuje),
 * así que hay que compilar antes (`npm run build`). Lee DATABASE_URL del entorno o de .env.
 * Con --dry-run no hace falta BOOKING_STOCK_ENABLED (no se escribe ni se llama a nadie); el
 * service_id sí, porque va en cada registro. Sin --dry-run exige BOOKING_STOCK_ENABLED=true.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const CLI = path.join(RAIZ, 'dist', 'modules', 'vuelos', 'stock-booking', 'sincronizar-cli.js');

function fallar(mensaje) {
  console.error(mensaje);
  process.exit(2);
}

const argumentos = process.argv.slice(2);
const simulacro = argumentos.includes('--dry-run');

if (!fs.existsSync(CLI)) fallar('Falta compilar: ejecuta `npm run build` y vuelve a intentar.');
if (!simulacro && process.env.BOOKING_STOCK_ENABLED !== 'true') {
  fallar(
    'Falta BOOKING_STOCK_ENABLED=true (sin --dry-run el comando manda de verdad). ' +
      'Prueba antes con: npm run stock:sincronizar -- --dry-run',
  );
}
if (simulacro) process.env.BOOKING_STOCK_ENABLED = 'true';

// Nada de lo que arranca un servicio normal: solo el trabajador del empuje, que corre a mano
Object.assign(process.env, {
  BOOKING_STOCK_JOB_ENABLED: 'false',
  BOOKING_STOCK_SYNC_AL_ARRANCAR: 'false',
  HOLD_EXPIRY_JOB_ENABLED: 'false',
  BOOKING_ISSUE_JOB_ENABLED: 'false',
  POSTSALE_JOB_ENABLED: 'false',
  WEBHOOK_DELIVERY_JOB_ENABLED: 'false',
  EVENT_RELAY_JOB_ENABLED: 'false',
  EVENT_OUTBOX_PURGE_JOB_ENABLED: 'false',
  GRPC_ENABLED: 'false',
  METRICS_PORT: '0',
});

/**
 * Sale cuando stdout y stderr terminaron de escribir. Con `process.exit` a secas, una salida grande
 * hacia un pipe (`--dry-run | head`, o quien lo corre desde otro proceso) se corta a la mitad: lo
 * escrito y no vaciado todavía se pierde.
 */
function salir(codigo) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(codigo)));
}

require(CLI)
  .main(argumentos)
  .then(salir)
  .catch((error) => {
    // Solo el nombre y el mensaje de validación de entorno (nombran la variable, nunca su valor)
    console.error(`stock:sincronizar falló: ${error?.name ?? 'Error'}: ${error?.message ?? ''}`);
    salir(1);
  });
