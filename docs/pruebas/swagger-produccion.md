# Revisión de Swagger en producción

Fecha: 2026-10-07 · URL: https://quinde-vuelos-api.onrender.com · API publicada: versión 1.0.0 (`info.version`).
Usuario de prueba creado con `/auth/register` (`revision-<timestamp>@example.com`); sin credenciales de administrador.

## Operaciones probadas (ejemplos de Swagger, contra la URL pública)

Cada cuerpo se validó con Ajv contra el esquema del contrato (los errores, contra `ProblemDetails`).

| Método | Ruta | ¿Ejemplo funciona? | Status | ¿Cumple esquema? |
| --- | --- | --- | --- | --- |
| POST | `/auth/register` (registro) | sí | 201 | sin esquema |
| POST | `/auth/login` (login) | sí | 200 | sin esquema |
| GET | `/auth/me` (me) | sí | 200 | sin esquema |
| GET | `/bookings` (sin token) | sí | 401 | ProblemDetails ok |
| POST | `/search` (search) | sí | 200 | sí |
| GET | `/offers/{offerId}/seatmap` (seatmap) | sí | 200 | sí |
| GET | `/flights/{flightNumber}/status` (status) | sí | 200 | sí |
| GET | `/flights/{flightNumber}/status` (status 404) | sí | 404 | ProblemDetails ok |
| POST | `/offers/hold` (hold) | sí | 201 | sí |
| GET | `/offers/hold/{holdId}` (hold get) | sí | 200 | sí |
| DELETE | `/offers/hold/{holdId}` (hold delete) | sí | 204 | sin cuerpo |
| POST | `/offers/hold` (hold 2) | sí | 201 | sí |
| POST | `/bookings` (booking) | sí | 201 | sí |
| GET | `/bookings` (list) | sí | 200 | sí |
| GET | `/bookings/{bookingId}` (detail) | sí | 200 | sí |
| GET | `/bookings/{bookingId}/tickets` (tickets) | sí | 200 | sí |
| GET | `/bookings/{bookingId}/tickets/{ticketId}` (ticket) | sí | 200 | sí |
| GET | `/bookings/{bookingId}/baggage-options` (bag opts) | sí | 200 | sí |
| POST | `/bookings/{bookingId}/baggage` (bag) | sí | 200 | sí |
| POST | `/bookings/{bookingId}/date-change/search` (chg search) | sí | 200 | sí |
| POST | `/bookings/{bookingId}/date-change` (chg) | sí | 200 | sí |
| POST | `/bookings/{bookingId}/check-in` (checkin) | sí | 409 | ProblemDetails ok |
| GET | `/bookings/{bookingId}/boarding-passes` (passes) | sí | 200 | sí |
| GET | `/bookings/{bookingId}/cancellation-quote` (quote) | sí | 200 | sí |
| POST | `/bookings/{bookingId}/cancel` (cancel) | sí | 200 | sin esquema |
| POST | `/webhooks` (wh post) | sí | 201 | sí |
| GET | `/webhooks` (wh get) | sí | 200 | sí |
| DELETE | `/webhooks/{id}` (wh del) | sí | 204 | sin cuerpo |
| POST | `/webhooks` (wh http) | sí | 400 | ProblemDetails ok |
| GET | `/admin/countries` (admin 403) | sí | 403 | ProblemDetails ok |

- Check-in: 409 con mensaje claro (`opens at ... (48 hours before departure)`), como se espera con un vuelo a 21 días.
- Rutas de administrador: no se probaron (no se usaron credenciales de administrador); con un cliente responden 403 `Missing required scopes: flights:admin`.
- Swagger UI en Chromium (Playwright): 11 de 11 pasos (health, registro, login, Authorize, búsqueda, hold, reserva con `PAY-OK-` e `Idempotency-Key`, consulta, cotización, cancelación).

## Hallazgos

| Clase | Hallazgo | Evidencia | Estado |
| --- | --- | --- | --- |
| Molesta | `/` respondía 404 | `GET /` → 404 `application/problem+json` | Corregido: 302 a `/api/docs` (`0ce5bc1`) |
| Molesta | `servers` vacío en el OpenAPI publicado | `/api/docs-json` → `"servers": []` (Swagger UI funciona igual porque usa el origen de la página) | Corregido: `RENDER_EXTERNAL_URL` (variable que Render define) agrega el servidor (`485ff7a`). Se verá tras desplegar |
| Cosmético | Faltaban descripciones en health, register, me y ticket | Revisión de `docs-json` | Corregido (`50ed964`) |
| Molesta (pruebas) | La prueba de purga de `busqueda` fallaba según el día de la semana (UIO-LOH no vuela el sábado) y fallaba también en `main` | `GET /search` UIO-LOH 2026-10-17 → 0 ofertas | Corregido (`f7a0d46`) |
| Cosmético | Parámetros sin descripción (`bookingId`, `Idempotency-Key`, `status`, `limit`, `id` de webhook) | Revisión de `docs-json` | Anotado, sin cambio |
| Cosmético | Resúmenes del catálogo admin en inglés plural y mezclados ("Listar countries", "Dar de baja departures (cancels it)") | `docs-json` | Anotado, sin cambio (60 operaciones de `/admin`, fuera del contrato) |
| Cosmético | Ejemplos de fecha fija solo en esquemas de respuesta y de administrador (`2026-11-02`, `2026-10-05T...`) | `docs-json` | Anotado: no afectan a los cuerpos de petición del cliente (las fechas de búsqueda y cambio son calculadas) |
| Informativo | La versión publicada dice 1.0.0 (el pedido mencionaba 1.0.1) | `info.version` y `package.json` | Revisar si el despliegue corresponde al último commit |

Sin hallazgos que rompan producción. Sin errores de consola ni recursos bloqueados al cargar `/api/docs` (2,2 s en caliente). Cabeceras de seguridad presentes (HSTS, CSP con `upgrade-insecure-requests`, nosniff, frame SAMEORIGIN, referrer no-referrer) y compatibles con Swagger UI. El OpenAPI (`/api/docs-json`) tiene las 22 operaciones del contrato más Auth, Salud y el catálogo admin; no aparecen tablas, rutas de archivos ni rutas de pruebas (la única mención de `SELECT 1` es la descripción pública del campo `database` de `/health`). Los errores 400, 401, 403, 404, 409, 422, 429 y 503 aparecen documentados en las operaciones que corresponden.

## Lo que no se pudo verificar

- Arranque en frío: el servicio ya estaba despierto (health 0,3 s); no se midió.
- Rutas de administrador.
- `servers` en producción: el cambio requiere desplegar; en local se verificó con `RENDER_EXTERNAL_URL` definida.

## Qué hacer tras fusionar

Nada obligatorio en GitHub. En Render basta con desplegar (`RENDER_EXTERNAL_URL` ya existe en los servicios web); luego comprobar que `GET /` redirige y que `/api/docs-json` trae `servers`.
