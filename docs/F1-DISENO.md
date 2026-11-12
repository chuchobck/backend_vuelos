# Fase F1 · Embarque, kiosko y salidas públicas (diseño)

Tres operaciones nuevas del core, fuera del contrato de Booking, bajo `/flights/v1`. No es un
microservicio nuevo: son tres entidades más del dominio de vuelos, con la estructura de siempre
(controller, routes, module, service, repository, mapper y `dto/`).

| Pieza | Carpeta | Quién la usa | Seguridad |
| --- | --- | --- | --- |
| Embarque | `src/modules/vuelos/administracion/embarque/` | El agente de la puerta | `flights:admin` |
| Kiosko | `src/modules/vuelos/operaciones/kiosko/` | El kiosko de check-in, sin cuenta | `@Publico()` + sesión de kiosko |
| Salidas públicas | `src/modules/vuelos/operaciones/tablero-salidas/` | La pantalla de vuelos | `@Publico()` |

## 1. Lo que ya existe y se reutiliza

- `CodigoPase` (`pase-abordar/codigo-pase.ts`) genera y **verifica** el código
  `BP1|PNR|boleto|vuelo|aaaammdd|ORIDES|asiento|orden|firma`: la firma son 12 hex de un HMAC-SHA256
  con una clave derivada de `BOARDING_PASS_SECRET` (o `JWT_SECRET`), comparada con `timingSafeEqual`.
  El embarque usa `verificar()` tal cual; no hay otra implementación de la firma.
- `CheckinService.hacer(reservaId, idPropietario)` y `PaseAbordarService.consultar(reservaId,
  idPropietario)`: el kiosko los llama con el dueño real de la reserva. Ninguna regla del check-in se
  copia.
- `ReservaService.detalle` (la reserva completa) y `ReservaService.bloquear` (bloqueo de la reserva en
  una transacción: el embarque se pone en la misma fila que la cancelación y el cambio de fecha).
- `PrismaService.transaccionAuditada`: `checkin` ya tiene el trigger de auditoría; marcar el abordaje
  es un UPDATE de esa tabla y queda en `auditoria` con el `sub` del agente, sin código extra.
- `@LimiteEstricto`, `AlmacenLimites` (con el `Reloj`) y `@Publico()`.

## 2. Cambio de esquema (migración `007_embarque.sql`)

| Tabla | Columna | Para qué |
| --- | --- | --- |
| `checkin` | `fecha_abordaje timestamptz NULL` | NULL = no abordó. Se llena una sola vez, con la hora del `Reloj` |
| `vuelo_programado` | `puerta_salida text NULL` | La puerta de la pantalla de salidas. La pone el administrador (`departureGate` en `/admin/departures`) |

- `ck_checkin_abordaje`: `fecha_abordaje IS NULL OR estado = 'REGISTRADO'` (solo aborda quien tiene
  check-in registrado).
- `ix_checkin_abordado (vuelo_programado_id) WHERE fecha_abordaje IS NOT NULL` para el manifiesto.
- `ck_vuelo_programado_puerta_salida`: sin espacios sobrantes ni vacía, a lo más 10 caracteres.
- No hay tabla nueva ni ENUM nuevo: el abordaje es un hecho del check-in (uno por pasajero y salida),
  así que vive en su fila. Una tabla `abordaje` aparte duplicaría la clave (pasajero, salida) y pediría
  su propio trigger de auditoría; un estado `ABORDADO` en `estado_checkin` cambiaría el índice único
  `uq_checkin_registrado` y todas las consultas que hoy filtran `estado = 'REGISTRADO'`.
- Se deshace el abordaje con un UPDATE auditado (no hay endpoint para eso en esta fase: pendiente).
- Casos en `db/prueba_esquema.sql`; `scripts/comprobar-migraciones.sh` compara la base migrada con la
  nueva.

## 3. Embarque (`flights:admin`)

Rutas bajo `/flights/v1/admin/departures/{departureId}/boarding` (`departureId` es
`vuelo_programado.id`, el `segmentId` del contrato, el mismo id de `/admin/departures`):

### `POST .../boarding/scan`

Cuerpo `{ "barcode": "BP1|..." }`. Límite propio: 120 por minuto e IP (una puerta escanea rápido).
Validaciones, en este orden, cada una con su `code` (propios del proyecto, ver sección 7):

