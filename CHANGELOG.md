# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones con
[SemVer](https://semver.org/lang/es/). El detalle de cada fase (decisiones, hallazgos y commits)
está en [docs/PLAN.md](docs/PLAN.md).

## [Sin publicar]

### Fase 7c · Observabilidad

El core adopta el estándar de observabilidad que definió el gateway (`docs/OBSERVABILIDAD.md`,
fase 7a). El contrato OpenAPI no cambia. Sin `OTEL_EXPORTER_OTLP_ENDPOINT` las trazas se generan y se
propagan, pero no se exportan.

- Trazas (OpenTelemetry, W3C Trace Context): un span SERVER por petición REST (con la plantilla de
  la ruta, `X-Trace-Id` en la respuesta) y por llamada gRPC (`rpc.*`, hijo del `traceparent` de la
  metadata); INTERNAL con nombre fijo en crear retención, crear reserva, emitir boletos y cancelar;
  CLIENT hacia la Payment API simulada y hacia el notifier; y cada corrida de un proceso periódico
  como su propia traza raíz.
- La bandeja guarda el `traceparent` del hecho (migración `003_traceparent_evento.sql`, columna
  `evento_saliente.traceparent`) y el relevo lo continúa hasta el notifier. La entrega de webhooks a
  terceros nunca manda `traceparent`.
- Métricas en `METRICS_PORT` (aparte de `PORT`): las comunes, `http_client_request_duration_seconds`
  para pagos y notifier, y `core_outbox_pending`, `core_outbox_oldest_pending_seconds`,
  `core_relay_publish_total`, `core_bookings_total` y `core_job_run_duration_seconds`.
- Variables opcionales: `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER_ARG`,
  `TRACE_TRUST_INCOMING` y `METRICS_PORT`.
- Cada línea del log lleva `traceId` y `spanId`; la línea de acceso y la de error escriben la
  plantilla de la ruta y no la URL con sus ids y su query.
- Dependencias: `@opentelemetry/api`, `sdk-trace-node`, `exporter-trace-otlp-http`, `resources` y
  `prom-client`, con las del gateway.
- CI: `scripts/comprobar-migraciones.sh` compara una base migrada con una nueva.
- Pruebas con un recolector OTLP falso y un cliente gRPC, y 11 mutaciones más en `npm run test:mutaciones`.
### Purga de la bandeja de eventos

Con `WEBHOOKS_MODE=notifier`, `evento_saliente` ya no crece sin límite. Detalle en
[docs/MIGRACION-WEBHOOKS.md](docs/MIGRACION-WEBHOOKS.md#purga-de-la-bandeja). En modo `local` no cambia nada.

- Job `PurgaBandeja`: borra los `PUBLICADO` a los 7 días de `publicado_en` y los `FALLIDO` a los 30 de
  haber fallado; un `PENDIENTE` jamás. Sentencias de 1000 filas con `FOR UPDATE SKIP LOCKED` (seguro con
  varias instancias y con el relevo), hasta 20 000 por corrida, y en el log solo conteos.
- Variables opcionales (solo con `notifier`): `EVENT_OUTBOX_PURGE_JOB_ENABLED` (`true`),
  `EVENT_OUTBOX_PURGE_INTERVAL_MINUTES` (60), `EVENT_OUTBOX_RETENTION_DAYS` (7) y
  `EVENT_OUTBOX_FAILED_RETENTION_DAYS` (30).
- Migración `db/migraciones/002_purga_bandeja.sql` (y `db/esquema_vuelos.sql`): índices parciales por
  `publicado_en` (`PUBLICADO`) y por `proximo_intento` (`FALLIDO`). Aplicar con `./db/migrar.sh`.
- `npm run eventos:purgar -- [--dry-run]`: la misma purga a mano, con el conteo previo.
- `npm run eventos:reencolar` solo encuentra un `FALLIDO` mientras la purga no lo haya borrado.
- Pruebas contra PostgreSQL con `Reloj` inyectado y 12 mutaciones más en `npm run test:mutaciones`.

### Fase 5b · Eventos al notifier

El core puede dejar de repartir los webhooks y publicar sus eventos al servicio
[notifier_vuelos](https://github.com/chuchobck/notifier_vuelos) con `WEBHOOKS_MODE=notifier`. El
valor por defecto es `local`, que se comporta igual que antes. El contrato OpenAPI no cambia.
Procedimiento del corte en [docs/MIGRACION-WEBHOOKS.md](docs/MIGRACION-WEBHOOKS.md).

- `WEBHOOKS_MODE` (`local` o `notifier`); con `notifier`, obligatorias `NOTIFIER_URL`,
  `IDENTITY_TOKEN_URL`, `NOTIFIER_CLIENT_ID` y `NOTIFIER_CLIENT_SECRET`, y opcionales
  `EVENT_RELAY_JOB_ENABLED` y `EVENT_RELAY_JOB_INTERVAL_SECONDS`.
- Bandeja `evento_saliente` (en `db/esquema_vuelos.sql` y en `db/migraciones/001_evento_saliente.sql`
  con `db/migrar.sh` para bases que ya existen): un sobre congelado por hecho, en la transacción del
  hecho.
- `RelevoEventos` publica la bandeja con un token `client_credentials` de identity: `FOR UPDATE SKIP
  LOCKED` y arrendamiento, el sobre byte a byte, reintentos de 5 s a 1 h hasta 48 h y
  `npm run eventos:reencolar`.
- Con `notifier`, `/flights/v1/webhooks` responde 404; `EntregaWebhooks` solo drena lo que ya había.
- Copia de los 12 esquemas de eventos del notifier en `contracts/notifier-eventos` con
  `eventos:sync` y `eventos:check` (job informativo en CI).
- `npm run webhooks:exportar`: las suscripciones en el JSON Lines que importa el notifier.
- Pruebas con un notifier y un identity falsos y 11 mutaciones más en `npm run test:mutaciones`.
- Corregido: el aviso de atraso de la bandeja vuelve a salir si el reloj retrocede.

El core puede dejar de emitir sus propios tokens y verificar los del servicio de identidad
([identity_vuelos](https://github.com/chuchobck/identity_vuelos)) con `AUTH_MODE=external`. El
valor por defecto es `local`, que se comporta igual que en 1.1.0. REST, gRPC y el contrato
OpenAPI no cambian. Detalle y procedimiento del cambio en
[docs/DEPLOY.md](docs/DEPLOY.md#6-cambio-de-modo-de-autenticación).

### Fase 4b · Auth externa

- `AUTH_MODE` (`local` o `external`), `JWT_ISSUER` y `JWT_AUDIENCE` obligatorias en external, y
  `JWKS_URL` opcional. En external, `JWT_SECRET` deja de ser obligatoria.
- Verificación de los tokens RS256 del servicio de identidad con su JWKS: algoritmo fijo, clave por
  `kid`, `typ` `at+jwt`, `iss`, `aud`, `exp` (30 s de tolerancia), `iat`, `jti`, `sub` uuid y
  `scope`; los scopes salen del token. Caché del JWKS con su `max-age`, nueva descarga para un `kid`
  desconocido con 10 s de enfriamiento y 3 s de plazo.
- 503 `AUTH_UNAVAILABLE` con `Retry-After` cuando no hay claves con las que verificar (código
  propio, `docs/DISCREPANCIAS-CONTRATO.md` 2.4); un token inválido sigue siendo 401.
- En external, `/flights/v1/auth/*` y `/flights/v1/admin/users` no se montan (404) y Swagger no los
  muestra.
- `BOARDING_PASS_SECRET`: clave opcional de los pases de abordar; sin ella se usa `JWT_SECRET`, como
  antes, y los pases ya emitidos siguen verificando.
- El `client_id` de un token de cliente máquina a máquina va a la línea de acceso
  (`client=<client_id>`); la auditoría sigue guardando el `sub`.
- `npm run auth:exportar-usuarios`: exporta las cuentas a SQL para identity_vuelos, con los mismos
  id y hashes, idempotente, en un archivo 600 fuera del repositorio.
- Pruebas con un servicio de identidad falso y `npm run test:mutaciones` (21 mutaciones).
- `pg` y `@types/pg` pasan a ser dependencias directas; `jose` 6 es nueva.

### Corregido

- El log de una descarga fallida del JWKS nombra el motivo real (el plazo, `ECONNREFUSED`) aunque el
  error de `fetch` venga de otro realm.

## [1.1.0] - 2026-10-15

Servidor gRPC interno para el BFF GraphQL, además de REST. REST y el contrato OpenAPI 1.5.0.0 no
cambian; gRPC está apagado por defecto (`GRPC_ENABLED=false`) y así la API se comporta igual que
en 1.0.0. Detalle en [docs/GRPC.md](docs/GRPC.md).

### Fase R2-1 · gRPC

- Contrato Protobuf `contracts/proto/flights/v1/flights.proto` (paquete `quinde.flights.v1`):
  `FlightsService` con `SearchFlights`, `GetSeatMap` y `GetFlightStatus`, las tres lecturas
  públicas del contrato, con mensajes que reflejan `SearchResponse`, `SeatMapResponse` y
  `FlightStatus` (dinero y fechas como texto, enums con `*_UNSPECIFIED` en 0).
- Servidor gRPC en `0.0.0.0:GRPC_PORT` (50051) solo con `GRPC_ENABLED=true`. Controladores
  delgados (`<entidad>.grpc.ts`) que usan los mismos DTO, pipes, services y mappers que REST.
- Errores como códigos gRPC (400 `INVALID_ARGUMENT`, 404 `NOT_FOUND`, 409 `FAILED_PRECONDITION`,
  429 `RESOURCE_EXHAUSTED`, base caída `UNAVAILABLE`, 5xx `INTERNAL`) con el `code`, el status y
  el `ProblemDetails` de REST en la metadata; nunca el stack ni datos de pasajeros.
- `x-request-id` de la metadata en el mismo contexto y el mismo log que HTTP, y de vuelta en la
  respuesta. Sin token (las tres RPC son públicas; una RPC sin `@Publico()` es `UNAUTHENTICATED`)
  y sin límite de peticiones (el único cliente es el BFF); mensajes de hasta 100 kB.
- 42 pruebas e2e con un cliente real de `@grpc/grpc-js`: paridad con REST, errores, request id y
  el puerto cerrado con `GRPC_ENABLED=false`.
- `buf lint` y `buf breaking` contra main (`npm run proto:lint`, `npm run proto:breaking`), también
  en CI.
- La imagen Docker trae el proto y expone el puerto 50051 (el `HEALTHCHECK` no cambia).

## [1.0.0] - 2026-10-06

Primera versión completa para RDA1: las 22 operaciones del contrato GDS Flight Core API
v1.5.0.0 para vuelos nacionales de Ecuador, con pagos y GDS simulados.

### Fase 11 · Calidad y entrega

- Límite de peticiones con el `Reloj` inyectable (ventana deslizante, estable ante saltos del
  reloj); las pruebas de límite ya no dependen del reloj de la máquina.
- Prueba de contrato: las 22 operaciones con un caso feliz y uno de error contra la API real,
  validadas con Ajv; las diferencias aceptadas van en una lista con su motivo.
- Prueba de Swagger: el OpenAPI generado contra el contrato (operaciones, etiquetas, scopes,
  parámetros, campos y ejemplos) y un recorrido de Swagger UI con Playwright.
- Ejemplos de Swagger que funcionan con la semilla, y la guía para probar desde Swagger.
- Colección de pruebas manuales (`docs/pruebas/vuelos.http`).
- Pruebas de seguridad de toda la API y una suite en `NODE_ENV=production`; `npm audit` revisado.
- 415 para un cuerpo que no es JSON (antes llegaba vacío a la validación y respondía 400).
- Pruebas de carga ligeras (búsqueda, estado de vuelo, holds concurrentes sin sobreventa).
- Cobertura (`npm run test:cov`) y pruebas de las ramas críticas sin cubrir.
- CI en GitHub Actions, `render.yaml`, guía de despliegue en Render y Neon y `scripts/smoke.sh`.
- Cada proceso periódico deja una línea al arrancar (`Activo` o `Apagado`).
- Documento de discrepancias con el contrato. Versión 1.0.0 en `package.json` y en Swagger.

### Fase 10 · Webhooks

- `GET` y `POST /webhooks` y `DELETE /webhooks/{id}`: secreto cifrado (AES-256-GCM con
  `WEBHOOK_SECRET_KEY`) y enmascarado, protección SSRF, máximo de 10 suscripciones activas.
- Bandeja de salida `webhook_entrega`: los eventos de reserva, hold y vuelo se encolan en la
  transacción del hecho; el envío va aparte, firmado con HMAC-SHA256, con reintentos.

### Fase 9 · Check-in y estado de vuelo

- `POST /bookings/{id}/check-in` con ventana de 48 h a 1 h, `GET .../boarding-passes` con código
  de barras firmado y sin datos personales, y `GET /flights/{flightNumber}/status` público.

### Fase 8 · Postventa

- Equipaje adicional, cambio de fecha (búsqueda y confirmación) y cancelación con cotización y
  reembolso; pagos pendientes completados por un proceso periódico.

### Fase 7 · Reservas y boletos

- `POST /bookings` desde un hold, con pago simulado (`PAY-OK-`, `PAY-PEND-`, `PAY-REJ-`),
  asientos, PNR y boletos; consultas de reservas y boletos; idempotencia.

### Fase 6 · Retenciones

- `POST`, `GET` y `DELETE /offers/hold`: cupo descontado con UPDATE condicionado, precio
  congelado, idempotencia y vencimiento.

### Fase 5 · Búsqueda

- `POST /search` (directos y con una escala, solo ida, ida y vuelta y multidestino) y
  `GET /offers/{offerId}/seatmap`.

### Fase 4 · Catálogo

- CRUD de administración de las 10 entidades del catálogo en `/admin`, con baja lógica y
  auditoría.

### Fase 3 · Auth

- Registro, login, refresh con rotación y revocación de la familia, logout y perfil; JWT de 15
  minutos y scopes por rol.

### Fase 2 · Transversales

- Errores `ProblemDetails`, validación y sanitización, helmet, CORS, tope de cuerpo y límite de
  peticiones; request id en cada log.

### Fase 1 · Núcleo

- Prisma 7 sobre la base de `db/*.sql`, tabla única de rutas, `/flights/v1/health`, Swagger en
  `/api/docs` y `Dockerfile`.

### Fase 0 · Base del repo

- Repositorio propio, lint, formato, Conventional Commits, `db/` versionado y docker compose
  con PostgreSQL 18.
