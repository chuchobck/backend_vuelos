<p align="center">
  <img src="docs/logo.svg" alt="Quinde · API de Vuelos" width="380">
</p>

# Quinde · API de Vuelos

Backend del dominio de **vuelos** del Booking Prototipo: implementa el contrato
[GDS Flight Core API v1.5.0.0](contracts/vuelos-openapi.yaml) para vuelos nacionales de Ecuador.

Nace de la [plantilla del equipo](https://github.com/semestre5grupal-ops/Plantilla-Integracion-Sistemas)
(NestJS 10 + TypeScript) y usa PostgreSQL 18. El plan completo, con decisiones, fases y commits,
está en [docs/PLAN.md](docs/PLAN.md).

## Estado

| Fase                                  | Estado                                 |
| ------------------------------------- | -------------------------------------- |
| 0. Base del repo                      | Hecha                                  |
| 1. Núcleo (Prisma, rutas, despliegue) | Hecha en local; falta desplegar Render |
| 2. Transversales                      | Hecha                                  |
| 3. Auth                               | Hecha                                  |
| 4 a 11                                | Pendiente                              |

Hoy la API expone `GET /flights/v1/health` y la autenticación en `/flights/v1/auth`. Prisma ya
lee el esquema `vuelos`; los endpoints del contrato entran desde la fase 4.

Lo transversal ya está en su sitio y lo heredan todos los endpoints que vengan:

- Todo error sale como `application/problem+json` con el esquema `ProblemDetails` del contrato
  (también un 404 de ruta, un 405, un 413 y un fallo inesperado, sin detalles internos).
- Los errores de Prisma y de los triggers de la base se traducen a un status y un `code` del contrato.
- Validación global de DTO (`whitelist`, `forbidNonWhitelisted`), pipes de uuid, fecha e IATA y
  `@TextoLimpio` para el texto libre ([guía](src/common/sanitizacion/README.md)).
- helmet, CORS por lista de orígenes, cuerpo máximo de 100 kB y límite de peticiones por IP (429 con `Retry-After`).
- `X-Request-Id` en cada respuesta y en cada línea de log.
- Toda ruta exige un JWT salvo las marcadas `@Publico()`, y `@Scopes(...)` exige permisos
  ([cómo proteger un endpoint](src/common/README.md)).

## Requisitos

- Node.js 20.19 o superior (recomendado 22; hay un `.nvmrc`)
- Docker con Docker Compose
- Git

## Arranque

```bash
npm ci                    # dependencias, cliente de Prisma y hook de commits
cp .env.example .env      # variables de entorno locales: completa JWT_SECRET
docker compose up -d      # PostgreSQL 18 en el puerto 5432
./db/reset.sh             # crea la base y carga esquemas + semillas
npm run start:dev         # API en http://localhost:3000
curl localhost:3000/flights/v1/health
```

La API no arranca si falta `DATABASE_URL`, `PORT`, `NODE_ENV` o `JWT_SECRET` (al menos 32
caracteres), o si alguna variable tiene un formato inválido. Para generar la clave:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Para tener un administrador local, pon `SEED_ADMIN_PASSWORD` (12 a 128 caracteres) en tu `.env`
antes de `./db/reset.sh`: se crea `admin@quinde.example` (o `SEED_ADMIN_EMAIL`) con todos los
scopes. Sin esa variable no se crea; la contraseña nunca va a git.

Variables opcionales (todas documentadas en `.env.example`):

| Variable                    | Para qué                                                                                                   | Valor por defecto |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- |
| `CORS_ORIGINS`              | Orígenes de navegador permitidos, separados por coma (`https://app.example.com`, sin ruta ni `*`)          | ninguno           |
| `RATE_LIMIT_MAX`            | Peticiones por IP y por ventana en toda la API                                                             | 100               |
| `RATE_LIMIT_WINDOW_SECONDS` | Duración de la ventana del límite                                                                          | 60                |
| `TRUST_PROXY`               | Proxies delante de la API para leer la IP real (`1` en Render; `true` no se acepta)                        | `false`           |
| `JWT_ISSUER`                | `iss` de los tokens que emite y acepta la API                                                              | quinde-vuelos-api |
| `JWT_AUDIENCE`              | `aud` de los tokens que emite y acepta la API                                                              | quinde-vuelos-api |

Si los puertos 5432 o 3000 ya están ocupados, cámbialos en `.env`: `DB_PORT` para la base
(junto con el puerto de `DATABASE_URL`) y `PORT` para la API.

Documentación Swagger: <http://localhost:3000/api/docs>

## Scripts

| Comando                   | Qué hace                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `npm run start:dev`       | Levanta la API y recarga al guardar                         |
| `npm run build`           | Compila a `dist/`                                           |
| `npm run test:e2e`        | Pruebas e2e (Jest + supertest); necesitan PostgreSQL arriba |
| `npm run lint`            | Revisa el código con ESLint                                 |
| `npm run lint:fix`        | Igual, corrigiendo lo que se pueda                          |
| `npm run format`          | Aplica Prettier                                             |
| `npm run format:check`    | Verifica el formato sin cambiar archivos                    |
| `npm run prisma:pull`     | Relee el esquema de la base y regenera el cliente de Prisma |
| `npm run prisma:generate` | Regenera el cliente de Prisma (`npm ci` ya lo hace)         |
| `./db/reset.sh`           | Borra, crea y carga la base (esquemas y semillas)           |

## Base de datos

Los archivos de `db/` son la fuente de verdad: la base se crea desde el SQL, no desde el código.

| Archivo                    | Contenido                                                             |
| -------------------------- | --------------------------------------------------------------------- |
| `db/esquema_vuelos.sql`    | Esquema `vuelos` en 3FN: 42 tablas, triggers de integridad, auditoría |
| `db/esquema_seguridad.sql` | Usuarios, roles y tokens de refresco (4 tablas, mismo esquema)        |
| `db/semilla_vuelos.sql`    | Red doméstica de Ecuador: 10 aeropuertos, 50 rutas, salidas a 90 días |
| `db/semilla_seguridad.sql` | Roles cliente y administrador; administrador local si hay contraseña  |
| `db/hash-contrasena.js`    | Calcula el hash argon2id del administrador para la semilla            |
| `db/prueba_esquema.sql`    | Prueba de restricciones, triggers y auditoría                         |
| `db/reset.sh`              | Borra la base, la crea y carga esquemas y semillas                    |

- La semilla genera salidas para los 90 días siguientes al día en que se carga. Pasado ese plazo
  hay que volver a correr `./db/reset.sh`.
- La semilla se carga una sola vez por base; para recargar, siempre `./db/reset.sh`.
- `./db/reset.sh --solo-esquema` deja la base sin datos (tampoco roles: el registro no funciona).
- Las pruebas e2e crean cuentas `@e2e.quinde.example` y las dejan desactivadas: no se pueden
  borrar (eliminación lógica). `./db/reset.sh` las quita junto con todo lo demás.
- Prisma no crea ni cambia tablas: un cambio se hace en el SQL, se recarga la base y se corre
  `npm run prisma:pull`. `prisma/schema.prisma` no se edita a mano y no se usa `prisma migrate`.

Para correr la prueba del esquema (deja datos de prueba, por eso se resetea al final):

```bash
./db/reset.sh --solo-esquema
docker exec -i booking_db_container psql -U postgres -d booking_db -q < db/prueba_esquema.sql
./db/reset.sh
```

## Imagen Docker

El `Dockerfile` es la imagen que usará Render. No lleva credenciales: `PORT`, `NODE_ENV`,
`DATABASE_URL` y `JWT_SECRET` llegan del entorno.

```bash
docker build -t quinde-vuelos-api .
docker run --rm -p 3000:3000 -e PORT=3000 -e NODE_ENV=production \
  -e DATABASE_URL="postgresql://...?schema=vuelos" -e JWT_SECRET="..." quinde-vuelos-api
```

## Autenticación

En RDA1 la API hace de proveedor de identidad (en RDA2 se cambia por el real):

| Endpoint                   | Para qué                                                                    |
| -------------------------- | --------------------------------------------------------------------------- |
| `POST /auth/register`      | Crea una cuenta de cliente (`email`, `password` de 12 a 128 caracteres)     |
| `POST /auth/login`         | Entrega `access_token` (JWT, 15 min) y `refresh_token` (7 días)             |
| `POST /auth/refresh`       | Cambia el `refresh_token` por uno nuevo; reusar uno viejo cierra la sesión  |
| `POST /auth/logout`        | Revoca el `refresh_token` (con token de acceso)                             |
| `GET /auth/me`             | Perfil, roles y scopes                                                      |

```bash
curl -X POST localhost:3000/flights/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"ana@example.com","password":"una frase larga y fácil"}'
curl localhost:3000/flights/v1/auth/me -H "Authorization: Bearer <access_token>"
```

En Swagger, el botón **Authorize** → `bearer` recibe el `access_token`. Los roles son `cliente`
(registro público) y `administrador` (todos los scopes más `flights:admin`).

## Cómo se trabaja

- Una rama por fase (`feat/f1-nucleo`, `feat/f2-transversales`, ...) y un pull request a `main`.
- Mensajes de commit en formato Conventional Commits y en español:
  `tipo(ámbito): verbo en infinitivo y qué cambia`. Un hook los valida al hacer commit.

  ```text
  feat(reservas): crear reserva desde un hold
  fix(docker): usar postgres 18
  ```

- Antes de subir: `npm run lint && npm run format:check && npm run build && npm run test:e2e`.
- Las reglas permanentes del proyecto están en [CLAUDE.md](CLAUDE.md).
- `.env` nunca se sube; una variable nueva se agrega a `.env.example` en el mismo commit.

## Relación con la plantilla

La plantilla queda como remoto `upstream`. Para traer cambios del contrato:

```bash
git fetch upstream
git merge upstream/main
```

Los módulos de los otros equipos (`alojamientos`, `atracciones`, `autos`) se conservan sin tocar,
pero quedan fuera de la compilación, del lint y del formato: aquí solo se activa `VuelosModule`.