| # | Qué se comprueba | Status | `code` |
| --- | --- | --- | --- |
| 1 | El texto tiene el formato `BP1\|...` | 400 | `BOARDING_PASS_MALFORMED` |
| 2 | La firma es la que genera `CodigoPase` | 422 | `BOARDING_PASS_SIGNATURE_INVALID` |
| 3 | La salida existe | 404 | (genérico, como todo 404) |
| 4 | La salida no está cancelada | 409 | `FLIGHT_CANCELLED` |
| 5 | La salida no despegó ya (DESPEGADO, ATERRIZADO, DESVIADO) | 409 | `FLIGHT_ALREADY_DEPARTED` (del contrato) |
| 6 | El pase es de ESA salida (vuelo, fecha y ruta del código) | 409 | `BOARDING_PASS_WRONG_FLIGHT` |
| 7 | El boleto existe y es del PNR del código | 404 | `BOARDING_PASS_NOT_FOUND` |
| 8 | Reserva `CONFIRMADA`, boleto y cupón `EMITIDO`, la salida sigue en un itinerario vigente | 409 | `BOARDING_PASS_NOT_VALID` |
| 9 | El pasajero tiene check-in `REGISTRADO` en esa salida | 409 | `PASSENGER_NOT_CHECKED_IN` |
| 10 | El código es el del pase emitido para ese check-in (mismo asiento) | 409 | `BOARDING_PASS_NOT_VALID` |
| 11 | No abordó ya | 409 | `ALREADY_BOARDED` |

Las comprobaciones 1 y 2 no tocan la base. De la 7 en adelante corren dentro de una
`transaccionAuditada` que primero bloquea la reserva (`ReservaService.bloquear`), y el abordaje es:

```sql
UPDATE vuelos.checkin SET fecha_abordaje = <Reloj>
 WHERE id = <checkin> AND estado = 'REGISTRADO' AND fecha_abordaje IS NULL
RETURNING id
```

Dos escaneos a la vez del mismo pase: el segundo espera el bloqueo de la reserva, el UPDATE ya no
encuentra `fecha_abordaje IS NULL` y recibe 409 `ALREADY_BOARDED`. Aunque no hubiera bloqueo, el
UPDATE condicionado deja ganar a uno solo.

Un infante no tiene pase (viaja en brazos): aborda con el pase de su adulto responsable, en la misma
transacción y con la misma hora.

Respuesta 200:

```json
{
  "result": "BOARDED",
  "departureId": "…",
  "flightNumber": "LA1400",
  "seat": "10A",
  "boardingGroup": "3",
  "boardingPosition": "010",
  "boardedAt": "2026-11-12T10:20:00.000Z",
  "passenger": { "passengerId": "ADU1", "firstName": "Ana María", "lastName": "D'Alessio Pérez" },
  "infants": [{ "passengerId": "INF3", "firstName": "…", "lastName": "…" }]
}
```

**El nombre del pasajero es una excepción deliberada** a la regla "los datos de un pasajero solo los
ve el dueño": el agente lo compara con el documento que tiene en la mano. Se limita a esta respuesta
(200 del escaneo), con `Cache-Control: no-store`; ningún error, log, traza ni el manifiesto lo llevan.
Sin documento, correo ni teléfono.

### `GET .../boarding/manifest`

Para la pantalla de la puerta. Conteos y una fila por asiento, **sin nombres, documento ni correo**:

```json
{
  "departureId": "…", "flightNumber": "LA1400", "date": "2026-11-12",
  "origin": "UIO", "destination": "GYE", "status": "SCHEDULED", "gate": "A3",
  "counts": { "sold": 3, "checkedIn": 2, "boarded": 1,
              "infants": { "sold": 1, "checkedIn": 1, "boarded": 0 } },
  "seats": [
    { "seat": "10A", "cabinClass": "ECONOMY", "pnr": "K7M2QX", "passengerId": "ADU1",
      "status": "BOARDED", "boardingGroup": "3", "boardedAt": "2026-11-12T10:20:00.000Z" }
  ]
}
```

- "Vendido" es un asiento asignado y sin liberar en esa salida (`reserva_detalle_asiento`), la misma
  definición de "ocupado" del mapa de asientos. `status` es `BOOKED`, `TICKETED`, `CHECKED_IN` o
  `BOARDED` (los nombres de `SeatStatus` del contrato v2).
- `pnr` y `passengerId` son identificadores públicos (regla de CLAUDE.md): con ellos el agente busca
  la reserva en `/admin/bookings?pnr=`.
- Los infantes no tienen asiento: van solo en `counts.infants`.

### Lo que el embarque no hace

- No mueve cupo: no llama a `OrdenesStock`.
- No publica eventos: no hay tipo de evento `booking.boarded` (los esquemas son del notifier). Pendiente.
- No cambia el estado de la salida a `EMBARCANDO`: eso sigue siendo `PATCH /admin/departures/{id}`.

