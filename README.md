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

| Fase                                  | Estado    |
| ------------------------------------- | --------- |
| 0. Base del repo                      | Hecha     |
| 1. Núcleo (Prisma, rutas, despliegue) | Siguiente |
| 2 a 11                                | Pendiente |

Hoy la API levanta con el **controlador de ejemplo de la plantilla**: los endpoints de vuelos
responden datos vacíos y todavía no leen la base. La lógica real entra desde la fase 1.

## Requisitos

- Node.js 20.19 o superior (recomendado 22; hay un `.nvmrc`)
- Docker con Docker Compose
- Git

## Arranque

```bash
npm ci                    # instala dependencias y activa el hook de commits
cp .env.example .env      # variables de entorno locales
docker compose up -d      # PostgreSQL 18 en el puerto 5432
./db/reset.sh             # crea la base y carga esquema + semilla
npm run start:dev         # API en http://localhost:3000
```

Documentación Swagger: <http://localhost:3000/api/docs>

## Scripts

| Comando                | Qué hace                                         |
| ---------------------- | ------------------------------------------------ |
| `npm run start:dev`    | Levanta la API y recarga al guardar              |
| `npm run build`        | Compila a `dist/`                                |
| `npm run lint`         | Revisa el código con ESLint                      |
| `npm run lint:fix`     | Igual, corrigiendo lo que se pueda               |
| `npm run format`       | Aplica Prettier                                  |
| `npm run format:check` | Verifica el formato sin cambiar archivos         |
| `./db/reset.sh`        | Borra, crea y carga la base (esquema y semilla)  |

## Base de datos

Los archivos de `db/` son la fuente de verdad: la base se crea desde el SQL, no desde el código.

| Archivo                 | Contenido                                                             |
| ----------------------- | --------------------------------------------------------------------- |
| `db/esquema_vuelos.sql` | Esquema `vuelos` en 3FN: 42 tablas, triggers de integridad, auditoría |
| `db/semilla_vuelos.sql` | Red doméstica de Ecuador: 10 aeropuertos, 50 rutas, salidas a 90 días |
| `db/prueba_esquema.sql` | Prueba de restricciones, triggers y auditoría                         |
| `db/reset.sh`           | Borra la base, la crea y carga esquema y semilla                      |

- La semilla genera salidas para los 90 días siguientes al día en que se carga. Pasado ese plazo
  hay que volver a correr `./db/reset.sh`.
- La semilla se carga una sola vez por base; para recargar, siempre `./db/reset.sh`.
- `./db/reset.sh --solo-esquema` deja la base sin datos.

Para correr la prueba del esquema (deja datos de prueba, por eso se resetea al final):

```bash
./db/reset.sh --solo-esquema
docker exec -i booking_db_container psql -U postgres -d booking_db -q < db/prueba_esquema.sql
./db/reset.sh
```

## Cómo se trabaja

- Una rama por fase (`feat/f1-nucleo`, `feat/f2-transversales`, ...) y un pull request a `main`.
- Mensajes de commit en formato Conventional Commits y en español:
  `tipo(ámbito): verbo en infinitivo y qué cambia`. Un hook los valida al hacer commit.

  ```text
  feat(reservas): crear reserva desde un hold
  fix(docker): usar postgres 18
  ```

- Antes de subir: `npm run lint && npm run format:check && npm run build`.
- `.env` nunca se sube; una variable nueva se agrega a `.env.example` en el mismo commit.

## Relación con la plantilla

La plantilla queda como remoto `upstream`. Para traer cambios del contrato:

```bash
git fetch upstream
git merge upstream/main
```

Los módulos de los otros equipos (`alojamientos`, `atracciones`, `autos`) se conservan sin tocar,
pero quedan fuera de la compilación, del lint y del formato: aquí solo se activa `VuelosModule`.
