# Discrepancias con el contrato

Diferencias conocidas entre `contracts/vuelos-openapi.yaml` (GDS Flight Core API v1.5.0.0) y lo
que hace la API (v1.0.0), reunidas de las fases 1 a 11. Cada una está probada: la prueba de
contrato (`test/contrato.e2e-spec.ts`) lista las respuestas que el contrato no declara en
`EXCEPCIONES`, con su motivo, y la comparación de Swagger (`test/swagger.e2e-spec.ts`) falla si
aparece una diferencia nueva de rutas, etiquetas, scopes, parámetros o campos.

Lo que la API hace **además** del contrato y no lo contradice (el catálogo de administración en
`/admin`, `/auth`, `/health`) no se lista aquí: está en el README y en Swagger.

## 1. Identidad y seguridad

| # | Qué dice el contrato | Qué hace la API | Propuesta |
| --- | --- | --- | --- |
| 1.1 | `OAuth2Security` con los flujos `authorizationCode` y `clientCredentials` contra `https://auth.booking-hub.com/oauth2/...` | En RDA1 ese proveedor no existe: la API emite sus propios JWT con `POST /auth/login` (JSON) y los acepta como `Bearer`. Los scopes son los del contrato (más `flights:admin`, propio). Swagger copia el esquema OAuth2 para mostrar los scopes, pero se autoriza con `bearer` | Que el contrato declare también un esquema `bearer` (JWT) o un `POST /auth/token` con `grant_type`. En RDA2 se cambia por el proveedor real |
| 1.2 | Ninguna operación declara 401; `ProblemDetails403` existe pero ninguna operación lo usa | Toda operación protegida responde 401 sin token o con uno inválido, y 403 sin el scope, como `ProblemDetails` | Declarar 401 y 403 en todas las operaciones con `OAuth2Security` |
| 1.3 | 429 solo en `POST /search` y `GET /offers/{offerId}/seatmap` | Toda la API tiene un límite por IP (100 por minuto) y varias operaciones uno propio (holds, reservas, postventa, check-in, estado de vuelo, alta de webhooks): 429 con `Retry-After` | Declarar 429 y `Retry-After` en todas |
| 1.4 | No declara 413 ni 415 | Un cuerpo de más de 100 kB es 413; un cuerpo que no es `application/json` es 415 (agregado en la fase 11) | Declararlos o documentarlos como respuestas generales |

## 2. Errores (`ProblemDetails`)

| # | Qué dice el contrato | Qué hace la API | Propuesta |
| --- | --- | --- | --- |
| 2.1 | `code` es una lista cerrada, sin códigos para 401, 403, 404, 405, 413, 415 ni 5xx | Esos errores salen con `VALIDATION_FAILED` (el único "la petición no es válida" de la lista) y el `status` dice qué pasó. Un único lugar lo decide: `codigo-error.ts` | Agregar `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` e `INTERNAL_ERROR` |
| 2.2 | El `type` es una URI | La API usa `https://api.booking-hub.com/errors/<código>` (el dominio del contrato, que no resuelve); un 401 o 403 sale con `.../errors/validation-failed` por 2.1 | Confirmar el dominio de los `type`, o usar `about:blank` para los que no tienen código propio |
| 2.3 | Errores que no declara, por operación (los demás que sí declara se respetan) | Ver la tabla de abajo | Declararlos en el contrato |

| Operación | Respuestas de la API que el contrato no declara |
| --- | --- |
| `POST /offers/hold` | 401, 403, 429; 400 también por una `Idempotency-Key` que no es uuid |
| `GET /offers/hold/{holdId}` | 400 (id que no es uuid), 401, 403, 429 |
| `DELETE /offers/hold/{holdId}` | 400, 401, 403, 429 y **409 si el hold ya se usó en una reserva** (un 204 diría que se liberó un cupo que es de la reserva) |
| `GET /bookings` | 400 (filtro inválido, por ejemplo `limit=0`), 401, 403, 429 |
| `POST /bookings` | 401, 403, 429 |
| `GET /bookings/{bookingId}` y `.../tickets` | 400 (id que no es uuid), 401, 403, 429 |
| `GET .../tickets/{ticketId}` | 401, 403, 429. `ticketId` no tiene formato en el contrato: uno que no existe es 404, nunca 400 |
| `GET .../baggage-options` y `GET .../cancellation-quote` | 400, 401, 403, 404 (reserva ajena o inexistente), 409 (reserva no confirmada; la cotización, también con un pago pendiente), 429 |
| `POST .../baggage`, `POST .../cancel` y `POST .../date-change/search` | 400, 401, 403, 404, 422 (datos del cuerpo que no corresponden a la reserva, pago rechazado), 429 |
| `POST .../date-change` | Además de 409 y 410: 400, 401, 403, 404, 422, 429 |
| `POST .../check-in` | Además de 409 y 422: 400, 401, 403, 404 (reserva ajena), 429. Los `code` son `CHECK_IN_NOT_AVAILABLE` y `CHECK_IN_FAILED` |
| `GET .../boarding-passes` y `GET /flights/{flightNumber}/status` | 400, 401 (los pases), 403, 429 |
| `GET`, `POST /webhooks` y `DELETE /webhooks/{id}` | 400 (cuerpo, URL no permitida, id que no es uuid), 401, 403, 404 (suscripción ajena o inexistente), 409 (más de 10 activas o URL repetida), 429 |