### Mapa de asientos v2

`FachadaV2Repository.estadosDeAsientos` suma `BOARDED` cuando el check-in del asiento tiene
`fecha_abordaje`. `SeatStatus` del contrato v2 ya lo trae; se corrige `docs/V2-DIFERENCIAS.md`.

## 4. Kiosko (sin cuenta, por PNR y apellido)

### Cómo se autoriza: una sesión de kiosko firmada, corta y de una sola reserva

`POST /flights/v1/kiosk/lookup` (público) recibe `{ pnr, lastName }`. Si coinciden, responde la
reserva (lo mínimo) y un `kioskToken`. Las dos operaciones que siguen lo exigen en
`Authorization: Kiosk <token>`:

- `POST /flights/v1/kiosk/bookings/{bookingId}/check-in`
- `GET  /flights/v1/kiosk/bookings/{bookingId}/boarding-passes`

El token es `ksk1.<payload>.<firma>` (base64url): el payload es `{ r: <bookingId>, e: <vence, epoch
s> }` y la firma, un HMAC-SHA256 completo con una clave derivada **solo para este uso**
(`HMAC(secreto, 'quinde-vuelos:sesion-kiosko')`, con el mismo secreto base que los pases:
`BOARDING_PASS_SECRET` o `JWT_SECRET`). Vale 10 minutos según el `Reloj`.

Por qué así y no de otra forma:

| Alternativa | Por qué no |
| --- | --- |
| Mandar PNR y apellido en cada llamada | El secreto viajaría y se validaría tres veces; cada llamada sería otra oportunidad de adivinarlo y habría que limitar las tres como la búsqueda |
| Un JWT de acceso normal (un "usuario kiosko") | Tendría scopes de cliente (`flights:book`…) sobre **todas** las reservas del dueño, o habría que inventar un usuario por reserva. `AUTH_MODE=external` ni siquiera emite tokens en el core |
| Sesión en la base (tabla `sesion_kiosko`) | Otra tabla, otra purga y otra migración para algo que vive 10 minutos. Lo único que ganaría es revocar, y el daño posible de un token robado es hacer el check-in de esa reserva o ver sus pases durante 10 minutos |
| El token en la URL | Quedaría en logs de proxies y en el historial; la cabecera no |

Propiedades:

- **Limitado a una reserva**: el `bookingId` de la URL tiene que ser el del token; si no, 404 (el
  mismo de una reserva ajena: no se revela que existe). El token de la reserva A no sirve para la B.
- **No es un token de acceso**: otra clave (derivada), otro formato y otro esquema de
  `Authorization` (`Kiosk`, no `Bearer`). `JwtAuthGuard` nunca lo acepta en una ruta protegida, y un
  JWT de acceso no pasa por sesión de kiosko.
- **Sin estado**: sirve con varias instancias y sobrevive un reinicio. No se revoca: vence solo.
- Vencido, alterado o ausente: 401 `KIOSK_SESSION_INVALID` con `WWW-Authenticate: Kiosk`. El kiosko
  vuelve a pedir PNR y apellido.
- Cada uso relee la reserva: si se canceló después de la búsqueda, el check-in responde su 409 de
  siempre.
- `Authorization` ya está entre las cabeceras de CORS del core y del gateway, y el gateway la reenvía
  intacta en una ruta pública: no hace falta una cabecera nueva.
- No se liga a la IP: varios kioskos salen por la misma, y un proxy la cambia.

Auditoría: el check-in del kiosko queda en `auditoria` con `id_usuario = 'kiosko'` (no hay `sub`).

### La búsqueda

- `pnr`: 6 letras o dígitos; se comparan en mayúsculas. `lastName`: de 1 a 100 caracteres.
- El apellido se normaliza en los dos lados: NFD, sin marcas diacríticas, en mayúsculas y solo letras y
  dígitos (`"D'Alessio Pérez"`, `"dalessio perez"` y `"D ALESSIO PEREZ"` son `DALESSIOPEREZ`). Tiene
  que ser el apellido completo de **algún** pasajero de la reserva (no vale solo el primero: "De" o
  "San" serían secretos de dos letras).
- **Sin enumeración**: PNR inexistente y apellido que no coincide dan el mismo 404, con el mismo
  cuerpo (`detail: "Booking not found"`).
- **Sin fugas de tiempo**: se compara el HMAC-SHA256 (clave aleatoria del proceso) del apellido recibido
  con el de cada pasajero, con `timingSafeEqual` y sin cortar en la primera coincidencia; si el PNR
  no existe se compara igual contra un valor de relleno. Las dos ramas hacen una consulta y al menos
  una comparación.
