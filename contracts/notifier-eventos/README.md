# Esquemas de eventos del notifier (copia)

Los 12 `<tipo>.v1.json` de
[`notifier_vuelos/contracts/events`](https://github.com/chuchobck/notifier_vuelos/tree/main/contracts/events):
el JSON Schema del sobre que el core publica en `POST /internal/v1/events` con
`WEBHOOKS_MODE=notifier`. Son el contrato del notifier: **no se editan a mano**.

- `npm run eventos:sync` los vuelve a traer de `main` del notifier (`-- --ref <rama>` para otra).
- `npm run eventos:check` los compara con `main` (0 iguales, 1 distintos, 2 sin red). En CI corre
  como job informativo, como el `proto:check` del BFF.
- `test/eventos-notifier.e2e-spec.ts` valida contra ellos cada sobre que genera el core, de los 12
  tipos.
