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
| `JWT_ISSUER`, `JWT_AUDIENCE` | `quinde-vuelos-api` | `iss` y `aud` de los tokens |
| `SEARCH_OFFER_TTL_MINUTES` | 30 | Vigencia de una oferta de búsqueda |
| `HOLD_TTL_MINUTES` | 15 | Vigencia de un hold |
| `CANCELLATION_QUOTE_TTL_MINUTES`, `CHANGE_OFFER_TTL_MINUTES` | 15 y 15 | Vigencia de una cotización de cancelación y de una oferta de cambio |
| `CHECKIN_OPENS_HOURS_BEFORE`, `CHECKIN_CLOSES_MINUTES_BEFORE` | 48 y 60 | Ventana de check-in |
| `HOLD_EXPIRY_JOB_ENABLED`, `HOLD_EXPIRY_JOB_INTERVAL_SECONDS` | `true` y 60 | Vencer holds abandonados y borrar claves de idempotencia vencidas |
| `BOOKING_ISSUE_JOB_ENABLED`, `BOOKING_ISSUE_JOB_INTERVAL_SECONDS` | `true` y 30 | Emitir las reservas con pago pendiente cuando se aprueba |
| `POSTSALE_JOB_ENABLED`, `POSTSALE_JOB_INTERVAL_SECONDS` | `true` y 30 | Completar maletas, cambios y cancelaciones pendientes |
| `WEBHOOK_DELIVERY_JOB_ENABLED`, `WEBHOOK_DELIVERY_JOB_INTERVAL_SECONDS` | `true` y 10 | Enviar y reintentar los webhooks |

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

## Qué se verificó en local (2026-10-06)

- El comando de build de `render.yaml` sobre una copia limpia del repositorio (`git archive`) con
  `NODE_ENV=production`: compila; sin `--include=dev`, `@nestjs/cli` no se instala.
- Esa copia arrancada como en Render (sin `.env`, solo `NODE_ENV=production`, `PORT`,
  `TRUST_PROXY=1`, `DATABASE_URL`, `JWT_SECRET` y `WEBHOOK_SECRET_KEY`): los cuatro procesos
  `Activo`, y `scripts/smoke.sh` pasó los 9 pasos.
- Sin `WEBHOOK_SECRET_KEY`, sin `DATABASE_URL` y `JWT_SECRET`, o con `JWT_SECRET` corta: la API no
  arranca, sale con código 1 y nombra cada variable sin mostrar su valor.
- Con las cuatro variables `*_ENABLED=false`: los cuatro procesos dicen `Apagado (...)`.
- No se verificó: el despliegue real en Render ni la carga en Neon.
