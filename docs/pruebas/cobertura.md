# Cobertura

Fecha: 2026-10-06 · `npm run test:cov` (la suite e2e completa con `--coverage`, contra la base
real). Se mide `src/**/*.ts` sin el cliente generado de Prisma, `main.ts`, los `*.module.ts` ni
los `*.routes.ts`. No hay umbral obligatorio.

## Total (26 suites, 723 pruebas)

| Sentencias | Ramas | Funciones | Líneas |
| --- | --- | --- | --- |
| 95,96 % (5405/5632) | 82,25 % (1196/1454) | 97,05 % (1220/1257) | 97,07 % (4881/5028) |

Antes de esta fase: 95,82 % de sentencias y 81,70 % de ramas.

## Módulos críticos

| Módulo | Sentencias | Ramas | Funciones | Líneas |
| --- | --- | --- | --- | --- |
| `operaciones/retencion` | 94,67 % | 86,13 % | 96,15 % | 96,51 % |
| `operaciones/reserva` | 94,67 % | 85,71 % | 98,68 % | 96,53 % |
| `operaciones/cancelacion` | 94,91 % | 81,25 % | 100 % | 97,54 % |
| `compartido/pagos` (pagos simulados) | 100 % | 100 % (antes 83,33 %) | 100 % | 100 % |

Pruebas agregadas por los huecos que mostró la cobertura (`test/criticos.e2e-spec.ts`):

- `PagosSimulados`: las cuatro operaciones con `PAY-OK-`, `PAY-PEND-`, `PAY-REJ-`, minúsculas,
  códigos de 3 y de 51 caracteres y una referencia cualquiera.
- Reservar un hold cuyo vuelo pasó a `BOARDING` (409 `OFFER_NO_LONGER_AVAILABLE`, el hold y el
  cupo intactos) o ya salió (409 `FLIGHT_ALREADY_DEPARTED`, sin reserva).
- Cancelar con un pago de maleta pendiente (409) y cancelar después de que se resuelve.
- La `Idempotency-Key` de la cancelación: repetir da el mismo resultado y otro cuerpo es 422.

## Lo menos cubierto

| Carpeta o archivo | Sentencias | Ramas | Qué falta |
| --- | --- | --- | --- |
| `catalogo/vuelo-programado` | 84,21 % | 59,45 % | Combinaciones de validación del PATCH (horas reales sin estimadas, terminales vacías) |
| `src/prisma` | 87,5 % | 70 % | Reconexión y errores de arranque de Prisma |
| `operaciones/emision-pendiente.ts` | 80,48 % | 90 % | La corrida periódica (`setInterval`) y el registro de un error en medio de la corrida |
| `operaciones/pendientes-postventa.ts`, `retencion/vencimiento-retenciones.ts` | 88–89 % | 100 % | Ídem: arranque del intervalo y el `catch` de una corrida que falla |
| Ramas de los catálogos (`pais`, `aerolinea`, `aeropuerto`, `vuelo`) | 98 % | 61–67 % | Filtros opcionales de los listados que las pruebas no combinan |

Los procesos periódicos se prueban llamando a `ejecutar()` con el reloj de prueba; su arranque
por intervalo (apagado en las pruebas) se verificó a mano en la fase 10 y en el despliegue local
de esta fase.