En los POST, un id del **cuerpo** que no existe (cotización, oferta de cambio, hold) es 422 y no
404: el contrato no declara 404 para esas operaciones y el recurso de la URL sí existe.

## 3. Cabeceras

| # | Qué dice el contrato | Qué hace la API | Propuesta |
| --- | --- | --- | --- |
| 3.1 | No nombra ninguna cabecera de respuesta | Una respuesta repetida por `Idempotency-Key` (hold, reserva, maleta, cambio, cancelación) lleva `Idempotent-Replayed: true`. Todas llevan `X-Request-Id` y `X-RateLimit-*`; un 429 lleva `Retry-After` | Declarar `Idempotent-Replayed` en las cinco operaciones idempotentes |
| 3.2 | `X-Device-Fingerprint` es obligatoria en `POST /search`, sin formato | La API exige de 8 a 128 letras, dígitos o `. _ : + / = -` (400 si no) | Fijar el formato en el contrato |

## 4. Esquemas

| # | Qué dice el contrato | Qué hace la API | Propuesta |
| --- | --- | --- | --- |
| 4.1 | `HoldRequest.offerId` e `itinerarySelections[].itineraryId` sin formato | Exige uuid (400): así los genera la búsqueda | `format: uuid` |
| 4.2 | `PassengerBreakdown` sin máximo | A lo sumo 9 pasajeros con asiento y no más infantes que adultos (lo exige la base): 400 | Declarar el máximo |
| 4.3 | Solo `SearchRequest` tiene `additionalProperties: false` (en la raíz) | Todo cuerpo con campos de más es 400, en cualquier nivel | `additionalProperties: false` en todos los cuerpos |
| 4.4 | `BookingDetail.itineraries[].pricingOptions` es `CabinPricing`, con `pricePerPassengerType` y `availableSeats` | El hold congela totales por itinerario, no precios por tipo: la familia vendida va con `pricePerPassengerType: []`; `grandTotal` es el precio congelado y `availableSeats` el cupo de hoy | Un esquema propio para la familia vendida en una reserva, sin precios por tipo ni cupo |
| 4.5 | `PassengerItem` es el mismo esquema para el cuerpo y para `BookingDetail.passengers` | La respuesta devuelve al dueño los datos del pasajero (documento, correo, teléfono) como se guardaron; ningún error ni log los repite | Confirmar que la respuesta debe traerlos, o un esquema de salida sin documento |
| 4.6 | Los 202 de `baggage`, `date-change` y `cancel`, y el 200 de `cancel`, no tienen cuerpo | Devuelven el `BookingDetail` (y `BaggageAddedResponse` en el 202 de equipaje) | Declarar esos cuerpos |
| 4.7 | Varias respuestas no tienen `required` (`SeatMapResponse`, `BaggageOptionsResponse`, `DateChangeSearchResponse`, `BookingListResponse`, `BaggageAddedResponse`) o marcan menos de los que la API siempre manda (`BookingDetail`, `Ticket`, `FlightStatus`, `WebhookSubscription`) | La API siempre manda esos campos y su Swagger los marca obligatorios (más estricto, compatible; la prueba de Swagger lo acepta como regla) | Agregar `required` en el contrato |
| 4.8 | `CheckInStatus` incluye `NOT_ELIGIBLE`, `AVAILABLE` y `FAILED` | `POST .../check-in` devuelve `COMPLETED` o `IN_PROGRESS`; fuera de la ventana es 409 `CHECK_IN_NOT_AVAILABLE`. No hay un GET del check-in que pudiera devolver los otros | Un `GET .../check-in`, o quitar esos estados |
| 4.9 | `BoardingPass.seat` es obligatorio | Un infante (en brazos) hace check-in con `seat: null` y no tiene pase: el de su adulto sirve para los dos | Confirmar la regla de los infantes |
| 4.10 | Las horas son `date-time` | Siempre en UTC (`Z`); la fecha local del aeropuerto solo decide `date` (por ejemplo en el estado de vuelo) | Confirmar UTC o pedir el offset local |
| 4.11 | `servers`: `https://api.booking-hub.com/flights/v1` y el sandbox | La ruta es la misma (`/flights/v1`), el host es el del despliegue (Render) | Nada: es lo esperado de un despliegue propio |

