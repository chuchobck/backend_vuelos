# Migración de los webhooks al notifier

`WEBHOOKS_MODE` decide quién reparte los webhooks:

- `local` (por defecto, y lo que corre en Render): el core, como desde la fase 10. Cada hecho de
  negocio deja una fila en `webhook_entrega` por suscripción del dueño y `EntregaWebhooks` las envía
  firmadas. `/flights/v1/webhooks` está montado.
- `notifier`: el core guarda **un** evento por hecho en `evento_saliente`, dentro de la misma
  transacción, y `RelevoEventos` lo publica en `POST {NOTIFIER_URL}/internal/v1/events` del
  [notifier](https://github.com/chuchobck/notifier_vuelos). El notifier guarda las suscripciones,
  reparte cada evento y entrega el `WebhookPayload` firmado con reintentos. `/flights/v1/webhooks`
  responde 404 en el core: esas rutas las sirve el notifier.

> **No se activa en ningún despliegue hasta tener el gateway (fase 6).** Sin él, los terceros
> seguirían llamando a `/flights/v1/webhooks` del core, que con `notifier` da 404.

## Qué publica el core

El sobre de [docs/EVENTOS.md del notifier](https://github.com/chuchobck/notifier_vuelos/blob/main/docs/EVENTOS.md):
`eventId`, `eventType`, `schemaVersion` (`1.0`), `occurredAt` (UTC con milisegundos), `ownerId` (el
`id_propietario`) y `data`, con los mismos campos que ya llevaba el `WebhookPayload`. Se arma en el
`INSERT ... SELECT` del hecho y se guarda como texto: cada reintento manda exactamente los mismos
bytes, porque el notifier compara la huella del sobre por `eventId` y responde 409 si cambia uno
solo. Los esquemas están copiados en [contracts/notifier-eventos](../contracts/notifier-eventos/) y
`test/eventos-notifier.e2e-spec.ts` valida contra ellos cada sobre que genera el core.

| Respuesta del notifier | Qué hace el relevo |
| --- | --- |
| `202` (guardado) o `200` (ya estaba) | `PUBLICADO` |
| `400`, `409`, `413`, `415`, `422` (error del publicador) | `FALLIDO` sin reintento, con un aviso en el log |
| `401` | Pide un token nuevo a identity y reintenta en el mismo intento |
| `429`, `5xx`, red caída, 5 s sin respuesta, sin token, `403`, `3xx` u otro `4xx` | Reintenta a los 5 s, 30 s, 2 min, 10 min, 30 min y luego cada hora (o lo que diga `Retry-After`, si es más) |

- Un evento que no se pudo publicar en **48 h** queda `FALLIDO` con un aviso. `npm run eventos:reencolar -- <eventId>`
  (o `-- --todos-los-fallidos`) lo devuelve a `PENDIENTE` con 48 h nuevas y el mismo sobre.
- Si el evento pendiente más viejo lleva más de 15 minutos, el log lo dice (como mucho cada 5 minutos).
- **La traza del hecho llega hasta el notifier** (fase 7c). `evento_saliente.traceparent` guarda el
  `traceparent` del contexto activo cuando se escribió la fila, dentro de la transacción del hecho
  (migración `003_traceparent_evento.sql`; `NULL` en los eventos anteriores). El relevo abre su span
  `CLIENT POST /internal/v1/events` como hijo de ESA traza (no de la corrida del job, que es su propia
  traza raíz) y manda en el POST un `traceparent` nuevo, con el span cliente como padre. El notifier
  ve la misma traza que el gateway y el core. **La entrega del notifier a un tercero no lleva
  `traceparent`**, y en modo local tampoco la de `EntregaWebhooks`: no se revela la estructura
  interna.
- **El orden de llegada no está garantizado**: los eventos de un lote se publican a la vez, y uno que
  se reintenta llega después de otros más nuevos. El tercero ordena por `occurredAt` y descarta
  repetidos por `X-Webhook-Id`, como ya hacía con el core.
- `/flights/v1/health` no mira al notifier: si se cae, el core sigue sirviendo y los eventos esperan
  en la bandeja.
- Seguro con varias instancias: cada evento se toma con `FOR UPDATE SKIP LOCKED` y un arrendamiento de
  60 s; si una instancia muere a medio envío, otra lo retoma al vencer.

Para seguir la bandeja:

```sql
SELECT estado, count(*), min(creado_en) FROM vuelos.evento_saliente GROUP BY estado;
SELECT id_evento, tipo, intentos, ultimo_codigo_http, ultimo_error, proximo_intento
  FROM vuelos.evento_saliente WHERE estado <> 'PUBLICADO' ORDER BY creado_en;
```

## Orden del corte

1. **Notifier desplegado** con su base (`./db/reset.sh` la primera vez, `./db/migrar.sh` después) y la
   **misma `WEBHOOK_SECRET_KEY` del core**: así los secretos exportados se descifran allá y cada tercero
   sigue verificando la firma con su secreto de siempre.
2. **Identity migrado** (`./db/migrar.sh`, que agrega `events:publish`) y el cliente del core creado:

   ```bash
   npm run cliente:crear -- --nombre "core-vuelos" --client-id core-vuelos \
     --scopes "events:publish" --permitir-eventos
   ```

   El `client_secret` sale una sola vez: va directo al gestor de secretos como `NOTIFIER_CLIENT_SECRET`.
3. **Base del core migrada**: `./db/migrar.sh` (crea `evento_saliente`; idempotente, solo agrega).
4. **Exportar del core** (solo lee):

   ```bash
   DATABASE_URL='<URL del core con &schema=vuelos>' npm run webhooks:exportar -- /ruta/fuera/del/repo/suscripciones.jsonl
   ```

5. **Importar en el notifier**:

   ```bash
   npm run suscripciones:importar -- /ruta/fuera/del/repo/suscripciones.jsonl
   # Importadas: N · ya existían: 0 · rechazadas: 0
   ```

   Una línea rechazada dice su número y el campo (por ejemplo, un secreto que no se descifra: la
   `WEBHOOK_SECRET_KEY` no es la del core). Se resuelve antes de seguir.
6. **Repetir 4 y 5 justo antes del corte**: la importación es idempotente (lo que ya estaba cuenta como
   "ya existía") y recoge las suscripciones creadas en el medio. **Las bajas hechas en el core en esa
   ventana no se propagan**: una suscripción ya importada que se borró después en el core sigue activa
   en el notifier. Se da de baja allá a mano (o se acorta la ventana).
7. **Activar `WEBHOOKS_MODE=notifier`** en el core, con `NOTIFIER_URL`, `IDENTITY_TOKEN_URL`,
   `NOTIFIER_CLIENT_ID` y `NOTIFIER_CLIENT_SECRET`, en el **mismo despliegue** en que el gateway empieza
   a enrutar `GET/POST/DELETE /flights/v1/webhooks` al notifier. El log del core dice
   `[RelevoEventos] Activo: cada 5 s` y `[RelevoEventos] Token de identity obtenido...`.
8. **Dejar drenar** las filas viejas: `EntregaWebhooks` sigue enviando lo que quedó `PENDIENTE` en
   `webhook_entrega` (ya no se crean nuevas). Cuando
   `SELECT count(*) FROM vuelos.webhook_entrega WHERE estado = 'PENDIENTE'` dé 0 (los reintentos llegan
   hasta 6 h), apagar `WEBHOOK_DELIVERY_JOB_ENABLED=false`.

**Importar antes de cambiar de modo**: un evento que llega al notifier cuando la suscripción de su dueño
todavía no está importada no se reparte a nadie, y para ese tercero se pierde. Por eso el paso 6 va
justo antes del 7. Durante el drenaje un tercero puede recibir un evento viejo del core y otro nuevo del
notifier: son hechos distintos, con `X-Webhook-Id` distintos.

## Volver a local

1. `WEBHOOKS_MODE=local` (o quitarla) y reiniciar, y que el gateway vuelva a enrutar `/webhooks` al core.
   El core vuelve a repartir en `webhook_entrega`; `RelevoEventos` deja de existir.
2. Lo que quedó `PENDIENTE` en `evento_saliente` no se publica (el relevo no corre en local). Para no
   perderlo, publicarlo antes de volver (esperar a que la bandeja quede sin pendientes) o volver a
   `notifier` más tarde: la bandeja se conserva.
3. Las suscripciones creadas o dadas de baja en el notifier mientras tanto **no vuelven al core**: no hay
   exportación de vuelta. Las que se importaron siguen en el core tal como estaban.
