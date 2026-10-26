# Contrato v2 (RDA2) frente a v1: diferencias por operación

Fase V1 del contrato v2 (`contracts/vuelos-openapi-v2.yaml`, 2.0.0). Booking Prototipo integra el
core **solo** por `/api/v2/vuelos/*`. `/flights/v1` (contrato 1.5, `contracts/vuelos-openapi.yaml`)
sigue igual. Este documento compara, operación por operación, lo que cambia entre las dos.

## Lo que cambia en todas las operaciones

| Tema | v1 (`/flights/v1`) | v2 (`/api/v2/vuelos`) |
| --- | --- | --- |
| Base | `/flights/v1/<ruta>` | `/api/v2/vuelos/<ruta>` |
| Token | Persona (HS256 del core o RS256 de identity) | Además, **token de partner**: `client_credentials` de identity con claim `client_id` (Booking) |
| Usuario final | El `sub` del token | Con token de partner, `X-User-Id` (y `X-User-Roles`); sin él, se ignoran |
| `X-Correlation-Id` | No existe | Se recibe (máx. 100, `[A-Za-z0-9._:-]`) o se genera `corr-<uuid>`, se devuelve siempre y se propaga. **También en v1** desde esta fase |
| `ProblemDetails` | `type`, `title`, `status`, `detail`, `code`, `invalidParams` | Suma `instance`, `correlation_id`, `timestamp`; `code` de un enum más grande (tabla abajo) |
| Reintento con la misma `Idempotency-Key` | Respuesta original con su status (201/202) e `Idempotent-Replayed: true` | **200** con el cuerpo original e `Idempotent-Replayed: true` |
| La misma clave con otro cuerpo | 422 `VALIDATION_FAILED` | **409 `IDEMPOTENCY_KEY_REUSED`** |
| HATEOAS | No | `_links` en hold, reserva, lista de reservas, emisión, check-in y cancelación |
| Pagos | `paymentReference` juzgada por la Payment API (simulada) | La cobra **Booking** (`provider = BOOKING_PROTOTIPO`, por defecto): la aerolínea no cobra, solo valida la referencia y el monto |

## Operaciones

Las que esta fase implementa (las de v1 y `health`). La columna **Seguridad** es el scope de
`PartnerOAuth2`; "pública" no pide token.

