# Despliegue en Render con Neon

Guía paso a paso para publicar la API: la base en [Neon](https://neon.tech) (PostgreSQL
administrado) y la API en [Render](https://render.com) desde `render.yaml`. Lo que se verificó en
local está al final; el despliegue real en Render y Neon no se probó desde este repositorio (no
tiene credenciales de esas cuentas).

## 1. Lo que hace falta

- Cuentas en Neon y en Render, y acceso de Render al repositorio de GitHub.
- En tu máquina: el repositorio clonado con `npm ci` hecho (para calcular el hash del
  administrador), Node 22 y `psql` (o Docker: `docker run --rm -i postgres:18 psql ...`).

## 2. Base de datos en Neon

1. **Crear el proyecto.** En Neon: *New project*, región **AWS US East** (la más cercana a
   Ecuador entre las de Render y Neon) y la versión de PostgreSQL más alta que ofrezca. La API se
   probó con PostgreSQL 18; con 17 no se probó.
2. **Copiar la cadena de conexión** de la base (`neondb` u otra), **sin pooler** (*Connection
   pooling* apagado): la API abre pocas conexiones y usa transacciones interactivas, y la carga de
   los esquemas también necesita una conexión directa. Tiene esta forma:

   ```text
   postgresql://<usuario>:<clave>@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

3. **Cargar esquemas y semillas**, en este orden (el mismo de `./db/reset.sh`). La cadena para
   `psql` va **sin** `&schema=vuelos` (psql no conoce ese parámetro):

   ```bash
   export NEON_URL='postgresql://<usuario>:<clave>@<host>/neondb?sslmode=require'
   for archivo in esquema_vuelos esquema_seguridad semilla_vuelos; do
     psql "$NEON_URL" -v ON_ERROR_STOP=1 -q -f "db/${archivo}.sql"
   done
   ```

4. **Roles y administrador** (`db/semilla_seguridad.sql`). Sin variables crea solo los roles;
   para tener un administrador con todos los scopes, se le pasa el correo y el hash argon2id de su
   contraseña por la entrada estándar (así la contraseña no queda en la lista de procesos):

   ```bash
   read -rs SEED_ADMIN_PASSWORD && export SEED_ADMIN_PASSWORD   # de 12 a 128 caracteres
   HASH="$(node db/hash-contrasena.js)"
   { printf "\\\\set correo_admin 'admin@quinde.example'\n\\\\set hash_admin '%s'\n" "$HASH"
     cat db/semilla_seguridad.sql; } | psql "$NEON_URL" -v ON_ERROR_STOP=1 -q
   unset SEED_ADMIN_PASSWORD HASH
   ```

   Sin administrador: `psql "$NEON_URL" -v ON_ERROR_STOP=1 -q -f db/semilla_seguridad.sql`.

5. **Comprobar:** `psql "$NEON_URL" -c "SELECT count(*) FROM vuelos.vuelo_programado"` da unas
   4 000 salidas.

La semilla cubre **90 días desde el día en que se carga**. Para volver a sembrar (antes de una
entrega, por ejemplo) hay que borrar el esquema, lo que borra también usuarios, reservas y
auditoría: `psql "$NEON_URL" -c "DROP SCHEMA vuelos CASCADE"` y repetir los pasos 3 y 4.

**Una base que ya existe** se pone al día con `./db/migrar.sh` (usa `DATABASE_URL`; con
`DATABASE_URL="$NEON_URL&schema=vuelos" ./db/migrar.sh` contra Neon): aplica `db/migraciones/*.sql`
en orden, solo agrega y es idempotente. La 001 crea la bandeja `evento_saliente` de la fase 5b, la 002 los índices de su purga y la 003 le agrega la columna `traceparent` (fase 7c).

## 3. Servicio en Render

1. En Render: *New* → *Blueprint* → el repositorio. Render lee `render.yaml` y propone el
   servicio `quinde-vuelos-api` (runtime Node, plan free).
2. Completa las variables marcadas `sync: false` (Render las pide al crear el Blueprint):

   | Variable | Valor |
   | --- | --- |
   | `DATABASE_URL` | La cadena de Neon **con** `&schema=vuelos` al final: `postgresql://<usuario>:<clave>@<host>/neondb?sslmode=require&schema=vuelos` |
   | `JWT_SECRET` | 32 caracteres o más, nueva para este entorno: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
   | `WEBHOOK_SECRET_KEY` | Otra distinta, generada igual. Si se cambia después, los secretos de los webhooks ya registrados quedan ilegibles y hay que registrarlos de nuevo |
   | `CORS_ORIGINS` | Los orígenes del frontend separados por coma (`https://app.example.com`), sin ruta ni `*`; vacía si ningún navegador de otro origen llama a la API |

3. *Apply*. Render compila con
   `npm ci --include=dev && npx prisma generate && npm run build` y arranca con `node dist/main`.
   El `--include=dev` hace falta porque `NODE_ENV=production` también rige en el build y `npm ci`
   omitiría `@nestjs/cli` y `typescript` (comprobado: sin él, `nest build` no existe).
4. Render pone `PORT` solo y revisa `/flights/v1/health` (200 si la base responde, 503 si no).

`render.yaml` ya fija `NODE_ENV=production`, `TRUST_PROXY=1` (Render tiene un proxy delante: sin
esto el límite por IP y la auditoría verían la IP del proxy) y `NODE_VERSION=22`.

Alternativa: el `Dockerfile` del repositorio (multi-etapa, imagen sin dependencias de desarrollo)
sirve para un servicio *Docker* de Render con las mismas variables.

### Variables opcionales

Todas tienen un valor por defecto razonable y están documentadas en `.env.example`. La API no
arranca si alguna tiene un formato inválido y dice cuál.

| Variable | Por defecto | Para qué |
| --- | --- | --- |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS` | 100 y 60 | Peticiones por IP y ventana en toda la API |
| `AUTH_MODE` | `local` | `local`: la API emite y verifica sus tokens (HS256, `/auth`). `external`: verifica los del servicio de identidad con su JWKS y no monta `/auth` ni `/admin/users` (ver "Cambio de modo de autenticación") |
| `JWT_ISSUER`, `JWT_AUDIENCE` | `quinde-vuelos-api` | `iss` y `aud` de los tokens. Con `AUTH_MODE=external` son obligatorias: el origen https del servicio de identidad, sin ruta (`iss` exacto de sus tokens), y `quinde-vuelos-api` |
| `JWKS_URL` | `{JWT_ISSUER}/.well-known/jwks.json` | Solo con `AUTH_MODE=external`: de dónde se bajan las claves públicas (https en producción) |
| `WEBHOOKS_MODE` | `local` | `local`: el core reparte y entrega los webhooks. `notifier`: publica cada evento al servicio notifier y no monta `/webhooks` (ver [MIGRACION-WEBHOOKS.md](MIGRACION-WEBHOOKS.md)) |
| `NOTIFIER_URL` | — | Obligatoria con `WEBHOOKS_MODE=notifier`: base del notifier (`https://notifier.quinde.example`; https en producción) |
| `IDENTITY_TOKEN_URL` | — | Obligatoria con `WEBHOOKS_MODE=notifier`: el `/oauth2/token` de identity (`https://identity.quinde.example/oauth2/token`) |
| `NOTIFIER_CLIENT_ID` / `NOTIFIER_CLIENT_SECRET` | — | Obligatorias con `WEBHOOKS_MODE=notifier`: el cliente `core-vuelos` de identity con `events:publish`. El secreto nunca se registra |
| `EVENT_RELAY_JOB_ENABLED` | `true` | Solo con `WEBHOOKS_MODE=notifier`: el relevo que publica la bandeja `evento_saliente` |
| `EVENT_RELAY_JOB_INTERVAL_SECONDS` | `5` | Cada cuántos segundos corre el relevo (1 a 3600) |
| `EVENT_OUTBOX_PURGE_JOB_ENABLED` | `true` | Solo con `WEBHOOKS_MODE=notifier`: la purga que borra de `evento_saliente` lo ya publicado o fallido hace tiempo |
| `EVENT_OUTBOX_PURGE_INTERVAL_MINUTES` | `60` | Cada cuántos minutos corre la purga (1 a 1440) |
| `EVENT_OUTBOX_RETENTION_DAYS` | `7` | Días que un evento `PUBLICADO` se conserva desde `publicado_en` (1 a 365) |
| `EVENT_OUTBOX_FAILED_RETENTION_DAYS` | `30` | Días que un evento `FALLIDO` se conserva desde que falló, para diagnosticar y usar `eventos:reencolar` (7 a 365). Un `PENDIENTE` no se borra nunca |
| `SEARCH_OFFER_TTL_MINUTES` | 30 | Vigencia de una oferta de búsqueda |
| `HOLD_TTL_MINUTES` | 15 | Vigencia de un hold |
| `CANCELLATION_QUOTE_TTL_MINUTES`, `CHANGE_OFFER_TTL_MINUTES` | 15 y 15 | Vigencia de una cotización de cancelación y de una oferta de cambio |
| `CHECKIN_OPENS_HOURS_BEFORE`, `CHECKIN_CLOSES_MINUTES_BEFORE` | 48 y 60 | Ventana de check-in |
| `HOLD_EXPIRY_JOB_ENABLED`, `HOLD_EXPIRY_JOB_INTERVAL_SECONDS` | `true` y 60 | Vencer holds abandonados y borrar claves de idempotencia vencidas |
| `BOOKING_ISSUE_JOB_ENABLED`, `BOOKING_ISSUE_JOB_INTERVAL_SECONDS` | `true` y 30 | Emitir las reservas con pago pendiente cuando se aprueba |
| `POSTSALE_JOB_ENABLED`, `POSTSALE_JOB_INTERVAL_SECONDS` | `true` y 30 | Completar maletas, cambios y cancelaciones pendientes |
| `WEBHOOK_DELIVERY_JOB_ENABLED`, `WEBHOOK_DELIVERY_JOB_INTERVAL_SECONDS` | `true` y 10 | Enviar y reintentar los webhooks |
| `BOARDING_PASS_SECRET` | `JWT_SECRET` | Clave de la firma de los códigos de barras de los pases. Con el mismo valor que el `JWT_SECRET` con que se emitieron, los pases ya emitidos siguen verificando; con otro, dejan de verificar. Obligatoria con `AUTH_MODE=external` si se quita `JWT_SECRET` |
| `GRPC_ENABLED`, `GRPC_PORT` | `false` y 50051 | Servidor gRPC interno para el BFF (`docs/GRPC.md`). En Render queda apagado: el tráfico público llega solo al puerto HTTP (`PORT`); el despliegue de gRPC es la fase de Azure |
| `OTEL_SERVICE_NAME` | `quinde-core` | `service.name` de las trazas y las métricas |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (vacía) | Base OTLP/HTTP del recolector (`http://jaeger:4318`). Sin ella las trazas se generan y se propagan, pero no se exportan |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` (desarrollo) / `0.1` (producción) | Fracción de trazas raíz que se registran (0 a 1). Un span hijo sigue a su padre |
| `TRACE_TRUST_INCOMING` | `true` | Continuar el `traceparent` que llega (REST y gRPC). El core es interno: solo lo alcanzan el gateway y el BFF |
| `METRICS_PORT` | `9464` (en local, `9466`) | Puerto aparte de `/metrics`, que el ingress nunca expone; `0` lo apaga. Distinto de `PORT` y `GRPC_PORT` |

`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` y `DB_PORT` son solo para el entorno local
(`./db/reset.sh` y docker compose); en Render no se usan.

### Procesos periódicos

Los cuatro procesos corren dentro de la API, **uno de cada uno por instancia**: al arrancar, cada
uno deja una línea en el log, `Activo: cada N s` o `Apagado (<VARIABLE>=false)`. Con más de una
instancia todos siguen siendo seguros (cada fila se toma con `FOR UPDATE SKIP LOCKED` y se cierra
con un UPDATE condicionado), pero se puede apagar cada proceso en las instancias de más con su
variable `*_ENABLED=false`. El plan free tiene una sola instancia.

## 4. Verificar el despliegue

```bash
curl -i https://<servicio>.onrender.com/flights/v1/health      # 200 {"status":"UP","database":"UP",...}
open https://<servicio>.onrender.com/api/docs                  # Swagger UI
scripts/smoke.sh https://<servicio>.onrender.com               # salud, login, búsqueda, hold, reserva, cancelación
```

`scripts/smoke.sh` imprime `OK` o `FALLÓ` por paso, sale con 1 si algo falla y no imprime la
contraseña ni los tokens. Crea una cuenta `smoke-...@example.com` y deja su reserva cancelada.
Busca UIO→GYE a 7 días (`SMOKE_ORIGEN`, `SMOKE_DESTINO` y `SMOKE_DIAS` lo cambian): necesita la
semilla cargada hace menos de 83 días.

En el log de Render deberían verse las cuatro líneas de los procesos y
`Nest application successfully started`; ninguna línea lleva contraseñas, tokens, secretos de
webhooks ni datos de pasajeros.

## 5. Problemas conocidos

| Síntoma | Causa y arreglo |
| --- | --- |
| El build falla con `nest: not found` | Falta `--include=dev` en el comando de build |
| La API no arranca: `Variables de entorno inválidas o faltantes: - X: ...` | Falta la variable X o tiene un formato inválido (el mensaje dice cuál y por qué, sin mostrar su valor) |
| `/flights/v1/health` responde 503 | La API no llega a la base: revisar `DATABASE_URL` (host, `sslmode=require`, `&schema=vuelos`) y que el proyecto de Neon no esté suspendido |
| `relation "vuelos.xxx" does not exist` | No se cargaron los esquemas en esa base, o falta `&schema=vuelos` en `DATABASE_URL` |
| La primera petición tarda 30 s o más | El plan free de Render duerme el servicio tras 15 minutos sin tráfico, y Neon suspende la base inactiva: la primera petición los despierta |
| Todas las peticiones cuentan como de la misma IP (429 enseguida) | Falta `TRUST_PROXY=1` |
| Un webhook registrado no recibe nada | En producción solo se aceptan URL `https` públicas; las entregas se reintentan (1 min, 5 min, 30 min, 2 h) y el resultado queda en `vuelos.webhook_entrega` |
| Con `AUTH_MODE=external`, todo da 503 `AUTH_UNAVAILABLE` | La API no puede bajar el JWKS y no tiene una copia vigente: el log dice `No se pudo bajar el JWKS (<motivo>)`. Revisar que `{JWT_ISSUER}/.well-known/jwks.json` (o `JWKS_URL`) responda desde el servidor de la API en menos de 3 s y sin redirección |
| Con `AUTH_MODE=external`, todo token da 401 | El log dice el motivo: `Token rechazado: iss-check_failed` es un `JWT_ISSUER` que no es igual, texto a texto, al de identity (una barra final, http en vez de https); `aud-check_failed`, el `JWT_AUDIENCE`; `kid-desconocido`, un token de otro identity o una clave quitada |
| `scripts/smoke.sh` falla en el login con `AUTH_MODE=external` | El smoke usa `/flights/v1/auth`, que en external no existe: sirve solo en local |

## 6. Cambio de modo de autenticación

`AUTH_MODE` decide quién emite los tokens de acceso que acepta la API:

- `local` (por defecto, y lo que corre en Render): la API emite y verifica sus propios tokens
  (HS256 con `JWT_SECRET`) y monta `/flights/v1/auth/*` y `/flights/v1/admin/users`. Es el
  respaldo hasta el despliegue en Azure.
- `external`: los emite el servicio de identidad
  ([identity_vuelos](https://github.com/chuchobck/identity_vuelos)) y la API solo los verifica
  con su JWKS. `/flights/v1/auth/*` y `/flights/v1/admin/users` no existen (404).

### Qué verifica la API en external

- RS256 y nada más (el algoritmo está fijo en el código: ni `none` ni HS256), con la clave del
  `kid` de la cabecera y `typ` `at+jwt` (RFC 9068).
- `iss` igual a `JWT_ISSUER` texto a texto, `aud` con `JWT_AUDIENCE`, y `exp`, `iat`, `jti` y
  `sub` presentes. `sub` es un uuid, `scope` es texto (scopes separados por espacio) y
  `client_id`, si viene, es el de un cliente máquina a máquina (`client_credentials`).
- `exp` con 30 s de tolerancia por diferencia de reloj con el servicio de identidad.
- Los scopes salen del token; `src/modules/auth/scopes.ts` queda como referencia. Un scope que la
  API no conoce se ignora y se avisa una vez en el log.
- El `sub` sigue siendo el `id_propietario` de retenciones, reservas y webhooks. Con un token de
  cliente es el id del cliente en el servicio de identidad; la línea de acceso agrega
  `client=<client_id>`.

El JWKS (`{JWT_ISSUER}/.well-known/jwks.json`, o `JWKS_URL`) se guarda el `max-age` de su
`Cache-Control` (identity publica 300 s; se acota entre 30 s y 1 h). Un `kid` que la copia no
tiene la vuelve a bajar, como mucho una vez cada 10 s; cada descarga tiene 3 s de plazo y no sigue
redirecciones. Con una copia vigente, un corte del servicio de identidad no se nota. Sin copia
vigente y sin poder bajarla, la API responde **503** `AUTH_UNAVAILABLE` con `Retry-After`, nunca
401 ni un 200; un token inválido sigue siendo 401 `invalid_token`. Al log van el `kid` y el motivo
de cada rechazo, nunca el token ni el JWKS.

### Variables

| Variable | Valor en external |
| --- | --- |
| `AUTH_MODE` | `external` |
| `JWT_ISSUER` | El `JWT_ISSUER` de identity tal cual: su origen, sin ruta ni barra final, `https` en producción (`https://identity.quinde.example`) |
| `JWT_AUDIENCE` | `quinde-vuelos-api` (el `aud` que identity emite para el core) |
| `JWKS_URL` | Opcional: solo si el JWKS se lee por otra URL (una red interna) |
| `BOARDING_PASS_SECRET` | El valor actual de `JWT_SECRET`: así los pases de abordar ya emitidos siguen verificando. Obligatoria si se quita `JWT_SECRET` |
| `JWT_SECRET` | Ya no firma tokens. Conviene dejarla mientras se pueda volver a local |

### Orden del cambio

1. Antes: identity desplegado con su `JWT_ISSUER` definitivo y su JWKS respondiendo con
   `Cache-Control`; los frontends listos para hablar con identity (ver abajo); un respaldo de la
   base del core. Avisar la ventana: las sesiones abiertas se cierran.
2. En la base de identity, el esquema y la semilla (`./db/reset.sh` de identity_vuelos), que
   crea los roles `cliente` y `administrador`.
3. Exportar las cuentas del core (solo lee; no borra nada):

   ```bash
   DATABASE_URL='<URL del core con &schema=vuelos>' npm run auth:exportar-usuarios -- /ruta/fuera/del/repo/exportacion-usuarios.sql
   ```

   El archivo queda con permisos 600 y tiene correos y hashes: nunca dentro del repositorio
   (el script se niega) ni en un chat o un ticket.
4. Cargarlo en identity y leer el aviso:

   ```bash
   psql '<URL de la base de identity>' -v ON_ERROR_STOP=1 -f /ruta/fuera/del/repo/exportacion-usuarios.sql
   # NOTICE:  Usuarios: 969 nuevos, 0 ya estaban con el mismo id, 0 con un correo que en identity tiene otro id (no se tocan)
   ```

   El último número tiene que ser 0. Si no, esa persona ya se registró en identity con otro id y,
   al entrar por ahí, no vería sus reservas del core (son de su id viejo): se resuelve a mano antes
   de seguir. Los mismos id y los hashes argon2id tal cual: cada cuenta entra con su contraseña.
5. En el core: `BOARDING_PASS_SECRET` con el valor de `JWT_SECRET`, `AUTH_MODE=external`,
   `JWT_ISSUER` y `JWT_AUDIENCE`, y reiniciar. El log dice
   `AUTH_MODE=external: tokens RS256 de <emisor>, claves de <url del JWKS>`.
6. Repetir 3 y 4: recoge las cuentas creadas en el core entre la exportación y el reinicio (la
   carga es idempotente). Borrar el archivo (`shred -u`).
7. Verificar: `/flights/v1/health` 200; `POST /flights/v1/auth/login` 404; login en identity y
   `GET /flights/v1/bookings` con ese token, 200; en el log, `JWKS descargado: N claves (kid ...)`.
8. Pasar los frontends a identity.

### Sesiones abiertas

- Los access tokens HS256 que emitió el core dejan de servir en el paso 5 (401 `invalid_token`).
- Los refresh tokens del core (`token_refresco`) no se migran: cada persona inicia sesión de nuevo
  en identity, con la misma contraseña.
- Retenciones, reservas y webhooks no cambian de dueño: el `sub` es el mismo id.
- Los clientes máquina a máquina son nuevos: se crean en identity (`npm run cliente:crear`).

### Volver a local

1. `AUTH_MODE=local` (o quitarla), con `JWT_SECRET` definida, y reiniciar. `/auth` y
   `/admin/users` vuelven; los tokens de identity dan 401.
2. Las cuentas siguen en la tabla `usuario` del core (la exportación no borró nada) y entran con
   la contraseña que tenían. No vuelve lo que pasó en identity mientras tanto: las cuentas
   creadas allí y los cambios de contraseña (no hay exportación de vuelta).
3. Los frontends vuelven a `/flights/v1/auth`.

### Qué cambia para los frontends

- **e-commerce_vuelos**: registro, login, refresh, logout y perfil pasan a identity
  (`/identity/v1/auth/register`, `/login`, `/refresh`, `/logout`, `/me`), con los mismos cuerpos
  (`email`, `password`, `refresh_token`) y la misma respuesta (`access_token`, `token_type`,
  `expires_in`, `refresh_token`). El `access_token` se sigue mandando al core como hoy. Un 503
  `AUTH_UNAVAILABLE` del core se reintenta después de `Retry-After`; un 401 lleva a refrescar en
  identity.
- **backoffice_vuelos**: usa `/auth/login`, `/auth/refresh`, `/auth/me` y `/admin/users` del core.
  Los tres primeros pasan a identity; `/admin/users` no tiene todavía un equivalente en identity
  (los administradores son el rol `administrador` en su base). Es una dependencia del cambio.
- **bff_vuelos**: no cambia (lecturas públicas, sin token).

## 7. Webhooks: core o notifier

`WEBHOOKS_MODE` (por defecto `local`) decide si los webhooks los reparte el core o el
[notifier](https://github.com/chuchobck/notifier_vuelos). Con `notifier` son obligatorias
`NOTIFIER_URL`, `IDENTITY_TOKEN_URL`, `NOTIFIER_CLIENT_ID` y `NOTIFIER_CLIENT_SECRET` (tabla de
variables arriba), el core no monta `/flights/v1/webhooks` y `RelevoEventos` publica cada evento.
El procedimiento del corte, el retroceso y cómo seguir la bandeja están en
[MIGRACION-WEBHOOKS.md](MIGRACION-WEBHOOKS.md). **No se activa hasta tener el gateway (fase 6).**

## Qué se verificó en local

### Fase 5b (2026-10-16): WEBHOOKS_MODE=notifier con identity_vuelos y notifier_vuelos

- identity (`main`, 3001, `./db/migrar.sh` aplicado), notifier (`main`, 3002, su base en el 5434),
  un receptor local en el 4010 y el core compilado con `WEBHOOKS_MODE=notifier` y
  `AUTH_MODE=external`, con el cliente `core-vuelos` (`events:publish`) creado en identity.
- Una persona de identity se suscribió en el notifier y reservó en el core: la bandeja dejó tres
  eventos (cero en `webhook_entrega`), el relevo los publicó (202) con un solo token y el receptor
  recibió los dos suscritos con la firma válida (recalculada con el secreto de la suscripción) y
  `X-Webhook-Id` igual al `eventId` de la bandeja.
- Con el notifier apagado, otra reserva dejó sus eventos `PENDIENTE` (`ECONNREFUSED`); al volver se
  publicaron al segundo intento y el receptor recibió cada uno una sola vez.
- `webhooks:exportar` sobre la base local y `suscripciones:importar` del notifier: 659 importadas y,
  la segunda vez, 659 "ya existían"; las 35 rechazadas eran datos de prueba (secretos ficticios o
  fechas futuras puestas por pruebas con el reloj adelantado).
- No se verificó: los tres servicios desplegados ni el gateway.

### Purga de la bandeja (2026-10-16)

- El core compilado con `WEBHOOKS_MODE=notifier` (relevo cada 1 s, purga cada 1 min), un identity y
  un notifier de mentira (puertos 3001 y 3002; no los reales, la purga no depende de ellos) y
  `scripts/smoke.sh` contra el core: una reserva real dejó `booking.confirmed`, `ticket_issuing`,
  `ticket_issued` y `cancelled` en la bandeja, y el relevo los pasó a `PUBLICADO` (202).
- Se envejecieron esos 4 eventos 8 días en la base y se sembraron un `PENDIENTE` de 100 días, otro con
  el arrendamiento vencido, un `FALLIDO` de 40 días y otro de 10, y un `PUBLICADO` de 3.
  `npm run eventos:purgar -- --dry-run` dijo «Borraría: 4 PUBLICADO y 1 FALLIDO» sin borrar nada; el
  borrado real dijo «Borradas: 4 PUBLICADO y 1 FALLIDO» y los dos `PENDIENTE`, el `FALLIDO` de 10 días y
  el `PUBLICADO` de 3 siguieron ahí.
- El job (`PurgaBandeja`, cada 1 min) borró en su primera corrida 3 `PUBLICADO` de 9 días con
  «Purga de la bandeja: 3 PUBLICADO y 0 FALLIDO borrados en 17 ms»; el log del core no tenía ningún
  `eventId`, PNR ni sobre.
### Fase 7c (2026-10-21): observabilidad con el gateway, el BFF, identity y el notifier

- identity y notifier (`main`, con sus bases locales), el core compilado de esta rama con
  `AUTH_MODE=external`, `WEBHOOKS_MODE=notifier` y gRPC, el BFF y el gateway (`main`, con sus
  trazas), todos con `TRUST_PROXY=1`; el core y el gateway exportando a un recolector OTLP falso
  (el `scripts/e2e/recolector-otlp.mjs` del gateway, en el 4318) y un proxy delante del notifier que
  anota el `traceparent` que le llega. Base propia del core (`quinde7c_booking`).
- Una reserva por el gateway dio una sola traza `gateway → core → pago`, con los tres eventos de la
  bandeja publicados en la misma traza; el notifier recibió un `traceparent` con ese trace-id.
- Lo que **no** se pudo cerrar: el BFF y el notifier de `main` todavía no tienen observabilidad
  (fase 7b/7c de sus repos), así que `/graphql` da la traza del gateway y la llamada gRPC del BFF al
  core abre una traza raíz aparte. La cadena `gateway → bff → core` se comprobó con un cliente gRPC
  que hace de BFF instrumentado.

### Fase 4b (2026-10-15): AUTH_MODE=external con identity_vuelos

- identity_vuelos (`main`) en el 3001 con su base `identity_db` (puerto 5433), y el core compilado
  (`node dist/main`) con `AUTH_MODE=external`, sin `.env` ni `JWT_SECRET`.
- La migración: 969 cuentas exportadas y cargadas; la segunda carga dijo `0 nuevos, 969 ya estaban`
  y la huella (md5 de ids y hashes) es la misma en las dos bases. El administrador migrado entró
  por identity con su contraseña del core y su token abrió `/flights/v1/admin/audit-log`.
- Registro y login en identity, búsqueda pública, hold y reserva con `PAY-OK` en el core (201
  `CONFIRMED`); un cliente `client_credentials` con `flights:read flights:hold` retuvo cupo (201)
  y al reservar recibió 403 `insufficient_scope`; un token con el scope cambiado, 401; con
  identity apagado el core siguió aceptando tokens (copia del JWKS vigente).
- No se verificó: identity y el core desplegados (https, Azure).

### Fases 1 a 11 (2026-10-06)

- El comando de build de `render.yaml` sobre una copia limpia del repositorio (`git archive`) con
  `NODE_ENV=production`: compila; sin `--include=dev`, `@nestjs/cli` no se instala.
- Esa copia arrancada como en Render (sin `.env`, solo `NODE_ENV=production`, `PORT`,
  `TRUST_PROXY=1`, `DATABASE_URL`, `JWT_SECRET` y `WEBHOOK_SECRET_KEY`): los cuatro procesos
  `Activo`, y `scripts/smoke.sh` pasó los 9 pasos.
- Sin `WEBHOOK_SECRET_KEY`, sin `DATABASE_URL` y `JWT_SECRET`, o con `JWT_SECRET` corta: la API no
  arranca, sale con código 1 y nombra cada variable sin mostrar su valor.
- Con las cuatro variables `*_ENABLED=false`: los cuatro procesos dicen `Apagado (...)`.
- No se verificó: el despliegue real en Render ni la carga en Neon.