- **Límite propio**: `@LimiteEstricto(10, 60)` por IP, además del global. Check-in del kiosko: 20 por
  minuto (como el del contrato); pases: 60.
- Ni el PNR ni el apellido van a logs, trazas, métricas ni mensajes de error: viajan en el cuerpo de un
  POST (la línea de acceso no lleva cuerpo ni query, y `route` es la plantilla), y un error de
  validación nombra el campo, no el valor.

Respuesta 200 de la búsqueda (solo lo que el kiosko necesita; sin documento, correo, teléfono, precio,
historial, boletos ni PNR):

```json
{
  "kioskToken": "ksk1.…", "expiresAt": "2026-11-12T10:10:00.000Z",
  "booking": {
    "bookingId": "…", "status": "CONFIRMED",
    "passengers": [{ "passengerId": "ADU1", "passengerType": "ADULT",
                     "firstName": "Ana María", "lastName": "D'Alessio Pérez" }],
    "flights": [{
      "segmentId": "…", "flightNumber": "LA1400", "origin": "UIO", "destination": "GYE",
      "departureAt": "…Z", "arrivalAt": "…Z", "departureTerminal": null, "status": "SCHEDULED",
      "checkIn": { "window": "OPEN", "opensAt": "…Z", "closesAt": "…Z" },
      "passengers": [{ "passengerId": "ADU1", "seat": "10A", "checkInStatus": "NOT_CHECKED_IN" }]
    }]
  }
}
```

El estado de check-in por vuelo sale de `CheckinService` (un método de lectura nuevo, `estadoDe`,
que usa el mismo `armar` y la misma ventana que `hacer`): nada se recalcula en el kiosko.

Las dos operaciones con sesión devuelven exactamente `CheckInResponse` y `BoardingPassListResponse`
del contrato (mismos services, mismos mappers).

## 5. Salidas públicas

`GET /flights/v1/airports/{iataCode}/departures?date=YYYY-MM-DD&limit=&cursor=`: público,
`@LimiteEstricto(60, 60)` (como el estado de un vuelo), `Cache-Control: no-store`.

- `date` es la fecha **local** del aeropuerto (`vuelo_programado.fecha_salida`); sin `date`, hoy en la
  zona del aeropuerto según el `Reloj`.
- Orden por hora programada (e id). `limit` de 1 a 100 (50 por defecto); `nextCursor` opaco.
- Incluye las canceladas (una pantalla las muestra). Aeropuerto inexistente o inactivo: 404.
- Las horas van en **hora local del aeropuerto, con su desplazamiento** (`2026-11-12T06:30:00-05:00`):
  es lo que muestra una pantalla, y con el desplazamiento siguen siendo un instante sin ambigüedad. Es
  la única operación que no responde en UTC (ver discrepancia 4.10).

```json
{
  "airport": { "iataCode": "UIO", "name": "…", "city": "Quito", "timeZone": "America/Guayaquil" },
  "date": "2026-11-12",
  "departures": [{
    "flightNumber": "LA1400", "airline": "LATAM Airlines Ecuador",
    "destination": { "iataCode": "GYE", "city": "Guayaquil" },
    "scheduledTime": "2026-11-12T06:30:00-05:00", "estimatedTime": null,
    "status": "SCHEDULED", "terminal": null, "gate": "A3"
  }],
  "nextCursor": "…"
}
```

Sin reservas, cupos ni pasajeros.

## 6. Rutas, scopes y Swagger

| Método y ruta (`/flights/v1`) | Seguridad | Límite propio |
| --- | --- | --- |
| `POST /admin/departures/{departureId}/boarding/scan` | `flights:admin` | 120/min |
| `GET /admin/departures/{departureId}/boarding/manifest` | `flights:admin` | — |
| `POST /kiosk/lookup` | pública | 10/min |
| `POST /kiosk/bookings/{bookingId}/check-in` | pública + `Authorization: Kiosk` | 20/min |
| `GET /kiosk/bookings/{bookingId}/boarding-passes` | pública + `Authorization: Kiosk` | 60/min |
| `GET /airports/{iataCode}/departures` | pública | 60/min |

- No hay scope nuevo: el embarque es personal de la aerolínea, que hoy es `flights:admin`. Un scope
  `flights:boarding` para un rol "agente de puerta" queda pendiente (hoy el rol administrador puede
  todo lo demás).
- Etiquetas de Swagger nuevas, después de las 7 del contrato: `Admin · Embarque`, `Kiosko` y
  `Salidas públicas`.
- `test/swagger.e2e-spec.ts`: las rutas de `/admin/` ya son "propias"; las cuatro de kiosko y salidas
  van a `DIFERENCIAS_ACEPTADAS` con su motivo.

