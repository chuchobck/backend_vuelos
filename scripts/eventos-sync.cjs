// npm run eventos:sync [-- --ref <rama>]
// Trae los 12 esquemas de eventos (contracts/events/<tipo>.v1.json) de main del notifier a
// contracts/notifier-eventos/. No se editan a mano: son el contrato del notifier y el core solo
// los copia para validar cada sobre que publica.
const fs = require('node:fs');
const path = require('node:path');
const { DESTINO, ARCHIVOS, REPO_NOTIFIER, resolverRef, bajar } = require('./eventos-comun.cjs');

(async () => {
  const ref = resolverRef(process.argv.slice(2));
  fs.mkdirSync(DESTINO, { recursive: true });
  let cambiados = 0;
  for (const archivo of ARCHIVOS) {
    const contenido = await bajar(ref, archivo);
    const destino = path.join(DESTINO, archivo);
    const anterior = fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8') : null;
    if (anterior !== contenido) {
      fs.writeFileSync(destino, contenido);
      cambiados++;
      console.log(`${archivo}: actualizado`);
    }
  }
  console.log(
    `${ARCHIVOS.length} esquemas de ${REPO_NOTIFIER}@${ref}: ${cambiados} actualizados, ` +
      `${ARCHIVOS.length - cambiados} ya eran iguales`,
  );
})().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
