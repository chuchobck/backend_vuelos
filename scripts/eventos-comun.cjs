// Lo que comparten eventos:sync y eventos:check: de dónde salen los esquemas de eventos del
// notifier y cómo se bajan. Son los 12 tipos que el core publica, en su versión mayor 1.
const path = require('node:path');

const REPO_NOTIFIER = process.env.NOTIFIER_REPO || 'chuchobck/notifier_vuelos';
const RUTA_REMOTA = 'contracts/events';
const DESTINO = path.join(__dirname, '..', 'contracts', 'notifier-eventos');
const TIPOS = [
  'booking.confirmed',
  'booking.failed',
  'booking.changed',
  'booking.cancelled',
  'booking.baggage_added',
  'hold.expired',
  'flight.schedule_changed',
  'flight.cancelled',
  'booking.ticket_issuing',
  'booking.ticket_issued',
  'booking.ticket_failed',
  'booking.checked_in',
];
const ARCHIVOS = TIPOS.map((tipo) => `${tipo}.v1.json`);

/** La rama del notifier: `--ref <rama>` o NOTIFIER_EVENTOS_REF; por defecto, main. */
function resolverRef(argv) {
  const i = argv.indexOf('--ref');
  if (i !== -1) {
    if (!argv[i + 1]) throw new Error('--ref necesita un valor (rama, etiqueta o commit)');
    return argv[i + 1];
  }
  return process.env.NOTIFIER_EVENTOS_REF || 'main';
}

/** Baja un esquema de esa ref del notifier. NOTIFIER_EVENTOS_TOKEN es opcional (repo privado). */
async function bajar(ref, archivo) {
  const url =
    `https://raw.githubusercontent.com/${REPO_NOTIFIER}/` +
    `${ref.split('/').map(encodeURIComponent).join('/')}/${RUTA_REMOTA}/${archivo}`;
  const cabeceras = process.env.NOTIFIER_EVENTOS_TOKEN
    ? { Authorization: `Bearer ${process.env.NOTIFIER_EVENTOS_TOKEN}` }
    : {};
  const respuesta = await fetch(url, { headers: cabeceras, signal: AbortSignal.timeout(15_000) });
  if (!respuesta.ok) {
    throw new Error(
      `No se pudo bajar ${RUTA_REMOTA}/${archivo} de ${REPO_NOTIFIER}@${ref} (HTTP ${respuesta.status})`,
    );
  }
  return normalizar(await respuesta.text());
}

/** Compara sin que un CRLF de Windows cuente como diferencia. */
function normalizar(texto) {
  return texto.replace(/\r\n/g, '\n');
}

module.exports = { REPO_NOTIFIER, DESTINO, ARCHIVOS, TIPOS, resolverRef, bajar, normalizar };
