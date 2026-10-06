#!/usr/bin/env node
/**
 * Pruebas de carga ligeras (autocannon) contra una API local con la semilla:
 *   1. POST /search (UIO→GYE), 2. GET /flights/{n}/status y 3. holds concurrentes sobre el mismo
 *   cupo (la cabina ejecutiva de un vuelo, 8 asientos): nunca más holds ganadores que asientos.
 * Imprime latencias p50/p95/p99, errores y, con DATABASE_URL, el inventario antes y después.
 *
 * La API tiene límites por IP (20 búsquedas, 60 estados y 30 holds por minuto). Para medir la
 * API y no el 429, este script manda un X-Forwarded-For distinto en cada petición y la API debe
 * correr con TRUST_PROXY=1. Solo en local: en Render TRUST_PROXY=1 confía en el proxy de Render,
 * que pisa esa cabecera.
 *
 *   TRUST_PROXY=1 PORT=3010 node dist/main &
 *   NODE_PATH=<carpeta con autocannon y pg> DATABASE_URL=... node scripts/carga.cjs http://localhost:3010
 * autocannon no es dependencia del proyecto (npx -y autocannon@8 lo deja en la caché de npx).
 */
const autocannon = require('autocannon');
const { randomUUID, randomInt } = require('node:crypto');

const BASE = (process.argv[2] || 'http://localhost:3010').replace(/\/$/, '');
const API = `${BASE}/flights/v1`;
const DURACION = Number(process.env.CARGA_SEGUNDOS || 15);
const CONEXIONES = Number(process.env.CARGA_CONEXIONES || 20);
const HOLDS = Number(process.env.CARGA_HOLDS || 60);

const ipAlAzar = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const fecha = (dias) => new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);

function percentil(valores, p) {
  const ordenados = [...valores].sort((a, b) => a - b);
  const valor =
    ordenados[Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1)];
  return Math.round(valor * 10) / 10;
}

/** Corre autocannon y mide cada respuesta (autocannon no da p95). */
function medir(opciones) {
  return new Promise((resolver, rechazar) => {
    const tiempos = [];
    const codigos = {};
    const instancia = autocannon(opciones, (error, resultado) => {
      if (error) return rechazar(error);
      resolver({
        peticiones: tiempos.length,
        porSegundo: Math.round(resultado.requests.average),
        p50: percentil(tiempos, 50),
        p95: percentil(tiempos, 95),
        p99: percentil(tiempos, 99),
        maximo: Math.round(Math.max(...tiempos) * 10) / 10,
        codigos,
        erroresDeRed: resultado.errors + resultado.timeouts,
      });
    });
    instancia.on('response', (_cliente, codigo, _bytes, ms) => {
      tiempos.push(ms);
      codigos[codigo] = (codigos[codigo] || 0) + 1;
    });
  });
}

