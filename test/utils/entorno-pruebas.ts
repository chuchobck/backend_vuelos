/**
 * Corre antes de cada archivo de pruebas (setupFiles de jest-e2e.json), antes de que se importe
 * AppModule: ConfigModule valida el entorno al importarse y process.env gana sobre el .env.
 *
 * Los procesos periódicos se apagan: las pruebas vencen los holds llamando a
 * VencimientoRetenciones.ejecutar() con el reloj adelantado y emiten las reservas pendientes
 * con EmisionPendiente.ejecutar(), la postventa con PendientesPostventa.ejecutar() y envían los
 * webhooks con EntregaWebhooks.ejecutar(); una corrida a destiempo cambiaría datos en medio de otra prueba.
 */
process.env.HOLD_EXPIRY_JOB_ENABLED = 'false';
process.env.BOOKING_ISSUE_JOB_ENABLED = 'false';
process.env.POSTSALE_JOB_ENABLED = 'false';
process.env.WEBHOOK_DELIVERY_JOB_ENABLED = 'false';
// La clave de cifrado de los webhooks es obligatoria; las pruebas no dependen de la del .env
process.env.WEBHOOK_SECRET_KEY ??= 'clave-de-pruebas-de-los-webhooks-0123456789';