| operationId | v1 → v2 | Request | Response | Cabeceras | Errores | Seguridad |
| --- | --- | --- | --- | --- | --- | --- |
| `getHealth` | (no existía; v1 tiene `/flights/v1/health`, distinto) → `GET /vuelos/health` | — | `VuelosHealthResponse` (snake_case): `status`, `nodo_id`, `nombre_proveedor`, `vertical`, `version`, `uptime_seconds`, `latencia_ms`, `circuit_breaker_estado`, `holds_activos_count`, `vuelos_programados_hoy`, `dependencias`, `timestamp`. 503 con el mismo cuerpo si `DOWN` | `X-Correlation-Id` | Nunca ProblemDetails | pública |
| `searchFlights` | `POST /search` → `POST /vuelos/search` | Igual (`SearchRequest` sin campos de más) | Igual | `X-Device-Fingerprint` (obligatoria), `X-Correlation-Id`, `X-Request-Id` | Suma 422 y 503 | pública |
| `getSeatMap` | `GET /offers/{offerId}/seatmap` → `GET /vuelos/offers/{offerId}/seatmap` | Igual (`segmentId`) | Suma `status` por asiento (`SeatStatus`: `AVAILABLE`, `HELD`, `BOOKED`, `TICKETED`, `CHECKED_IN`, `BOARDED`); `isAvailable` sigue | `X-Correlation-Id` | Suma 410 (`OFFER_NO_LONGER_AVAILABLE`) | pública |
| `getFlightStatus` | `GET /flights/{n}/status` → `GET /vuelos/flights/{n}/status` | Igual (`date`) | Igual; `departure`/`arrival` admiten `gate` (opcional) | `X-Correlation-Id` | Igual | pública |
| `createHold` | `POST /offers/hold` → `POST /vuelos/offers/hold` | Suma `ttlMinutes` (5–30, 15 por defecto) | Igual más `_links` | `Idempotency-Key` (obligatoria), `X-User-Id`, `Location` | 409, 410, 422, 503; reintento 200 | `flights:hold` |
| `getHold` | `GET /offers/hold/{id}` → `GET /vuelos/offers/hold/{id}` | — | Suma `holdId` y `_links` | `X-User-Id` | 401, 404 | `flights:read` |
| `releaseHold` | `DELETE /offers/hold/{id}` → `DELETE /vuelos/offers/hold/{id}` | — | 204 (idempotente) | `X-User-Id` | 409 `HOLD_ALREADY_CONSUMED` (v1: 409 sin código) | `flights:hold` |
| `listBookings` | `GET /bookings` → `GET /vuelos/bookings` | Igual (`pnr`, `status`, fechas, `limit`, `cursor`) | Suma `_links` por ítem; `nextCursor` nullable | `X-User-Id` filtra (solo partner) | 401 | `flights:read` |
| `createBooking` | `POST /bookings` → `POST /vuelos/bookings` | `payment` con `amount` y `provider`; suma `salesChannel` | Suma `holdId`, `paymentReference`, `salesChannel`, `_links` | `Idempotency-Key`, `X-User-Id`, `Location` | 409, 410 `HOLD_EXPIRED`, 422 `PAYMENT_REFERENCE_INVALID` / `AMOUNT_MISMATCH` / `PASSENGER_COUNT_MISMATCH`...; reintento 200 | `flights:book` |
| `getBooking` | `GET /bookings/{id}` → `GET /vuelos/bookings/{id}` | — | Como `createBooking` | `X-User-Id` | 401, 404 | `flights:read` |
| `issueTickets` | (no existía: v1 emite dentro de la reserva) → `POST /vuelos/bookings/{id}/tickets` | — | `TicketIssuanceResponse` (`issued` = boletos emitidos en esta llamada) | `Idempotency-Key` opcional | 404, 409, 422 | `flights:book` |
| `listTickets` | `GET /bookings/{id}/tickets` → igual con `/vuelos` | — | Igual | `X-User-Id` | 401, 404 | `flights:read` |
| `getTicket` | `GET /bookings/{id}/tickets/{ticketId}` → igual con `/vuelos` | — | Igual | `X-User-Id` | 401, 404 | `flights:read` |
| `checkIn` | `POST /bookings/{id}/check-in` → igual con `/vuelos` | — | Suma `_links` | `Idempotency-Key` opcional | 404, 409, 422 | `flights:book` |
| `listBoardingPasses` | `GET /bookings/{id}/boarding-passes` → igual con `/vuelos` | — | `gate` opcional | — | Suma 409 | `flights:read` |
| `getBaggageOptions` | `GET /bookings/{id}/baggage-options` → igual con `/vuelos` | — | Igual | — | Suma 401, 404 | `flights:read` |
| `addBaggage` | `POST /bookings/{id}/baggage` → igual con `/vuelos` | `payment` con `amount` y `provider` | Igual | `Idempotency-Key` | Suma 400, 404, 422 | `flights:book` |
| `searchDateChange` | `POST /bookings/{id}/date-change/search` → igual con `/vuelos` | Igual | Igual | — | Suma 400, 404 | `flights:read` |
| `confirmDateChange` | `POST /bookings/{id}/date-change` → igual con `/vuelos` | `payment` con `amount` y `provider` | Igual | `Idempotency-Key` | Suma 400, 404, 422 | `flights:book` |
| `getCancellationQuote` | `GET /bookings/{id}/cancellation-quote` → igual con `/vuelos` | — | Igual | — | Suma 404, 409 | `flights:read` |
| `cancelBooking` | `POST /bookings/{id}/cancel` → igual con `/vuelos` | `quoteId` deja de ser obligatorio con `reasonCode` `SAGA_COMPENSATION` o `FLIGHT_CANCELLED`; suma `reasonCode` y `reason` | `CancelBookingResponse` **nuevo**: `refund` (calculado, `status = CALCULATED`), `ticketsVoided`, `inventoryRestoration`, `reasonCode`, `_links` | `Idempotency-Key` | Suma 400, 404, 410 | `flights:cancel` |

**Fuera de esta fase** (fase V2 o de otro servicio): `PATCH /vuelos/flights/{n}/status`,
`GET /vuelos/operaciones/vuelos`, `PUT /vuelos/bookings/{id}/seats`, `GET/PUT /vuelos/promociones/contrato`,
`GET /vuelos/eventos` y `/vuelos/webhooks*` (los sirve el notifier). RabbitMQ y el stock por gRPC tampoco.

## Códigos de error: v1 → v2

