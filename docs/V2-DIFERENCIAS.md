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
cada caso. El filtro de v2 (`ProblemDetailsFilter` en `/api/v2/**`) traduce así:

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
| Infante sin adulto | 422 `VALIDATION_FAILED` | 422 `INFANT_WITHOUT_ADULT` |
| Referencia de pago ya usada | 409 `PAYMENT_REFERENCE_INVALID` | **422** `PAYMENT_REFERENCE_INVALID` |
| Monto distinto del congelado | (no existía) | 422 `AMOUNT_MISMATCH` |
| Reserva no cancelable (estado) | 409 `VALIDATION_FAILED` | 409 `BOOKING_NOT_CANCELLABLE` |
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