## 5. Webhooks

| # | Qué dice el contrato | Qué hace la API | Propuesta |
| --- | --- | --- | --- |
| 5.1 | `WebhookSubscription.secret` está en `required` y es el mismo esquema para la petición y la respuesta | El secreto se guarda cifrado y la respuesta lo trae **enmascarado** (`****` y los últimos 4): nunca se devuelve en claro | Un esquema de respuesta sin `secret`, o con `secretHint` |
| 5.2 | `WebhookSubscription.id` es `readOnly` | No se acepta en el alta (400) y se devuelve en la respuesta | Nada |
| 5.3 | `WebhookPayload` define el cuerpo y nada más | Cada entrega lleva `Content-Type`, `X-Webhook-Event`, `X-Webhook-Id` (el `eventId`), `X-Webhook-Timestamp` (segundos) y `X-Webhook-Signature: sha256=<HMAC-SHA256 de "timestamp.cuerpo" con el secreto>`; un 2xx es éxito; se reintenta a 1 min, 5 min, 30 min y 2 h (5 intentos); entrega "al menos una vez" | Incorporar cabeceras, firma y reintentos al contrato (como `callbacks` o en la descripción) |
| 5.4 | `WebhookPayload.data` tiene `bookingId`, `pnr`, `status` y `refundAmount` | `hold.expired` no tiene reserva: lleva `holdId` y `status: EXPIRED`. Los de vuelo llevan además `flightNumber` y `segmentId`. El `status` es el de la reserva en el momento del evento (`booking.ticket_issued` llega con `TICKET_ISSUING`) | Definir `data` por tipo de evento |
| 5.5 | `apiVersion` es texto libre; `info.version` es `1.5.0.0` | El payload dice `1.5.0` | Fijar el formato de `apiVersion` |
| 5.6 | Los 12 eventos de `WebhookSubscription.events` | Se emiten los 12. `flight.cancelled` está enganchado, pero el catálogo no deja cancelar una salida con reservas activas, así que hoy no llega a nadie. Los hechos sin evento en el contrato (`booking.created`, `booking.payment_pending`, los `*_pending` y rechazados de postventa) van solo al historial | Decidir si se agregan esos eventos a la lista |

## 6. Base de datos del equipo

No es el contrato HTTP, pero el esquema `db/esquema_vuelos.sql` también es compartido:

| # | Qué pasó | Propuesta |
| --- | --- | --- |
| 6.1 | Se agregó `reserva_detalle_pago.estado` (`estado_pago`, fase 8): una maleta con pago pendiente no tenía dónde quedar | Confirmarlo |
| 6.2 | Se agregó `webhook_entrega` y el tipo `estado_entrega_webhook` (fase 10), la bandeja de salida de los webhooks | Confirmarlo |
| 6.3 | `evento` y `evento_entrega` quedaron sin uso (los reemplaza `webhook_entrega`); no se borraron | Decidir si se quitan del esquema |
| 6.4 | El COMMENT de `clave_idempotencia.respuesta` dice "cuerpo de la respuesta original"; para `POST /bookings` se guarda solo `{ bookingId }` para no duplicar datos personales, y la repetición devuelve la reserva como está hoy | Ajustar el comentario |

## Preguntas para el autor del contrato

1. ¿El contrato puede declarar un esquema `bearer` (o un `POST /auth/token`) para cuando no haya un proveedor OAuth2 externo?
2. ¿Se agregan 401, 403 y 429 a todas las operaciones protegidas, y 413 y 415 como respuestas generales?
3. ¿Qué `code` usan 401, 403, 404, 405, 413, 415 y los 5xx? ¿Y qué dominio llevan los `type`?
4. ¿Qué cuerpo tienen los 202 de equipaje, cambio de fecha y cancelación, y el 200 de cancelación?
5. ¿El `secret` de un webhook se puede quitar de la respuesta? ¿Se formalizan las cabeceras, la firma y los reintentos de las entregas?
6. ¿Qué lleva `WebhookPayload.data` en `hold.expired` y en los eventos de vuelo?
7. ¿Cómo se representa la familia vendida en una reserva sin precios por tipo de pasajero?
8. ¿Hace falta un `GET` del check-in? Si no, ¿se quitan `NOT_ELIGIBLE`, `AVAILABLE` y `FAILED` de `CheckInStatus`?
9. ¿Se agregan los eventos de pago pendiente y rechazo a la lista de webhooks?