v1 usa `VALIDATION_FAILED` cuando su enum no tiene un código (404, 401, 403, 5xx...). v2 tiene uno para
cada caso. El filtro global (`ProblemDetailsFilter`) traduce en `/api/v2/**` así: el error de negocio que
cambia en v2 lleva su pista (`ErrorNegocio` con la opción `v2: { code, status? }`); el resto toma el
código genérico de su status o el mismo de v1 (`codigoV2PorDefecto` en
`src/common/errores/codigo-error-v2.ts`). `instance` es la ruta pedida sin la query, `correlation_id` el
X-Correlation-Id de la petición y `timestamp` la hora del error.

| Caso | v1 (status, `code`) | v2 (status, `code`) |
| --- | --- | --- |
| Petición inválida, campo de más, cuerpo roto | 400 `VALIDATION_FAILED` | 400 `VALIDATION_FAILED` |
| Sin token, token inválido o vencido | 401 `VALIDATION_FAILED` | 401 `UNAUTHORIZED` |
| Scope insuficiente | 403 `VALIDATION_FAILED` | 403 `FORBIDDEN` |
| No existe (o es de otro dueño) | 404 `VALIDATION_FAILED` | 404 `NOT_FOUND` |
| Método no permitido / tipo de cuerpo / cuerpo grande | 405, 415, 413 `VALIDATION_FAILED` | igual status, `VALIDATION_FAILED` |
| `Idempotency-Key` con otro cuerpo | 422 `VALIDATION_FAILED` | **409** `IDEMPOTENCY_KEY_REUSED` |
| Hold vencido o liberado | 410 `VALIDATION_FAILED` | 410 `HOLD_EXPIRED` |
| Hold ya convertido en reserva | 409 `VALIDATION_FAILED` | 409 `HOLD_ALREADY_CONSUMED` |
| Pasajeros que no son los del hold | 422 `VALIDATION_FAILED` | 422 `PASSENGER_COUNT_MISMATCH` |
| Infante sin adulto (o con uno que no es ADULT de la reserva) | 400 `VALIDATION_FAILED` | 400 `INFANT_WITHOUT_ADULT` |
| Documento que vence antes de terminar el viaje | 422 `VALIDATION_FAILED` | 422 `DOCUMENT_EXPIRED` |
| Reserva que no está CONFIRMED (maletas, cambio, check-in) | 409 `VALIDATION_FAILED` | 409 `BOOKING_NOT_CONFIRMED` |
| Referencia de pago ya usada | 409 `PAYMENT_REFERENCE_INVALID` | **422** `PAYMENT_REFERENCE_INVALID` |
| Monto distinto del congelado | (no existía) | 422 `AMOUNT_MISMATCH` |
| Reserva no cancelable (estado, al cotizar o cancelar) | 409 `VALIDATION_FAILED` | 409 `BOOKING_NOT_CANCELLABLE` |
| Emitir boletos de una reserva fallida, cancelada o con un cambio pendiente | (no existía) | 409 `BOOKING_NOT_CONFIRMED` |
| Límite de peticiones | 429 `RATE_LIMIT_EXCEEDED` | 429 `RATE_LIMIT_EXCEEDED` |
| Error interno | 500 `VALIDATION_FAILED` | 500 `INTERNAL_ERROR` |
| Base caída, identity sin claves (`AUTH_UNAVAILABLE`) | 503 `VALIDATION_FAILED` / `AUTH_UNAVAILABLE` | 503 `PROVIDER_UNAVAILABLE` |
| Los demás (`SEAT_TAKEN`, `QUOTE_EXPIRED`, `ALREADY_CANCELLED`, `CHECK_IN_NOT_AVAILABLE`...) | el mismo | el mismo |

## Mapeo `x-microservice` → módulos del core

| x-microservice | Operaciones v2 | Controlador v2 | Servicios del core que reutiliza |
| --- | --- | --- | --- |
| MS.Vuelos | `getHealth`, `searchFlights`, `getSeatMap`, `getFlightStatus` | `src/modules/vuelos/v2/vuelos.v2.controller.ts` | `busqueda`, `oferta`, `estado-vuelo`, `salud` |
| MS.Reservas | `createHold`, `getHold`, `releaseHold`, `listBookings`, `createBooking`, `getBooking`, `issueTickets`, `listTickets`, `getTicket`, `checkIn`, `listBoardingPasses` | `src/modules/vuelos/v2/reservas.v2.controller.ts` | `retencion`, `reserva`, `boleto`, `checkin`, `pase-abordar` |
| MS.Postventa | `getBaggageOptions`, `addBaggage`, `searchDateChange`, `confirmDateChange`, `getCancellationQuote`, `cancelBooking` | `src/modules/vuelos/v2/postventa.v2.controller.ts` | `equipaje`, `cambio-fecha`, `cancelacion` |
| MS.Clientes | `webhooks*` | — (los sirve el notifier) | — |