## 7. Códigos de error propios

El contrato cierra la lista de `code`. Como `AUTH_UNAVAILABLE`, estos son propios del proyecto y solo
salen en rutas que el contrato no tiene (`docs/DISCREPANCIAS-CONTRATO.md`, 2.5):
`BOARDING_PASS_MALFORMED`, `BOARDING_PASS_SIGNATURE_INVALID`, `BOARDING_PASS_NOT_FOUND`,
`BOARDING_PASS_NOT_VALID`, `BOARDING_PASS_WRONG_FLIGHT`, `PASSENGER_NOT_CHECKED_IN`, `ALREADY_BOARDED`,
`FLIGHT_CANCELLED` y `KIOSK_SESSION_INVALID`. Ningún `detail` lleva nombre, documento, PNR ni el
código escaneado.

## 8. Gateway (`gateway_vuelos`, solo lectura)

- `/flights/v1/admin/**` ya va al core exigiendo `flights:admin`: **el embarque pasa sin cambios**.
- `/flights/v1/**` usa el contrato v1 y, para lo que el contrato no declara, **exige un token válido**
  (`noDeclarada: 'token'`). El kiosko y la pantalla no tienen token: hoy recibirían 401 en el borde.
  Hacen falta dos reglas públicas antes de `/flights/v1/**`: `/flights/v1/kiosk/**` (con
  `limiteEstricto` al menos en `lookup`) y `/flights/v1/airports/*/departures`.
- `Authorization: Kiosk …` pasa intacta por una ruta pública (el gateway no la mira) y ya está en su
  lista de CORS. No se cambia el gateway en esta fase.

## 9. Pruebas

- `test/embarque.e2e-spec.ts`: cada validación con su `code`, el caso feliz (auditoría con el agente),
  el infante que aborda con su adulto, dos escaneos simultáneos (uno 200 y otro `ALREADY_BOARDED`), el
  manifiesto (conteos, sin datos personales), 401/403 sin `flights:admin`, y `BOARDED` en el mapa v2.
- `test/kiosko.e2e-spec.ts`: búsqueda con mayúsculas, tildes y espacios; el mismo 404 byte a byte para
  PNR inexistente y apellido errado; el token de una reserva no sirve para otra; token alterado,
  vencido (con `RelojDePrueba`) y ausente; check-in y pases iguales a los del contrato; límite propio;
  nada de PNR ni apellido en el log.
- `test/tablero-salidas.e2e-spec.ts`: hora local con desplazamiento, fecha local, puerta, paginación,
  canceladas, 400 y 404, sin token.
- Contrato y Swagger: `DIFERENCIAS_ACEPTADAS`; el esquema, con `db/prueba_esquema.sql` y
  `scripts/comprobar-migraciones.sh`.

## 10. Decisiones tomadas sin consultar

1. El abordaje es una columna de `checkin`, no una tabla ni un estado nuevo (sección 2).
2. Se agrega `vuelo_programado.puerta_salida` ("puerta si existe": no existía dónde guardarla) y el
   campo `departureGate` en `/admin/departures`.
3. Embarcar exige además que la salida no haya despegado (`FLIGHT_ALREADY_DEPARTED`).
4. El infante aborda con su adulto.
5. El manifiesto no lleva nombres (la excepción de datos personales es solo el 200 del escaneo); sí
   PNR y `passengerId`.
6. La sesión del kiosko va en `Authorization: Kiosk <token>`, dura 10 minutos, no se revoca y no pide
   variables de entorno nuevas.
7. El apellido tiene que ser el completo de algún pasajero.
8. La pantalla de salidas responde en hora local con desplazamiento, no en UTC.
9. Sin scope nuevo, sin eventos nuevos, sin gRPC para estas operaciones.

## 11. Pendientes

- Gateway: las dos reglas públicas de la sección 8.
- Evento `booking.boarded` (o `passenger.boarded`) cuando el notifier publique su esquema.
- Deshacer un abordaje por error (hoy, un UPDATE manual auditado) y un rol de agente de puerta
  (`flights:boarding`).
- Bloqueo por PNR tras varios apellidos fallidos desde IP distintas (hoy el límite es por IP). Cuesta
  dejar que un tercero bloquee el kiosko de una reserva conocida; hay que decidirlo con el equipo.
- Credencial de dispositivo para los kioskos (que solo un kiosko registrado pueda buscar).
- Spans `interno('embarque.escanear')` y métricas `core_boarding_*`: los nombres se acuerdan primero en
  `OBSERVABILIDAD.md` del gateway.
