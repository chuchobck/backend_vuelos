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
  (o `-- --todos-los-fallidos`) lo devuelve a `PENDIENTE` con 48 h nuevas y el mismo sobre. **Solo
  funciona mientras la fila `FALLIDO` exista**: la purga (abajo) la borra a los 30 días de haber fallado
  (`EVENT_OUTBOX_FAILED_RETENTION_DAYS`); después, `reencolar` responde que no está `FALLIDO` o no existe,
  y el sobre ya no se puede reenviar.
- Si el evento pendiente más viejo lleva más de 15 minutos, el log lo dice (como mucho cada 5 minutos).
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

## Purga de la bandeja

Sin ella `evento_saliente` solo crece (una fila por hecho, también con el dueño sin suscripciones).
Con `WEBHOOKS_MODE=notifier` el job `PurgaBandeja` borra, cada `EVENT_OUTBOX_PURGE_INTERVAL_MINUTES`
(60) minutos:

| Estado | Se borra | Variable |
| --- | --- | --- |
| `PUBLICADO` | a los 7 días de `publicado_en` | `EVENT_OUTBOX_RETENTION_DAYS` (1 a 365) |
| `FALLIDO` | a los 30 días de haber fallado (la fecha de su último cambio, `proximo_intento`) | `EVENT_OUTBOX_FAILED_RETENTION_DAYS` (7 a 365) |
| `PENDIENTE` | **jamás**, ni con el arrendamiento vencido: el relevo lo retoma | — |

- Borra en sentencias de 1000 filas, alternando `PUBLICADO` y `FALLIDO`, hasta 20 000 por corrida; si
  queda más, el log lo dice y sigue en la corrida siguiente. Cada sentencia usa `FOR UPDATE SKIP LOCKED`:
  con varias instancias a la vez (o con `eventos:reencolar` o el relevo tocando una fila) se saltan lo que
  otro tiene tomado, así que nadie espera ni borra la misma fila dos veces. No toca nada con un
  arrendamiento vigente.
- Los días se cuentan con la hora del `Reloj`. Los índices parciales de la migración
  `db/migraciones/002_purga_bandeja.sql` (`ix_evento_saliente_publicado` y `ix_evento_saliente_fallido`)
  sirven a estas sentencias; `./db/migrar.sh` los crea en una base que ya existe.
- El log lleva solo conteos y duración (`Purga de la bandeja: 3 PUBLICADO y 0 FALLIDO borrados en 17 ms`):
  nunca un sobre, un `eventId`, un dueño ni un PNR. Se apaga con `EVENT_OUTBOX_PURGE_JOB_ENABLED=false`.
  En modo `local` el job no existe.
- A mano: `npm run eventos:purgar -- --dry-run` muestra cuántas filas borraría de cada estado (y no borra
  nada); sin `--dry-run` las borra con las mismas reglas (en tandas de 1000, sin tope por corrida). Lee las
  mismas `EVENT_OUTBOX_*`, cuenta la edad con el `now()` de la base e imprime solo conteos.
- **Consecuencia de la retención**: a los 7 días de publicado el core ya no guarda el sobre. Para saber
  qué se publicó después de eso hay que mirar el notifier (que es idempotente por `eventId`). Y un
  `FALLIDO` que nadie reencoló en 30 días se pierde para ese tercero.

```sql
-- Qué borraría la purga ahora (igual que --dry-run)
SELECT estado, count(*) FROM vuelos.evento_saliente
 WHERE (estado = 'PUBLICADO' AND publicado_en < now() - interval '7 days')
    OR (estado = 'FALLIDO' AND proximo_intento < now() - interval '30 days')
 GROUP BY estado;
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
3. **Base del core migrada**: `./db/migrar.sh` (crea `evento_saliente` y los índices de su purga; idempotente,
   solo agrega).
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