## Decisiones de la fase V1 (tomadas sin consultar)

**Rutas.** La fachada es `FachadaV2Module` (`src/modules/vuelos/v2/`), montada con la tabla de rutas en
`api/v2/vuelos`, fuera del prefijo global `flights` (`setGlobalPrefix({ exclude })`) y con controllers
`VERSION_NEUTRAL`. Usa los mismos services, repositorios, límites de peticiones y transacciones que v1.

**Partner.** Un token con claim `client_id` (identity, `client_credentials`; solo con `AUTH_MODE=external`)
es un partner. El dueño (`id_propietario`) de sus holds y reservas es su `sub`. Solo con ese token se leen
`X-User-Id` (formato `[A-Za-z0-9._:@|-]{1,100}`; otro formato es 400 nombrando la cabecera) y
`X-User-Roles`. La reserva guarda `id_cliente`, `id_usuario_externo` y el `salesChannel`. Con
`X-User-Id`, el partner solo ve y opera las reservas de ese usuario (otra es 404, como una que no existe) y
el listado se filtra; sin `X-User-Id` ve todas las suyas. Los holds no guardan el usuario final: los ve y
libera el partner. Una persona (token sin `client_id`) funciona como en v1 y las cabeceras `X-User-*` se
ignoran. `X-User-Roles` se acepta pero hoy no decide nada (no hay operaciones OPS en esta fase).

**Pagos.** `payment.provider` es `BOOKING_PROTOTIPO` por defecto:

- Con `BOOKING_PROTOTIPO` la Payment API **no se llama**. La referencia tiene que tener el formato de v1
  (8 a 64 de `[A-Za-z0-9_.:-]`) y no haber acreditado otra operación (es única en `reserva_detalle_pago`):
  si no, 422 `PAYMENT_REFERENCE_INVALID`. El pago queda `APROBADO` con `proveedor = BOOKING_PROTOTIPO`.
- Si llega `payment.amount`, la moneda y el total tienen que ser exactamente los del cobro (el precio
  congelado del hold, el de las maletas o el `totalToPay` del cambio); si no, 422 `AMOUNT_MISMATCH`,
  antes de mirar la referencia. `baseFare` y `taxes` no se comparan.
- Con `AIRLINE_DIRECT` decide la Payment API de la aerolínea, como en v1 (201, 202 pendiente o 422).
- Las mismas reglas valen para maletas y cambio de fecha.

**Emisión.** `createBooking` con `BOOKING_PROTOTIPO` emite en el acto: 201 `CONFIRMED` con los boletos
(el pago ya lo confirmó Booking). Con `AIRLINE_DIRECT` y un pago pendiente, 202 `PENDING_PAYMENT`.
`issueTickets` es idempotente: `CONFIRMED` → 200 con `issued: 0`; `PENDING_PAYMENT` → pregunta a la Payment
API en ese momento y, si aprobó, emite (200 `CONFIRMED`, `issued` = los emitidos) o sigue 200
`TICKET_ISSUING` con `issued: 0`; `TICKET_ISSUING` → 200 `TICKET_ISSUING`; otro estado → 409
`BOOKING_NOT_CONFIRMED`. `Idempotency-Key` es opcional y no se usa (lo dice el contrato). Los estados son
los de v1 (§10 del contrato coincide con `BookingStatus`).

