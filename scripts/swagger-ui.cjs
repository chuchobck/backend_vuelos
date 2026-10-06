#!/usr/bin/env node
/**
 * Prueba de la interfaz de Swagger (/api/docs) con un navegador real (Playwright + Chromium):
 * registra y loguea un usuario con "Try it out", pega el token en Authorize y ejecuta health,
 * búsqueda, hold, reserva (Idempotency-Key y PAY-OK-), consulta y cancelación, todo desde la UI.
 * Guarda pocas capturas livianas en docs/pruebas/swagger/.
 *
 * Playwright no es dependencia del proyecto. Con el paquete en la caché de npx:
 *   NODE_PATH=$(dirname $(find ~/.npm/_npx -path '*node_modules/playwright/package.json' | head -1))/.. \
 *     node scripts/swagger-ui.cjs http://localhost:3010
 * (o `npm i --no-save playwright && npx playwright install chromium`).
 * Sale con código 1 si algún paso falla. No imprime el token.
 */
const { chromium } = require('playwright');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const BASE = (process.argv[2] || 'http://localhost:3010').replace(/\/$/, '');
const CAPTURAS = join(__dirname, '..', 'docs', 'pruebas', 'swagger');
const P = '/flights/v1';

function cedula(serie) {
  const base = `171${String(serie % 1_000_000).padStart(6, '0')}`;
  let suma = 0;
  for (let i = 0; i < 9; i++) {
    let producto = Number(base[i]) * (i % 2 === 0 ? 2 : 1);
    if (producto > 9) producto -= 9;
    suma += producto;
  }
  return `${base}${(10 - (suma % 10)) % 10}`;
}

