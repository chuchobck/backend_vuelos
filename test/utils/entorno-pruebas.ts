/**
 * Corre antes de cada archivo de pruebas (setupFiles de jest-e2e.json), antes de que se importe
 * AppModule: ConfigModule valida el entorno al importarse y process.env gana sobre el .env.
 *
 * El proceso periódico de vencimiento se apaga: las pruebas vencen los holds llamando a
 * VencimientoRetenciones.ejecutar() con el reloj adelantado, y una corrida a destiempo podría
 * cerrar un hold en medio de otra prueba.
 */
process.env.HOLD_EXPIRY_JOB_ENABLED = 'false';