**Cancelación.** El reembolso siempre se calcula con la política de v1. Si la reserva la cobró Booking
(pago de emisión `BOOKING_PROTOTIPO`) **no se ejecuta**: la reserva queda `CANCELLED` en el acto,
`refund.status = CALCULATED`, los boletos quedan `VOIDED` (no `REFUNDED`) y Booking reembolsa. Si la cobró
la aerolínea, se reembolsa con la Payment API como en v1 (`SETTLED`, o 202 `CANCELLATION_PENDING`). Sin
nada que devolver, `NOT_REFUNDABLE`. `reasonCode` se guarda (`cotizacion_cancelacion.codigo_motivo`).
`SAGA_COMPENSATION` y `FLIGHT_CANCELLED` no piden `quoteId`: el servidor cotiza **sin penalidad** (se
devuelve todo lo pagado) y acepta en el acto. El contrato deja la penalidad de una compensación al acuerdo
B2B, que esta fase no implementa; se eligió la opción que no castiga al cliente por un fallo de otro
servicio. Con `quoteId`, vale la cotización tal como se dio. Una compensación sobre una reserva ya
cancelada responde 200 con la cancelación existente (Booking la puede repetir con otra clave); una
cancelación `CUSTOMER_REQUEST` repetida sigue siendo 409 `ALREADY_CANCELLED`. `refundId` es el `quoteId`
y `ticketsVoided` son los `ticketId`.

**Idempotencia.** La misma tabla y las mismas 24 h de v1. En v2 un reintento de `createHold` o
`createBooking` responde **200** (no 201) con el cuerpo original e `Idempotent-Replayed: true`; los demás
repiten su status original (como dice el contrato). Otro cuerpo con la misma clave es 409
`IDEMPOTENCY_KEY_REUSED`. La huella de v2 incluye lo que v2 agrega (ttlMinutes, proveedor, monto, partner,
usuario final, canal, reasonCode); la de v1 no cambia.

**Hold.** `ttlMinutes` de 5 a 30; sin él, `HOLD_TTL_MINUTES` (15 por defecto, el mismo default del
contrato).

**Mapa de asientos.** `status` por asiento: `AVAILABLE`, `BOOKED`, `TICKETED` (boleto emitido) o
`CHECKED_IN`. Nunca `HELD` (un hold toma cupo de cabina, no un asiento) ni `BOARDED` (no se registra el
abordaje). Un asiento de una cabina que no se vende en esa salida va sin `status`.

**Salud.** `nodo_id` y `nombre_proveedor` de `NODO_ID` y `NOMBRE_PROVEEDOR` (por defecto
`NODE_VUE_QUINDE` y `Quinde`); `version` es la del contrato (2.0.0). Dependencias: postgres siempre;
identity (su JWKS) con `AUTH_MODE=external`; el notifier (`NOTIFIER_URL/health`) con
`WEBHOOKS_MODE=notifier`. Cada una con 400 ms de plazo, a la vez, y el resultado se reusa 5 s (con el
`Reloj`). Postgres caído → 503 `DOWN` con el mismo cuerpo; identity o notifier caídos → 200 `DEGRADED`.
`circuit_breaker_estado`: el core no tiene un cortacircuitos propio; es `OPEN` mientras la base no
responde y `CLOSED` si responde. `vuelos_programados_hoy` cuenta las salidas no canceladas de hoy en
Ecuador continental.

**X-Correlation-Id.** También en v1 (cabecera de respuesta; el ProblemDetails de v1 no cambia). Va en cada
línea de log de texto (`[corr=...]` al final de la primera línea) y en una línea de acceso JSON por
petición (`correlation_id`, `request_id`, `service`, `operation`, `method`, `status`, `latency_ms`,
`timestamp`, `client_id`, y el `trace_id`/`span_id` del span SERVER de la fase 7c). Se propaga a la
Payment API (`CobroEsperado.correlationId`), al notifier (cabecera, guardada en
`evento_saliente.correlation_id` junto al `traceparent`) y se lee de la metadata gRPC `x-correlation-id`. El sobre del notifier
lleva `correlationId` solo con `EVENT_ENVELOPE_CORRELATION_ID=true` (por defecto no: los esquemas 1.0 del
notifier tienen `additionalProperties: false`).

**Swagger.** Dos documentos: el de v1 en `/api/docs` (sin cambios) y el de v2 en `/api/v2/docs`. La prueba
de v1 que exige que toda ruta de la app esté en `/api/docs` ahora salta las de `/api/v2` (las comprueba
`test/fachada-v2.e2e-spec.ts` contra `/api/v2/docs`): es el único cambio a la suite de v1, porque esa
prueba recorre todas las rutas de la app.

**Límites de peticiones.** Los mismos de v1 y por IP. Booking llega desde pocas IP: si su volumen lo
pide, el límite debería contar por `client_id` (no está en esta fase).

## Cobertura de las pruebas de proveedor

`test/contrato-v2.e2e-spec.ts` valida cada respuesta contra el esquema que el contrato v2 declara para ese
status (Ajv). `getHealth` 503 y los casos de dependencias caídas están en `test/salud-v2.e2e-spec.ts`.