const resultados = [];
function paso(nombre, ok, detalle = '') {
  resultados.push({ nombre, ok });
  console.log(`${ok ? 'OK    ' : 'FALLÓ '} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

/** Abre la operación, "Try it out", llena parámetros y cuerpo, "Execute"; devuelve status y cuerpo. */
async function ejecutar(page, metodo, ruta, { params = {}, cuerpo } = {}) {
  const bloque = page
    .locator(`.opblock.opblock-${metodo}`)
    .filter({ has: page.locator(`.opblock-summary-path[data-path="${P}${ruta}"]`) })
    .first();
  await bloque.scrollIntoViewIfNeeded();
  if (!(await bloque.evaluate((n) => n.classList.contains('is-open')))) {
    await bloque.locator('.opblock-summary').first().click();
  }
  const probar = bloque.locator('button.try-out__btn');
  if ((await probar.innerText()).trim() === 'Try it out') await probar.click();
  for (const [nombre, valor] of Object.entries(params)) {
    await bloque.locator(`tr[data-param-name="${nombre}"] input`).first().fill(String(valor));
  }
  if (cuerpo !== undefined) {
    await bloque.locator('textarea.body-param__text').fill(JSON.stringify(cuerpo, null, 2));
  }
  await bloque.locator('button.execute').click();
  const estado = bloque.locator('.live-responses-table tr.response .response-col_status').first();
  await estado.waitFor({ timeout: 15_000 });
  // La celda trae el código y, a veces, un texto ("Undocumented"): se toma el número
  const codigo = Number(/\d{3}/.exec(await estado.innerText())?.[0]);
  const texto = await bloque
    .locator('.live-responses-table .response-col_description pre')
    .first()
    .innerText()
    .catch(() => '');
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    /* sin cuerpo */
  }
  return { codigo, json, bloque };
}

async function capturar(page, bloque, nombre) {
  await bloque.locator('.live-responses-table').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(CAPTURAS, nombre), type: 'jpeg', quality: 55 });
}

(async () => {
  mkdirSync(CAPTURAS, { recursive: true });
  const navegador = await chromium.launch();
  const page = await navegador.newPage({ viewport: { width: 1280, height: 860 } });
  try {
    const docs = await page.goto(`${BASE}/api/docs`);
    paso('GET /api/docs abre Swagger UI', docs?.status() === 200);
    await page.locator('.opblock').first().waitFor();

    const salud = await ejecutar(page, 'get', '/health');
    paso('health (Try it out)', salud.codigo === 200, `status ${salud.codigo}`);

    const correo = `swagger-${Date.now()}@example.com`;
    const clave = 'una frase de prueba bastante larga';
    const alta = await ejecutar(page, 'post', '/auth/register', {
      cuerpo: { email: correo, password: clave },
    });
    paso('registro (Try it out)', alta.codigo === 201, `status ${alta.codigo}`);
    const login = await ejecutar(page, 'post', '/auth/login', {
      cuerpo: { email: correo, password: clave },
    });
    const token = login.json?.access_token;
    paso(
      'login (Try it out)',
      login.codigo === 200 && typeof token === 'string',
      `status ${login.codigo}`,
    );

    await page.locator('button.authorize').first().click();
    const bearer = page.locator('.auth-container').filter({ hasText: 'bearer' }).first();
    await bearer.locator('input').first().fill(token);
    await bearer.locator('button.authorize').click();
    await page.screenshot({ path: join(CAPTURAS, '01-authorize.jpg'), type: 'jpeg', quality: 55 });
    paso('Authorize con el token', (await bearer.innerText()).includes('Authorized'));
    await page.locator('.btn-done').first().click();

    const fecha = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const busqueda = await ejecutar(page, 'post', '/search', {
      params: { 'X-Device-Fingerprint': 'swagger-ui-1b2c3d4e' },
      cuerpo: {
        itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: fecha }],
        passengers: { adults: 1 },
      },
    });
    const ofertas = busqueda.json?.offers ?? [];
    paso(
      'búsqueda UIO→GYE',
      busqueda.codigo === 200 && ofertas.length > 0,
      `${ofertas.length} ofertas`,
    );
    await capturar(page, busqueda.bloque, '02-busqueda.jpg');
    const oferta =
      ofertas.find((o) => o.itineraries.every((i) => i.segments.length === 1)) ?? ofertas[0];
    const itinerario = oferta.itineraries[0];
    const opcion = itinerario.pricingOptions[0];

    const hold = await ejecutar(page, 'post', '/offers/hold', {
      params: { 'Idempotency-Key': randomUUID() },
      cuerpo: {
        offerId: oferta.offerId,
        itinerarySelections: [
          {
            itineraryId: itinerario.itineraryId,
            cabinClass: opcion.cabinClass,
            fareBrand: opcion.fareBrand,
          },
        ],
        passengersBreakdown: { adults: 1 },
      },
    });
    paso('crear hold', hold.codigo === 201, `status ${hold.codigo}`);

    const referencia = `PAY-OK-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    const reserva = await ejecutar(page, 'post', '/bookings', {
      params: { 'Idempotency-Key': randomUUID() },
      cuerpo: {
        holdId: hold.json?.holdId,
        passengers: [
          {
            passengerId: 'ADU1',
            passengerType: 'ADULT',
            firstName: 'Ana',
            lastName: 'Prueba',
            documentType: 'NATIONAL_ID',
            documentNumber: cedula(Date.now()),
            nationality: 'EC',
            birthDate: '1990-04-15',
            gender: 'F',
            contact: { email: 'ana@example.com', phone: '+593991234567' },
          },
        ],
        payment: { paymentReference: referencia },
      },
    });
    const bookingId = reserva.json?.bookingId;
    paso(
      'crear reserva (Idempotency-Key, PAY-OK-)',
      reserva.codigo === 201 && reserva.json?.status === 'CONFIRMED',
      `status ${reserva.codigo} ${reserva.json?.status ?? ''}`,
    );
    await capturar(page, reserva.bloque, '03-reserva.jpg');

    const consulta = await ejecutar(page, 'get', '/bookings/{bookingId}', {
      params: { bookingId },
    });
    paso(
      'consultar reserva',
      consulta.codigo === 200 && consulta.json?.bookingId === bookingId,
      `status ${consulta.codigo}`,
    );

    const cotizacion = await ejecutar(page, 'get', '/bookings/{bookingId}/cancellation-quote', {
      params: { bookingId },
    });
    paso('cotizar cancelación', cotizacion.codigo === 200, `status ${cotizacion.codigo}`);
    const cancelacion = await ejecutar(page, 'post', '/bookings/{bookingId}/cancel', {
      params: { bookingId, 'Idempotency-Key': randomUUID() },
      cuerpo: { quoteId: cotizacion.json?.quoteId },
    });
    paso(
      'cancelar reserva',
      cancelacion.codigo === 200 && cancelacion.json?.status === 'CANCELLED',
      `status ${cancelacion.codigo} ${cancelacion.json?.status ?? ''}`,
    );
    await capturar(page, cancelacion.bloque, '04-cancelacion.jpg');
  } catch (error) {
    paso('flujo de Swagger UI', false, error.message.split('\n')[0]);
  } finally {
    await navegador.close();
  }
  const fallidos = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallidos}/${resultados.length} pasos OK`);
  process.exit(fallidos === 0 ? 0 : 1);
})();
