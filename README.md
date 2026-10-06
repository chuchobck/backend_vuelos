<p align="center">
  <img src="docs/logo.svg" alt="Quinde · API de Vuelos" width="380">
</p>

# Quinde · API de Vuelos

Backend del dominio de **vuelos** del Booking Prototipo: implementa el contrato
[GDS Flight Core API v1.5.0.0](contracts/vuelos-openapi.yaml) para vuelos nacionales de Ecuador.

Es un backend NestJS 10 + TypeScript con PostgreSQL 18 (ver [Origen](#origen)). El plan completo, con decisiones, fases y commits,
está en [docs/PLAN.md](docs/PLAN.md).

## Estado

| Fase                                  | Estado                                 |
| ------------------------------------- | -------------------------------------- |
| 0. Base del repo                      | Hecha                                  |
| 1. Núcleo (Prisma, rutas, despliegue) | Hecha en local; falta desplegar Render |
| 2. Transversales                      | Hecha                                  |
| 3. Auth                               | Hecha                                  |
| 4. Catálogo (CRUD de administración)  | Hecha                                  |
| 5. Búsqueda y mapa de asientos        | Hecha                                  |
| 6. Retenciones (hold)                 | Hecha                                  |
| 7. Reservas y boletos                 | Hecha                                  |
| 8. Postventa                          | Hecha                                  |
| 9. Check-in, pases y estado de vuelo  | Hecha                                  |
| 10 y 11                               | Pendiente                              |

Hoy la API expone `GET /flights/v1/health`, la autenticación en `/flights/v1/auth`, el CRUD de
administración del catálogo en `/flights/v1/admin` y estas operaciones del contrato:
`POST /search`, `GET /offers/{offerId}/seatmap`, el bloqueo de cupos en `/offers/hold`, las
reservas con sus boletos en `/bookings`, su postventa (equipaje, cambio de fecha y cancelación), el
check-in con sus pases de abordar y el estado público de un vuelo.

Lo transversal ya está en su sitio y lo heredan todos los endpoints que vengan:

- Todo error sale como `application/problem+json` con el esquema `ProblemDetails` del contrato
  (también un 404 de ruta, un 405, un 413 y un fallo inesperado, sin detalles internos).
- Los errores de Prisma y de los triggers de la base se traducen a un status y un `code` del contrato.
- Validación global de DTO (`whitelist`, `forbidNonWhitelisted`), pipes de uuid, fecha e IATA y
  `@TextoLimpio` para el texto libre ([guía](src/common/sanitizacion/README.md)).
- helmet, CORS por lista de orígenes, cuerpo máximo de 100 kB y límite de peticiones por IP (429 con `Retry-After`).
- `X-Request-Id` en cada respuesta y en cada línea de log.
- Toda ruta exige un JWT salvo las marcadas `@Publico()`, y `@Scopes(...)` exige permisos
  ([cómo proteger un endpoint](src/common/README.md)).

## Requisitos

- Node.js 20.19 o superior (recomendado 22; hay un `.nvmrc`)
- Docker con Docker Compose
- Git

## Arranque

```bash
npm ci                    # dependencias, cliente de Prisma y hook de commits
cp .env.example .env      # variables de entorno locales: completa JWT_SECRET
docker compose up -d      # PostgreSQL 18 en el puerto 5432
./db/reset.sh             # crea la base y carga esquemas + semillas
npm run start:dev         # API en http://localhost:3000
curl localhost:3000/flights/v1/health
```

La API no arranca si falta `DATABASE_URL`, `PORT`, `NODE_ENV` o `JWT_SECRET` (al menos 32
caracteres), o si alguna variable tiene un formato inválido. Para generar la clave:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Para tener un administrador local, pon `SEED_ADMIN_PASSWORD` (12 a 128 caracteres) en tu `.env`
antes de `./db/reset.sh`: se crea `admin@quinde.example` (o `SEED_ADMIN_EMAIL`) con todos los
scopes. Sin esa variable no se crea; la contraseña nunca va a git.

Variables opcionales (todas documentadas en `.env.example`):

| Variable                    | Para qué                                                                                                   | Valor por defecto |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- |
| `CORS_ORIGINS`              | Orígenes de navegador permitidos, separados por coma (`https://app.example.com`, sin ruta ni `*`)          | ninguno           |
| `RATE_LIMIT_MAX`            | Peticiones por IP y por ventana en toda la API                                                             | 100               |
| `RATE_LIMIT_WINDOW_SECONDS` | Duración de la ventana del límite                                                                          | 60                |
| `TRUST_PROXY`               | Proxies delante de la API para leer la IP real (`1` en Render; `true` no se acepta)                        | `false`           |
| `JWT_ISSUER`                | `iss` de los tokens que emite y acepta la API                                                              | quinde-vuelos-api |
| `JWT_AUDIENCE`              | `aud` de los tokens que emite y acepta la API                                                              | quinde-vuelos-api |
| `SEARCH_OFFER_TTL_MINUTES`  | Minutos que vale una oferta de `POST /search` (de 5 a 240)                                                 | 30                |
| `HOLD_TTL_MINUTES`          | Minutos que un hold retiene el cupo (de 1 a 60)                                                            | 15                |
| `HOLD_EXPIRY_JOB_ENABLED`   | Proceso que vence los holds abandonados y borra las claves de idempotencia vencidas (`true` o `false`)    | `true`            |
| `HOLD_EXPIRY_JOB_INTERVAL_SECONDS` | Cada cuántos segundos corre ese proceso (de 5 a 3600)                                               | 60                |
| `BOOKING_ISSUE_JOB_ENABLED` | Proceso que emite los boletos de las reservas con pago pendiente cuando se aprueba (`true` o `false`)      | `true`            |
| `BOOKING_ISSUE_JOB_INTERVAL_SECONDS` | Cada cuántos segundos corre ese proceso (de 5 a 3600)                                             | 30                |
| `CANCELLATION_QUOTE_TTL_MINUTES` | Minutos que vale una cotización de cancelación (de 1 a 60)                                          | 15                |
| `CHANGE_OFFER_TTL_MINUTES`  | Minutos que vale una oferta de cambio de fecha (de 1 a 60)                                                 | 15                |
| `POSTSALE_JOB_ENABLED`      | Proceso que completa maletas, cambios y cancelaciones con pago o reembolso pendiente (`true` o `false`)    | `true`            |
| `POSTSALE_JOB_INTERVAL_SECONDS` | Cada cuántos segundos corre ese proceso (de 5 a 3600)                                                  | 30                |
| `CHECKIN_OPENS_HOURS_BEFORE` | Horas antes de la salida en que abre el check-in de un vuelo (de 2 a 168)                                | 48                |
| `CHECKIN_CLOSES_MINUTES_BEFORE` | Minutos antes de la salida en que cierra (de 15 a 90)                                                  | 60                |

Si los puertos 5432 o 3000 ya están ocupados, cámbialos en `.env`: `DB_PORT` para la base
(junto con el puerto de `DATABASE_URL`) y `PORT` para la API.

Documentación Swagger: <http://localhost:3000/api/docs>

## Scripts

| Comando                   | Qué hace                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `npm run start:dev`       | Levanta la API y recarga al guardar                         |
| `npm run build`           | Compila a `dist/`                                           |
| `npm run test:e2e`        | Pruebas e2e (Jest + supertest); necesitan PostgreSQL arriba |
| `npm run lint`            | Revisa el código con ESLint                                 |
| `npm run lint:fix`        | Igual, corrigiendo lo que se pueda                          |
| `npm run format`          | Aplica Prettier                                             |
| `npm run format:check`    | Verifica el formato sin cambiar archivos                    |
| `npm run prisma:pull`     | Relee el esquema de la base y regenera el cliente de Prisma |
| `npm run prisma:generate` | Regenera el cliente de Prisma (`npm ci` ya lo hace)         |
| `./db/reset.sh`           | Borra, crea y carga la base (esquemas y semillas)           |

## Base de datos

Los archivos de `db/` son la fuente de verdad: la base se crea desde el SQL, no desde el código.

| Archivo                    | Contenido                                                             |
| -------------------------- | --------------------------------------------------------------------- |
| `db/esquema_vuelos.sql`    | Esquema `vuelos` en 3FN: 42 tablas, triggers de integridad, auditoría |
| `db/esquema_seguridad.sql` | Usuarios, roles y tokens de refresco (4 tablas, mismo esquema)        |
| `db/semilla_vuelos.sql`    | Red doméstica de Ecuador: 10 aeropuertos, 50 rutas, salidas a 90 días |
| `db/semilla_seguridad.sql` | Roles cliente y administrador; administrador local si hay contraseña  |
| `db/hash-contrasena.js`    | Calcula el hash argon2id del administrador para la semilla            |
| `db/prueba_esquema.sql`    | Prueba de restricciones, triggers y auditoría                         |
| `db/reset.sh`              | Borra la base, la crea y carga esquemas y semillas                    |

- La semilla genera salidas para los 90 días siguientes al día en que se carga. Pasado ese plazo
  hay que volver a correr `./db/reset.sh`.
- La semilla se carga una sola vez por base; para recargar, siempre `./db/reset.sh`.
- `./db/reset.sh --solo-esquema` deja la base sin datos (tampoco roles: el registro no funciona).
- Las pruebas e2e crean cuentas `@e2e.quinde.example` y catálogo con códigos libres al azar, y lo
  dejan todo dado de baja: no se puede borrar (eliminación lógica). `./db/reset.sh` lo quita
  junto con todo lo demás.
- Prisma no crea ni cambia tablas: un cambio se hace en el SQL, se recarga la base y se corre
  `npm run prisma:pull`. `prisma/schema.prisma` no se edita a mano y no se usa `prisma migrate`.

Para correr la prueba del esquema (deja datos de prueba, por eso se resetea al final):

```bash
./db/reset.sh --solo-esquema
docker exec -i booking_db_container psql -U postgres -d booking_db -q < db/prueba_esquema.sql
./db/reset.sh
```

## Imagen Docker

El `Dockerfile` es la imagen que usará Render. No lleva credenciales: `PORT`, `NODE_ENV`,
`DATABASE_URL` y `JWT_SECRET` llegan del entorno.

```bash
docker build -t quinde-vuelos-api .
docker run --rm -p 3000:3000 -e PORT=3000 -e NODE_ENV=production \
  -e DATABASE_URL="postgresql://...?schema=vuelos" -e JWT_SECRET="..." quinde-vuelos-api
```

## Autenticación

En RDA1 la API hace de proveedor de identidad (en RDA2 se cambia por el real):

| Endpoint                   | Para qué                                                                    |
| -------------------------- | --------------------------------------------------------------------------- |
| `POST /auth/register`      | Crea una cuenta de cliente (`email`, `password` de 12 a 128 caracteres)     |
| `POST /auth/login`         | Entrega `access_token` (JWT, 15 min) y `refresh_token` (7 días)             |
| `POST /auth/refresh`       | Cambia el `refresh_token` por uno nuevo; reusar uno viejo cierra la sesión  |
| `POST /auth/logout`        | Revoca el `refresh_token` (con token de acceso)                             |
| `GET /auth/me`             | Perfil, roles y scopes                                                      |

```bash
curl -X POST localhost:3000/flights/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"ana@example.com","password":"una frase larga y fácil"}'
curl localhost:3000/flights/v1/auth/me -H "Authorization: Bearer <access_token>"
```

En Swagger, el botón **Authorize** → `bearer` recibe el `access_token`. Los roles son `cliente`
(registro público) y `administrador` (todos los scopes más `flights:admin`).

## Búsqueda de vuelos

Las dos operaciones son públicas (sin token), como en el contrato:

| Endpoint                            | Qué hace                                                                       | Límite propio     |
| ----------------------------------- | ------------------------------------------------------------------------------ | ----------------- |
| `POST /search`                      | Ofertas para 1 a 6 tramos (ida, ida y vuelta o multidestino); exige `X-Device-Fingerprint` | 20 por minuto e IP |
| `GET /offers/{offerId}/seatmap`     | Asientos de un segmento de la oferta, con `isAvailable` y sin precios          | 60 por minuto e IP |

- Cada oferta es de una sola aerolínea y trae un itinerario por tramo (directo o con una escala),
  con las familias tarifarias que tienen cupo para todos los pasajeros y el precio por tipo de
  pasajero en texto. Se ordenan por precio y luego por hora; a lo sumo 20.
- Las ofertas se guardan y vencen a los 30 minutos (`SEARCH_OFFER_TTL_MINUTES`); cada búsqueda
  borra las vencidas que ninguna retención usa. La búsqueda no toma cupos.
- Sin resultados responde 200 con la lista vacía.

```bash
curl -X POST localhost:3000/flights/v1/search -H 'Content-Type: application/json' \
  -H 'X-Device-Fingerprint: b3f1c2a4-9d8e-4f6a-8b1c-2d3e4f5a6b7c' \
  -d '{"itineraries":[{"origin":"UIO","destination":"GYE","departureDate":"2026-10-20"}],"passengers":{"adults":1}}'
```

La semilla genera salidas para los 90 días siguientes al día en que se cargó: elige una fecha en
esa ventana. UIO-GPS no tiene vuelo directo y sale con escala en GYE.

## Bloqueo de cupos (hold)

Las tres operaciones exigen token, como en el contrato:

| Endpoint                     | Scope          | Qué hace                                                         |
| ---------------------------- | -------------- | ---------------------------------------------------------------- |
| `POST /offers/hold`          | `flights:hold` | Toma el cupo y congela el precio; exige `Idempotency-Key` (uuid) |
| `GET /offers/hold/{holdId}`  | `flights:read` | `HELD`, `RELEASED`, `EXPIRED` o `CONSUMED`, con `remainingSeconds` |
| `DELETE /offers/hold/{holdId}` | `flights:hold` | Libera el hold y devuelve el cupo (204)                        |

- El cuerpo lleva una selección (`cabinClass` + `fareBrand`, una de las `pricingOptions`) por cada
  itinerario de la oferta y los pasajeros, con las mismas reglas de la búsqueda (a lo sumo 9 con
  asiento, no más infantes que adultos). Los infantes viajan en brazos y no toman cupo.
- El precio es el de la tarifa en el momento del hold, para todos los pasajeros, y queda
  congelado aunque la tarifa cambie después.
- Oferta vencida o inexistente, tarifa que ya no se vende o falta de cupo: 409
  `OFFER_NO_LONGER_AVAILABLE`. Un itinerario ajeno a la oferta o una familia que la aerolínea no
  tiene: 422.
- La misma `Idempotency-Key` con el mismo cuerpo devuelve la misma respuesta (201, con
  `Idempotent-Replayed: true`) durante 24 horas; con otro cuerpo, 422. La clave es de cada usuario.
- El hold vence a los `HOLD_TTL_MINUTES` y el cupo vuelve: al consultarlo, al competir por esas
  salidas o con el proceso periódico (`HOLD_EXPIRY_JOB_INTERVAL_SECONDS`).
- Cada hold es de quien lo creó: el de otro usuario responde 404. Un administrador puede
  consultar cualquiera, pero solo el dueño lo libera.
- `POST` tiene un límite propio de 30 por minuto e IP.

```bash
curl -X POST localhost:3000/flights/v1/offers/hold -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" \
  -d '{"offerId":"<offerId>","itinerarySelections":[{"itineraryId":"<itineraryId>","cabinClass":"ECONOMY","fareBrand":"BASIC"}],"passengersBreakdown":{"adults":1}}'
```

## Reservas y boletos

| Endpoint                                     | Scope          | Qué hace                                                                 |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| `POST /bookings`                             | `flights:book` | Crea la reserva desde un hold y emite los boletos; exige `Idempotency-Key` |
| `GET /bookings`                              | `flights:read` | Las reservas del usuario, por cursor (`limit`, `pnr`, `status`, fechas)    |
| `GET /bookings/{bookingId}`                  | `flights:read` | Itinerarios, pasajeros con sus asientos, boletos e historial             |
| `GET /bookings/{bookingId}/tickets`          | `flights:read` | Un boleto por pasajero, con un cupón por vuelo                           |
| `GET /bookings/{bookingId}/tickets/{ticketId}` | `flights:read` | Un boleto                                                              |

- El dueño sale del token y es el mismo del hold: una reserva o un hold de otro usuario no existen
  para nadie más (404 en las consultas, 422 para el `holdId` de POST, que no declara 404).
- Los pasajeros son los del hold (mismos tipos y cantidades). La edad el día de la primera salida
  decide el tipo: INFANT menos de 2, CHILD de 2 a 11, YOUTH de 12 a 17, ADULT 18 o más. Cada
  infante lleva el `passengerId` de un adulto (`associatedAdultId`) y no ocupa asiento. La cédula
  ecuatoriana se valida con su dígito verificador; el pasaporte exige vencimiento posterior al viaje.
- Asientos: el elegido en `assignedSeats` (de la cabina del hold y libre) o, si no se elige, el
  primero libre de esa cabina por fila y letra.
- El pago lo hace la Payment API (simulada en RDA1): `paymentReference` `PAY-OK-…` aprueba (201,
  boletos emitidos), `PAY-PEND-…` queda pendiente (202, el proceso periódico emite los boletos al
  aprobarse) y `PAY-REJ-…` se rechaza (422 `PAYMENT_NOT_AUTHORIZED`, sin reserva y con el hold
  intacto). Otra referencia: 422 `PAYMENT_REFERENCE_INVALID`. Una referencia acredita una sola operación.
- Hold vencido o liberado: 410. Ya usado en otra reserva: 409. El precio es el congelado en el hold.
- PNR de 6 caracteres sin 0, O, 1, I ni L. Número de boleto: el prefijo de 3 dígitos de la
  aerolínea y 10 dígitos.
- `POST` tiene un límite propio de 10 por minuto e IP.

```bash
curl -X POST localhost:3000/flights/v1/bookings -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" \
  -d '{"holdId":"<holdId>","payment":{"paymentReference":"PAY-OK-7F3A9C21"},"passengers":[{"passengerId":"PAX1","passengerType":"ADULT","firstName":"Ana","lastName":"Pérez","documentType":"NATIONAL_ID","documentNumber":"1710034065","nationality":"EC","birthDate":"1990-04-15","gender":"F","contact":{"email":"ana@example.com","phone":"+593991234567"}}]}'
```

## Postventa

Sobre una reserva `CONFIRMED` del usuario (otra reserva es 404; otro estado, o un vuelo que ya
salió, 409):

| Endpoint                                          | Scope            | Qué hace                                                    |
| ------------------------------------------------- | ---------------- | ----------------------------------------------------------- |
| `GET /bookings/{bookingId}/baggage-options`       | `flights:read`   | Precio de una maleta, máximo y ya comprado, por pasajero e itinerario |
| `POST /bookings/{bookingId}/baggage`              | `flights:book`   | Compra maletas; `Idempotency-Key`; 200 o 202 si el pago queda pendiente |
| `POST /bookings/{bookingId}/date-change/search`   | `flights:read`   | Opciones de la misma ruta, aerolínea y familia en la nueva fecha, con la diferencia |
| `POST /bookings/{bookingId}/date-change`          | `flights:book`   | Confirma una opción; `Idempotency-Key`; 200 o 202 (CHANGE_PENDING) |
| `GET /bookings/{bookingId}/cancellation-quote`    | `flights:read`   | Cotiza el reembolso (vigente 15 minutos)                    |
| `POST /bookings/{bookingId}/cancel`               | `flights:cancel` | Cancela con la cotización; `Idempotency-Key`; 200 o 202 (CANCELLATION_PENDING) |

- **Equipaje.** El precio es el `extraBagPrice` de la tarifa (sumado sobre los vuelos del
  itinerario) y el máximo, el `maxExtraBags` de la familia; un infante no compra. Se cobra con
  una `paymentReference` nueva, con la misma regla simulada que la reserva.
- **Cambio de fecha.** `totalToPay = max(0, fareDifference + taxDifference) + changeFee`: lo que
  baja la tarifa no se devuelve y el cargo (`changeFee` de la tarifa original, por pasajero con
  asiento) se cobra siempre. La opción vence a los 15 minutos (410 después) y no toma cupo hasta
  confirmarla; al confirmar, los asientos se reasignan y los boletos se vuelven a emitir (los
  anteriores quedan `VOIDED`). Una familia no cambiable es 409 `FARE_NOT_CHANGEABLE`.
- **Cancelación.** De lo pagado por cada itinerario (tarifa, impuestos y maletas) se devuelve
  `100 − cancellationPenaltyPercent` de su familia; los cargos por cambio no se devuelven. Cancelar
  libera asientos y cupo y anula los boletos; con el reembolso aprobado quedan `REFUNDED`. Una
  cotización vencida es 409 `QUOTE_EXPIRED`.
- El reembolso sigue al pago de la reserva en la Payment API simulada: pagada con `PAY-OK-…`, se
  aprueba al pedirlo (200); con `PAY-PEND-…`, queda pendiente (202) y el proceso la completa.
- Límites propios por minuto e IP: 10 compras de maletas, 20 búsquedas de cambio, 10 cambios y
  10 cancelaciones.

## Check-in, pases de abordar y estado de vuelo

| Endpoint                                        | Scope          | Qué hace                                                       |
| ----------------------------------------------- | -------------- | -------------------------------------------------------------- |
| `POST /bookings/{bookingId}/check-in`           | `flights:book` | Check-in de todos los pasajeros en cada vuelo con la ventana abierta |
| `GET /bookings/{bookingId}/boarding-passes`     | `flights:read` | Los pases de abordar de los pasajeros con check-in             |
| `GET /flights/{flightNumber}/status?date=`      | **público**    | Estado operativo de un vuelo en su fecha local de salida       |

- **Ventana.** Cada vuelo abre 48 horas antes de su salida programada y cierra 60 minutos antes
  (`CHECKIN_OPENS_HOURS_BEFORE`, `CHECKIN_CLOSES_MINUTES_BEFORE`), y solo mientras el vuelo es
  `SCHEDULED` o `DELAYED`.
- **Check-in.** La reserva debe estar `CONFIRMED` con sus boletos emitidos (si no, 409
  `CHECK_IN_NOT_AVAILABLE`). Sin ningún vuelo en ventana y sin check-in previo, 409 diciendo cuándo
  abre o que cerró. Si no, 200 con lo registrado: un vuelo que todavía no abre queda
  `NOT_CHECKED_IN` y uno que ya cerró, `FAILED` (resultado parcial, `IN_PROGRESS`); `COMPLETED` es
  todos en todos los vuelos. Conserva el asiento ya asignado y un infante lo hace con su adulto y sin
  asiento (`seat: null`). Es idempotente (no pide `Idempotency-Key`): repetirlo no cambia nada.
  Un asiento sin asignar o un pasaporte que vence antes del vuelo es 422 `CHECK_IN_FAILED`.
- **Pases.** Se emiten al hacer el check-in y no cambian. Sin check-in, 200 con la lista vacía; un
  infante no tiene pase propio. El `barcode` es un texto firmado
  (`BP1|PNR|boleto|vuelo|fecha|ruta|asiento|orden|firma`), sin datos personales. Grupo de abordaje
  por cabina (1 ejecutiva, 2 económica premium, 3 económica) y posición por fila; PDF417 en
  económica y AZTEC en las demás.
- **Estado de vuelo.** Sin token, 60 consultas por minuto e IP. Las horas van en UTC;
  `estimatedAt`, `actualAt` y `terminal` son `null` mientras la base no los tenga. `date` es la
  fecha local de salida en el aeropuerto de origen (Galápagos va una hora detrás del continente).
- Límite propio de `POST .../check-in`: 20 por minuto e IP.

```bash
curl "localhost:3000/flights/v1/flights/LA1400/status?date=2026-10-20"
curl -X POST localhost:3000/flights/v1/bookings/<bookingId>/check-in -H "Authorization: Bearer $TOKEN"
```

## Catálogo de administración

CRUD de las 10 entidades de catálogo, fuera del contrato y solo con el scope `flights:admin` (el
administrador que siembra `./db/reset.sh` lo tiene). En Swagger están bajo las etiquetas
`Admin · <Entidad>`.

| Ruta                     | Id en la URL                        | Detalle que maneja sin controller propio |
| ------------------------ | ----------------------------------- | ---------------------------------------- |
| `/admin/countries`       | código ISO alfa-2 (`EC`)            |                                          |
| `/admin/cities`          | uuid                                |                                          |
| `/admin/airports`        | código IATA (`UIO`)                 |                                          |
| `/admin/airlines`        | código IATA (`AV`)                  |                                          |
| `/admin/aircraft-models` | código IATA (`320`)                 |                                          |
| `/admin/fare-families`   | uuid                                |                                          |
| `/admin/seat-maps`       | uuid                                | filas y asientos físicos                 |
| `/admin/flights`         | número de vuelo (`AV1234`)          |                                          |
| `/admin/departures`      | uuid (el `segmentId` del contrato)  | cupos por cabina                         |
| `/admin/fares`           | uuid                                | precios por tipo de pasajero             |

Cada una tiene `GET` (lista paginada), `GET /:id`, `POST`, `PATCH /:id` (parcial),
`DELETE /:id` y `POST /:id/reactivate`:

- `DELETE` es una baja lógica: responde 204 y deja la fila con `activo = false` (una salida
  queda `CANCELLED`). Nunca borra. Si otras filas activas la usan, responde 409 diciendo cuáles.
- Las listas ocultan lo dado de baja; `?includeInactive=true` lo incluye. Paginan como el contrato:
  `?limit=` (10 por defecto, 50 como máximo) y `?cursor=` con el `nextCursor` de la página anterior.
- Una referencia a algo que no existe o está dado de baja responde 422; una clave repetida, 409.
- El dinero viaja en texto (`"35.00"`), nunca como número.

```bash
TOKEN=$(curl -s -X POST localhost:3000/flights/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@quinde.example","password":"<SEED_ADMIN_PASSWORD>"}' | jq -r .access_token)
curl "localhost:3000/flights/v1/admin/departures?flightNumber=AV1500&limit=5" -H "Authorization: Bearer $TOKEN"
```

## Cómo se trabaja

- Una rama por fase (`feat/f1-nucleo`, `feat/f2-transversales`, ...) y un pull request a `main`.
- Mensajes de commit en formato Conventional Commits y en español:
  `tipo(ámbito): verbo en infinitivo y qué cambia`. Un hook los valida al hacer commit.

  ```text
  feat(reservas): crear reserva desde un hold
  fix(docker): usar postgres 18
  ```

- Antes de subir: `npm run lint && npm run format:check && npm run build && npm run test:e2e`.
- Las reglas permanentes del proyecto están en [CLAUDE.md](CLAUDE.md).
- `.env` nunca se sube; una variable nueva se agrega a `.env.example` en el mismo commit.

## Origen

Este repositorio es solo del dominio de vuelos; los demás dominios del Booking Prototipo viven en los
repos de sus equipos. Nació de la plantilla del equipo
([Plantilla-Integracion-Sistemas](https://github.com/semestre5grupal-ops/Plantilla-Integracion-Sistemas)),
que queda como remoto `upstream` solo como referencia histórica: ya no se traen cambios de ahí.
