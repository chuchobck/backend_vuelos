# CLAUDE.md

Reglas permanentes del proyecto. Léelas antes de tocar código.

## Proyecto

Quinde · API de Vuelos: backend NestJS 10 + TypeScript + Prisma 7 que implementa el contrato
GDS Flight Core API v1.5.0.0 (`contracts/vuelos-openapi.yaml`), solo vuelos nacionales de Ecuador.
Los pagos y el GDS son simulados. El plan y el estado de las fases están en `docs/PLAN.md`.

## Idioma

- Código, carpetas y base de datos en español.
- Rutas y JSON hacia afuera en inglés, como el contrato. Un mapper por entidad traduce.

## Estructura

- Cada entidad lleva `<entidad>.controller.ts` y `<entidad>.routes.ts`, más module, service,
  repository (el único archivo que usa Prisma), mapper y `dto/`.
- Catálogo (CRUD de administrador en `/admin/...`, con clase base): `src/modules/vuelos/catalogo/<entidad>/`
  con pais, ciudad, aeropuerto, aerolinea, modelo-aeronave, familia-tarifa, mapa-asientos, vuelo,
  vuelo-programado y tarifa.
- Operaciones del contrato: `src/modules/vuelos/operaciones/<entidad>/` con busqueda, oferta,
  retencion, reserva, boleto, equipaje, cambio-fecha, cancelacion, checkin, pase-abordar,
  estado-vuelo y webhook.
- Fuera de vuelos: `salud` y `auth`.
- Una sola tabla de rutas: `src/routes/index.routes.ts`.
- Las tablas de detalle no tienen controller: las maneja el service de su cabecera.
- Todas las URLs cuelgan de `/flights/v1`. Swagger en `/api/docs` con las 7 etiquetas del contrato.

## Datos

- La base es la fuente de verdad (`db/*.sql`); no se usa `prisma migrate`.
- Eliminación lógica siempre; nada de `DELETE` físico en datos de negocio.
- Las fechas van siempre en UTC (un `date` llega a medianoche UTC).
- El dinero llega como `Decimal` y se convierte en el mapper; un `bigint` nunca sale al cliente.

## Git

- Commits en Conventional Commits y en español: `tipo(ámbito): verbo en infinitivo y qué cambia`.
- Un commit por paso, y cada uno compila con `npm run lint`, `npm run format:check` y
  `npm run build` limpios.
- No hacer push. Una rama por fase.

## Verificación

- Verificar con `curl` o pruebas, no solo compilando.
- Al terminar cada fase: actualizar `docs/PLAN.md` y entregar un resumen con qué se verificó,
  qué no se pudo verificar y qué se decidió sin consultar.
