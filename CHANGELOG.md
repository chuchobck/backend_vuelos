# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones con
[SemVer](https://semver.org/lang/es/). El detalle de cada fase (decisiones, hallazgos y commits)
está en [docs/PLAN.md](docs/PLAN.md).

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