async function pedir(metodo, ruta, { token, cuerpo, cabeceras = {} } = {}) {
  const respuesta = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ipAlAzar(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...cabeceras,
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await respuesta.text();
  return { status: respuesta.status, cuerpo: texto ? JSON.parse(texto) : null };
}

async function inventario(salida) {
  if (!process.env.DATABASE_URL) return null;
  const { Client } = require('pg');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.delete('schema');
  const cliente = new Client({ connectionString: url.toString() });
  await cliente.connect();
  try {
    const { rows } = await cliente.query(
      `SELECT cupos_totales AS totales, cupos_disponibles AS disponibles
         FROM vuelos.inventario_cabina
        WHERE vuelo_programado_id = $1 AND clase_cabina::text = 'EJECUTIVA'`,
      [salida],
    );
    return rows[0];
  } finally {
    await cliente.end();
  }
}

function fila(nombre, r) {
  const codigos = Object.entries(r.codigos)
    .map(([c, n]) => `${c}×${n}`)
    .join(', ');
  return `| ${nombre} | ${r.peticiones} | ${r.porSegundo ?? '-'} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.maximo} | ${codigos} | ${r.erroresDeRed} |`;
}

(async () => {
  const salidaInforme = [];
  const cabecera =
    '| Prueba | Peticiones | Pet./s | p50 ms | p95 ms | p99 ms | Máx. ms | Códigos | Errores de red |';
  salidaInforme.push(cabecera, '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

  const busqueda = {
    itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: fecha(7) }],
    passengers: { adults: 1 },
  };
  const rBusqueda = await medir({
    url: `${API}/search`,
    connections: CONEXIONES,
    duration: DURACION,
    requests: [
      {
        method: 'POST',
        setupRequest: (req) => ({
          ...req,
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Fingerprint': 'carga-busqueda-0001',
            'X-Forwarded-For': ipAlAzar(),
          },
          body: JSON.stringify(busqueda),
        }),
      },
    ],
  });
  salidaInforme.push(fila(`POST /search (${CONEXIONES} conexiones, ${DURACION} s)`, rBusqueda));

  const rEstado = await medir({
    url: `${API}/flights/LA1400/status?date=${fecha(7)}`,
    connections: CONEXIONES,
    duration: DURACION,
    requests: [
      {
        method: 'GET',
        setupRequest: (req) => ({ ...req, headers: { 'X-Forwarded-For': ipAlAzar() } }),
      },
    ],
  });
  salidaInforme.push(
    fila(`GET /flights/LA1400/status (${CONEXIONES} conexiones, ${DURACION} s)`, rEstado),
  );

  // Holds: HOLDS usuarios a la vez por la cabina ejecutiva de un mismo vuelo
  const clave = 'una frase de prueba bastante larga';
  const tokens = [];
  for (let i = 0; i < HOLDS; i++) {
    const email = `carga-${Date.now()}-${i}@example.com`;
    await pedir('POST', '/auth/register', { cuerpo: { email, password: clave } });
    tokens.push(
      (await pedir('POST', '/auth/login', { cuerpo: { email, password: clave } })).cuerpo
        .access_token,
    );
  }
  const ofertas = (
    await pedir('POST', '/search', {
      cuerpo: {
        ...busqueda,
        itineraries: [{ ...busqueda.itineraries[0], departureDate: fecha(9) }],
      },
      cabeceras: { 'X-Device-Fingerprint': 'carga-holds-0001' },
    })
  ).cuerpo.offers;
  const oferta = ofertas.find(
    (o) =>
      o.itineraries[0].segments.length === 1 &&
      o.itineraries[0].pricingOptions.some((p) => p.cabinClass === 'BUSINESS'),
  );
  const itinerario = oferta.itineraries[0];
  const ejecutiva = itinerario.pricingOptions.find((p) => p.cabinClass === 'BUSINESS');
  const salida = itinerario.segments[0].segmentId;
  const antes = await inventario(salida);
  let siguiente = 0;
  const ganadores = [];
  const rHolds = await medir({
    url: `${API}/offers/hold`,
    connections: HOLDS,
    amount: HOLDS,
    requests: [
      {
        method: 'POST',
        setupRequest: (req, contexto) => {
          const token = tokens[siguiente++ % tokens.length];
          contexto.token = token;
          return {
            ...req,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              'Idempotency-Key': randomUUID(),
              'X-Forwarded-For': ipAlAzar(),
            },
            body: JSON.stringify({
              offerId: oferta.offerId,
              itinerarySelections: [
                {
                  itineraryId: itinerario.itineraryId,
                  cabinClass: 'BUSINESS',
                  fareBrand: ejecutiva.fareBrand,
                },
              ],
              passengersBreakdown: { adults: 1 },
            }),
          };
        },
        onResponse: (status, cuerpo, contexto) => {
          if (status === 201)
            ganadores.push({ holdId: JSON.parse(cuerpo).holdId, token: contexto.token });
        },
      },
    ],
  });
  const despues = await inventario(salida);
  salidaInforme.push(fila(`POST /offers/hold (${HOLDS} a la vez, mismo cupo ejecutivo)`, rHolds));

  console.log(salidaInforme.join('\n'));
  console.log(
    `\nCupo ejecutivo según la búsqueda: ${ejecutiva.availableSeats}; holds ganadores: ${rHolds.codigos[201] || 0}`,
  );
  if (antes) {
    console.log(
      `Inventario (base): antes ${antes.disponibles}/${antes.totales}, después ${despues.disponibles}/${despues.totales}`,
    );
  }
  const ganados = rHolds.codigos[201] || 0;
  const problemas = [];
  if (ganados > ejecutiva.availableSeats) problemas.push('más holds que asientos (sobreventa)');
  if (despues && despues.disponibles < 0) problemas.push('inventario negativo');
  if (antes && despues && antes.disponibles - despues.disponibles !== ganados) {
    problemas.push('el inventario no bajó exactamente lo que se retuvo');
  }
  const otros = Object.keys(rHolds.codigos).filter((c) => !['201', '409'].includes(c));
  if (otros.length) problemas.push(`códigos inesperados en los holds: ${otros.join(', ')}`);
  for (const r of [rBusqueda, rEstado]) {
    if (Object.keys(r.codigos).some((c) => c !== '200'))
      problemas.push('respuestas no 200 en la carga');
  }

  // Limpieza: soltar los holds ganadores (el cupo vuelve)
  for (const { holdId, token } of ganadores)
    await pedir('DELETE', `/offers/hold/${holdId}`, { token });
  const final = await inventario(salida);
  if (final) console.log(`Inventario tras soltar los holds: ${final.disponibles}/${final.totales}`);
  console.log(
    problemas.length
      ? `\nFALLÓ: ${problemas.join('; ')}`
      : '\nOK: sin sobreventa ni inventario negativo',
  );
  process.exit(problemas.length ? 1 : 0);
})().catch((error) => {
  console.error(`FALLÓ: ${error.message}`);
  process.exit(1);
});