| operationId | Ruta | Status probados |
| --- | --- | --- |
| getHealth | GET /vuelos/health | 200, 503 |
| searchFlights | POST /vuelos/search | 200, 400 |
| getSeatMap | GET /vuelos/offers/{offerId}/seatmap | 200, 404 |
| getFlightStatus | GET /vuelos/flights/{flightNumber}/status | 200, 404 |
| createHold | POST /vuelos/offers/hold | 200, 201, 400, 401, 409 |
| getHold | GET /vuelos/offers/hold/{holdId} | 200, 404 |
| releaseHold | DELETE /vuelos/offers/hold/{holdId} | 204, 404, 409 |
| listBookings | GET /vuelos/bookings | 200, 401 |
| createBooking | POST /vuelos/bookings | 200, 201, 202, 409, 410, 422 |
| getBooking | GET /vuelos/bookings/{bookingId} | 200, 404 |
| issueTickets | POST /vuelos/bookings/{bookingId}/tickets | 200, 404, 409 |
| listTickets | GET /vuelos/bookings/{bookingId}/tickets | 200, 404 |
| getTicket | GET /vuelos/bookings/{bookingId}/tickets/{ticketId} | 200, 404 |
| checkIn | POST /vuelos/bookings/{bookingId}/check-in | 200, 404, 409 |
| listBoardingPasses | GET /vuelos/bookings/{bookingId}/boarding-passes | 200, 404 |
| getBaggageOptions | GET /vuelos/bookings/{bookingId}/baggage-options | 200, 404 |
| addBaggage | POST /vuelos/bookings/{bookingId}/baggage | 200, 404, 422 |
| searchDateChange | POST /vuelos/bookings/{bookingId}/date-change/search | 200, 404 |
| confirmDateChange | POST /vuelos/bookings/{bookingId}/date-change | 200, 404 |
| getCancellationQuote | GET /vuelos/bookings/{bookingId}/cancellation-quote | 200, 404, 409 |
| cancelBooking | POST /vuelos/bookings/{bookingId}/cancel | 200, 400, 404 |

## Lo que necesitan los otros servicios

**Gateway (chuchobck/gateway_vuelos).** Enrutar `/api/v2/vuelos/*` al core tal cual (sin reescribir la
ruta) y `/api/v2/docs` si se quiere publicar el Swagger de v2. Públicas (sin token): `GET /health`,
`POST /search`, `GET /offers/{offerId}/seatmap`, `GET /flights/{flightNumber}/status`. Con token y scope:
`flights:hold` (POST y DELETE de `/offers/hold`), `flights:read` (`GET /offers/hold/{id}`,
`GET /bookings`, `GET /bookings/{id}`, `GET .../tickets`, `GET .../tickets/{ticketId}`,
`GET .../boarding-passes`, `GET .../baggage-options`, `POST .../date-change/search`,
`GET .../cancellation-quote`), `flights:book` (`POST /bookings`, `POST .../tickets`, `POST .../check-in`,
`POST .../baggage`, `POST .../date-change`), `flights:cancel` (`POST .../cancel`). Dejar pasar sin tocar
`Authorization`, `X-Correlation-Id`, `X-Request-Id`, `X-User-Id`, `X-User-Roles`, `Idempotency-Key` y
`X-Device-Fingerprint`, y exponer en la respuesta `X-Correlation-Id`, `Idempotent-Replayed` y `Location`.
`X-User-Id` solo cuenta con un token de partner: el gateway no tiene que filtrarla, pero sí puede quitarla
de las peticiones de personas. Identity tiene que tener el cliente `booking-prototipo` con los scopes
`flights:read flights:hold flights:book flights:cancel` (`client_credentials`).

**Notifier (chuchobck/notifier_vuelos).** Hoy no necesita nada para seguir funcionando: el core le manda
la cabecera `X-Correlation-Id` en `POST /internal/v1/events` (un campo extra que puede guardar y
reenviar), y el sobre sigue siendo el 1.0. Para que el sobre lleve el id (y el CloudEvent hacia Booking su
extensión `correlationid`), el notifier tiene que aceptar en sus esquemas 1.x un campo opcional
`correlationId` (string, `^[A-Za-z0-9._:-]{1,100}$`) y publicarlo; después se enciende
`EVENT_ENVELOPE_CORRELATION_ID=true` en el core y se corre `npm run eventos:sync`.
