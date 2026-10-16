// npm run eventos:check [-- --ref <rama>]
// Compara contracts/notifier-eventos/ con los esquemas de main del notifier. Sale con 0 si los
// 12 son iguales, con 1 si alguno difiere o falta y con 2 si no pudo bajarlos.
const fs = require('node:fs');
const path = require('node:path');
const {
  DESTINO,
  ARCHIVOS,
  REPO_NOTIFIER,
  resolverRef,
  bajar,
  normalizar,
} = require('./eventos-comun.cjs');

(async () => {
  const ref = resolverRef(process.argv.slice(2));
  const distintos = [];
  for (const archivo of ARCHIVOS) {
    const remoto = await bajar(ref, archivo);
    const local = path.join(DESTINO, archivo);
    if (!fs.existsSync(local) || normalizar(fs.readFileSync(local, 'utf8')) !== remoto) {
      distintos.push(archivo);
    }
  }
  if (distintos.length === 0) {
    console.log(`Los ${ARCHIVOS.length} esquemas son iguales a los de ${REPO_NOTIFIER}@${ref}`);
    return;
  }
  console.error(`DIFIEREN de ${REPO_NOTIFIER}@${ref}: ${distintos.join(', ')}`);
  console.error('No se editan a mano: npm run eventos:sync los vuelve a traer del notifier.');
  process.exit(1);
})().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
