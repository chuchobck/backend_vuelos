# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones con
[SemVer](https://semver.org/lang/es/). El detalle de cada fase (decisiones, hallazgos y commits)
está en [docs/PLAN.md](docs/PLAN.md).

## [Sin publicar]

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
