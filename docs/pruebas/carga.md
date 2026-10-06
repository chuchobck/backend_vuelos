# Pruebas de carga ligeras

Fecha: 2026-10-06 · Rama `chore/f11-entrega` · Script: [`scripts/carga.cjs`](../../scripts/carga.cjs)
(autocannon 8, programático).

## Entorno

- Una sola instancia de la API (`node dist/main`, `NODE_ENV=production`, `TRUST_PROXY=1`) y
  PostgreSQL 18 en Docker, en la misma máquina (WSL2, laptop de desarrollo). No es el hardware de
  Render: las cifras sirven para comparar y detectar regresiones, no como capacidad de producción.
- Base recién cargada con `./db/reset.sh` (semilla de 90 días).
- La API limita por IP (20 búsquedas, 60 estados y 30 holds por minuto). Para medir la API y no
  el 429, el script manda un `X-Forwarded-For` distinto en cada petición (con `TRUST_PROXY=1`
  la API lo toma como la IP del cliente). Solo en local.

## Resultados

Corrida 1 (20 conexiones, 15 s por prueba; 60 holds a la vez):

| Prueba | Peticiones | Pet./s | p50 ms | p95 ms | p99 ms | Máx. ms | Códigos | Errores de red |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /search (UIO→GYE, 1 adulto) | 1906 | 127 | 150.8 | 197.0 | 347.1 | 430.5 | 200×1906 | 0 |
| GET /flights/LA1400/status | 22097 | 1473 | 13.2 | 18.5 | 21.7 | 136.7 | 200×22097 | 0 |
| POST /offers/hold, mismo cupo ejecutivo (12 asientos) | 60 | — | 354.9 | 404.1 | 411.3 | 411.3 | 201×12, 409×48 | 0 |

Corrida 2 (50 conexiones, 15 s por prueba; 150 holds a la vez):

| Prueba | Peticiones | Pet./s | p50 ms | p95 ms | p99 ms | Máx. ms | Códigos | Errores de red |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /search | 2034 | 136 | 362.8 | 406.2 | 428.9 | 485.5 | 200×2034 | 0 |
| GET /flights/LA1400/status | 23621 | 1575 | 30.8 | 35.8 | 41.8 | 337.9 | 200×23621 | 0 |
| POST /offers/hold, mismo cupo ejecutivo (12 asientos) | 150 | — | 642.9 | 753.8 | 757.9 | 758.4 | 201×12, 409×138 | 0 |

## Inventario

En las dos corridas el cupo ejecutivo del vuelo (12 asientos según la búsqueda y la base) terminó
con **exactamente 12 holds ganadores** y el resto 409 `OFFER_NO_LONGER_AVAILABLE`: nunca más holds
que asientos. En la base, `cupos_disponibles` pasó de 12/12 a 0/12 (nunca negativo) y, al soltar
los holds, volvió a 12/12. Ningún 500 ni error de red en ninguna prueba.

## Lectura

- **Búsqueda:** p95 de 197 ms con 20 conexiones y 406 ms con 50, por debajo del umbral de 500 ms;
  no se tocaron índices. El rendimiento se aplana en unas 130 búsquedas por segundo: con más
  conexiones solo crece la latencia. Cada búsqueda guarda sus ofertas (`oferta_cabecera` y sus
  itinerarios, unas 40 000 filas tras las dos corridas) y la base reparte la carga entre sus
  conexiones; la purga de las vencidas (30 minutos) la hace la búsqueda siguiente. Si en Render
  hiciera falta más, lo primero a mirar es ese guardado y el tamaño del pool de conexiones.
- **Estado de vuelo:** solo lectura de `vuelo_programado`; más de 1 400 consultas por segundo.
- **Holds:** la latencia sube con la concurrencia porque todos compiten por la misma fila de
  `inventario_cabina` (UPDATE condicionado con bloqueo de fila, que es lo que evita la
  sobreventa). Es el comportamiento buscado.

## Cómo repetirlo

```bash
./db/reset.sh && npm run build
NODE_ENV=production TRUST_PROXY=1 PORT=3010 node dist/main &
npx -y autocannon@8 --version   # deja autocannon en la caché de npx
NODE_PATH=$(dirname "$(find ~/.npm/_npx -path '*node_modules/autocannon/package.json' | head -1)")/.. \
  DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2- | tr -d '"')" \
  node scripts/carga.cjs http://localhost:3010
# CARGA_CONEXIONES, CARGA_SEGUNDOS y CARGA_HOLDS cambian la carga (20, 15 y 60 por defecto)
```

Sale con código 1 si hay sobreventa, inventario negativo, un descuadre entre lo retenido y lo
descontado, o respuestas inesperadas.
