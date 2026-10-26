#!/usr/bin/env node
/**
 * Pruebas de mutación de la autenticación externa (AUTH_MODE=external) y de la exportación de
 * cuentas: cada mutación rompe a propósito una defensa, corre las pruebas que deberían notarlo
 * y restaura el archivo. Una mutación que sobrevive (las pruebas siguen en verde) es una
 * defensa sin prueba.
 *
 *   node scripts/mutaciones.cjs              # todas
 *   node scripts/mutaciones.cjs enfriamiento # solo las que tengan ese texto en el nombre
 *
 * Necesita lo mismo que npm run test:e2e (PostgreSQL arriba y el .env). Primero corre las
 * pruebas sin mutar: si ya fallan, no sigue. Cada archivo se restaura con su contenido de antes
 * (también con Ctrl+C), así que sirve con cambios sin confirmar. Sale con 1 si sobrevive alguna.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const JEST = require.resolve('jest/bin/jest');

const VERIFICADOR = 'src/modules/auth/seguridad/verificador-jwks.ts';
const CLAVES = 'src/modules/auth/seguridad/claves-jwks.ts';
const GUARD = 'src/common/guards/jwt-auth.guard.ts';
const EXTERNA = 'test/auth-externa.e2e-spec.ts';
const EXPORTAR = 'scripts/exportar-usuarios.cjs';
const PRUEBA_EXPORTAR = 'test/exportar-usuarios.e2e-spec.ts';
const BANDEJA = 'src/modules/vuelos/operaciones/webhook/bandeja-eventos.repository.ts';
const RELEVO = 'src/modules/vuelos/operaciones/webhook/relevo-eventos.ts';
const TOKEN = 'src/modules/vuelos/operaciones/webhook/cliente-token-identity.ts';
const PUBLICADOR = 'src/modules/vuelos/operaciones/webhook/publicador-eventos.ts';
const NOTIFIER = 'test/eventos-notifier.e2e-spec.ts';
// Fachada del contrato v2 (fase V1)
const CONTRATO_V2 = 'test/contrato-v2.e2e-spec.ts';
const SALUD_V2 = 'test/salud-v2.e2e-spec.ts';
const USUARIO_V2 = 'src/modules/vuelos/v2/partner/usuario-v2.ts';
const COBROS = 'src/modules/vuelos/compartido/pagos/cobros.ts';
const CORRELACION = 'src/common/contexto/correlation-id.ts';
const PROBLEMA_V2 = 'src/common/errores/problem-details-v2.ts';
const CODIGO_V2 = 'src/common/errores/codigo-error-v2.ts';
const RESERVAS_V2 = 'src/modules/vuelos/v2/reservas.v2.controller.ts';
const VUELOS_V2 = 'src/modules/vuelos/v2/vuelos.v2.controller.ts';
const FACHADA_V2 = 'src/modules/vuelos/v2/fachada-v2.service.ts';
const MAPPER_V2 = 'src/modules/vuelos/v2/v2.mapper.ts';
const SALUD_SERVICIO_V2 = 'src/modules/vuelos/v2/salud/salud-v2.service.ts';
const ERRORES_VUELOS = 'src/modules/vuelos/compartido/errores.ts';
const CANCELACION = 'src/modules/vuelos/operaciones/cancelacion/cancelacion.service.ts';
const CLIENTE_NOTIFIER = 'src/modules/vuelos/operaciones/webhook/cliente-notifier.ts';
const CONTEXTO_GRPC = 'src/common/contexto/contexto-grpc.ts';
const LOGGER = 'src/common/logger/logger-por-peticion.ts';
const GUARD_OPERACION = 'src/common/guards/operacion.guard.ts';

/** [nombre, archivo, [[buscar, reemplazo], ...], archivo de pruebas, filtro -t (opcional)] */
const MUTACIONES = [
  [
    'el verificador externo acepta HS256 con la clave pública como secreto',
    VERIFICADOR,
    [
      ['algorithms: [ALGORITMO_EXTERNO],', "algorithms: [ALGORITMO_EXTERNO, 'HS256'],"],
      [
        "import { Logger } from '@nestjs/common';",
        "import { Logger } from '@nestjs/common';\nimport { KeyObject } from 'node:crypto';",
      ],
      [
        '    if (clave === undefined) throw new errors.JWKSNoMatchingKey();\n    return clave;',
        '    if (clave === undefined) throw new errors.JWKSNoMatchingKey();\n' +
          "    if (cabecera.alg === 'HS256') return new TextEncoder().encode(KeyObject.from(clave)" +
          ".export({ type: 'spki', format: 'pem' }) as string) as unknown as CryptoKey;\n" +
          '    return clave;',
      ],
    ],
    EXTERNA,
    'clave pública',
  ],
  [
    'el verificador acepta alg none',
    VERIFICADOR,
    [
      [
        'import { CryptoKey, decodeProtectedHeader,',
        'import { CryptoKey, decodeJwt, decodeProtectedHeader,',
      ],
      [
        '({ payload } = await jwtVerify(',
        "({ payload } = decodeProtectedHeader(token).alg === 'none' ? { payload: decodeJwt(token) } : await jwtVerify(",
      ],
    ],
    EXTERNA,
    'alg none',
  ],
  ['no se compara el iss', VERIFICADOR, [['issuer: this.config.emisor,', '']], EXTERNA, 'emisor'],
  [
    'no se compara el aud',
    VERIFICADOR,
    [['audience: this.config.audiencia,', '']],
    EXTERNA,
    'audiencia',
  ],
  ['no se exige typ at+jwt', VERIFICADOR, [['typ: TIPO_TOKEN_ACCESO,', '']], EXTERNA, 'typ'],
  [
    'no se exige exp',
    VERIFICADOR,
    [["requiredClaims: ['exp', 'iat', 'jti', 'sub'],", "requiredClaims: ['iat', 'jti', 'sub'],"]],
    EXTERNA,
    'sin exp',
  ],
  [
    'el sub no se valida como uuid',
    VERIFICADOR,
    [["if (typeof sub !== 'string' || !isUUID(sub))", "if (typeof sub !== 'string')"]],
    EXTERNA,
    'uuid',
  ],
  [
    'cinco minutos de tolerancia de reloj',
    VERIFICADOR,
    [['TOLERANCIA_RELOJ_SEGUNDOS = 30;', 'TOLERANCIA_RELOJ_SEGUNDOS = 300;']],
    EXTERNA,
    'tolera',
  ],
  [
    'los scopes desconocidos no se filtran',
    VERIFICADOR,
    [['return SCOPES.filter((s) => pedidos.includes(s));', 'return pedidos;']],
    EXTERNA,
    'no conoce',
  ],
  [
    'el log de un rechazo lleva el token',
    VERIFICADOR,
    [['(kid ${kid})`;', '(kid ${kid}) ${token}`;']],
    EXTERNA,
    undefined,
  ],
  [
    'pasa con 200 si el JWKS no está',
    GUARD,
    [
      [
        'if (error instanceof JwksNoDisponibleError) throw servicioNoDisponible(error);',
        'if (error instanceof JwksNoDisponibleError) return true;',
      ],
    ],
    EXTERNA,
    'sin copia y sin servicio',
  ],
  [
    'responde 401 si el JWKS no está',
    GUARD,
    [
      [
        'if (error instanceof JwksNoDisponibleError) throw servicioNoDisponible(error);',
        "if (error instanceof JwksNoDisponibleError) throw noAutenticado('The access token is invalid');",
      ],
    ],
    EXTERNA,
    'sin copia y sin servicio',
  ],
  [
    'sin enfriamiento entre descargas',
    CLAVES,
    [['ENFRIAMIENTO_MS = 10_000;', 'ENFRIAMIENTO_MS = 0;']],
    EXTERNA,
    'inventados|enfriamiento',
  ],
  [
    'se usa una copia vencida si el servicio no responde',
    CLAVES,
    [
      [
        '      await this.refrescar();\n      return this.claves.get(kid);\n    }',
        '      await this.refrescar().catch((e) => {\n        if (!this.hayCopia) throw e;\n      });\n' +
          '      return this.claves.get(kid);\n    }',
      ],
    ],
    EXTERNA,
    'copia vencida',
  ],
  [
    'se ignora el max-age (copia de una hora)',
    CLAVES,
    [
      [
        "const vigencia = vigenciaDe(respuesta.headers.get('cache-control'));",
        'const vigencia = VIGENCIA_MAXIMA_S;',
      ],
    ],
    EXTERNA,
    'rotación|copia vencida',
  ],
  [
    'sin plazo de 3 s para bajar el JWKS',
    CLAVES,
    [['signal: AbortSignal.timeout(PLAZO_DESCARGA_MS),', 'signal: AbortSignal.timeout(60_000),']],
    EXTERNA,
    'lento',
  ],
  [
    'el log lleva el JWKS completo',
    CLAVES,
    [
      [
        'const texto = await respuesta.text();',
        'const texto = await respuesta.text();\n      this.logger.log(texto);',
      ],
    ],
    EXTERNA,
    undefined,
  ],
  [
    '/auth y /admin/users se montan también en external',
    'src/app.module.ts',
    [["return entorno.AUTH_MODE !== 'external';", 'return true;']],
    EXTERNA,
    'no existe|Swagger',
  ],
  [
    'la exportación muestra los correos por pantalla',
    EXPORTAR,
    [
      [
        'const activos = cuentas.usuarios.filter((u) => u.activo).length;',
        "const activos = cuentas.usuarios.filter((u) => u.activo).length;\n  console.log(cuentas.usuarios.map((u) => u.correo).join(' '));",
      ],
    ],
    PRUEBA_EXPORTAR,
    'archivo 600',
  ],
  [
    'la exportación queda legible por otros (644)',
    EXPORTAR,
    [['const PERMISOS = 0o600;', 'const PERMISOS = 0o644;']],
    PRUEBA_EXPORTAR,
    'archivo 600',
  ],
  [
    'la exportación se puede escribir dentro del repositorio',
    EXPORTAR,
    [['if (candidata === raiz || candidata.startsWith(raiz + path.sep)) {', 'if (false) {']],
    PRUEBA_EXPORTAR,
    'repositorio',
  ],
  // Fase 5b: la bandeja y el relevo al notifier (WEBHOOKS_MODE=notifier)
  [
    'el evento se guarda fuera de la transacción del hecho',
    BANDEJA,
    [
      [
        '    return tx.$executeRaw`\n      INSERT INTO vuelos.evento_saliente\n             (id_evento, tipo, id_propietario, sobre, proximo_intento, reintentar_hasta, creado_en)\n      SELECT ${eventId}::uuid, ${tipo}::text,',
        '    return this.prisma.db.$executeRaw`\n      INSERT INTO vuelos.evento_saliente\n             (id_evento, tipo, id_propietario, sobre, proximo_intento, reintentar_hasta, creado_en)\n      SELECT ${eventId}::uuid, ${tipo}::text,',
      ],
    ],
    NOTIFIER,
    'se deshace',
  ],
  [
    'cada reintento regenera el eventId',
    RELEVO,
    [
      [
        'let envio = await this.enviar(e.sobre);',
        "let envio = await this.enviar(JSON.stringify({ ...JSON.parse(e.sobre), eventId: require('node:crypto').randomUUID() }));",
      ],
    ],
    NOTIFIER,
    'MISMO cuerpo|mismo cuerpo|byte a byte',
  ],
  [
    'cada reintento vuelve a serializar el sobre',
    RELEVO,
    [
      [
        'let envio = await this.enviar(e.sobre);',
        'let envio = await this.enviar(JSON.stringify(JSON.parse(e.sobre)));',
      ],
    ],
    NOTIFIER,
    'byte a byte',
  ],
  [
    'un 422 se reintenta',
    RELEVO,
    [['new Set([400, 409, 413, 415, 422])', 'new Set([400, 409, 413, 415])']],
    NOTIFIER,
    'error del publicador',
  ],
  [
    'un 503 se marca PUBLICADO',
    RELEVO,
    [
      [
        'if (codigoHttp === 200 || codigoHttp === 202) {',
        'if (codigoHttp === 200 || codigoHttp === 202 || codigoHttp === 503) {',
      ],
    ],
    NOTIFIER,
    'Retry-After|48 h',
  ],
  [
    'sin FOR UPDATE SKIP LOCKED al tomar eventos',
    BANDEJA,
    [['           FOR UPDATE OF e SKIP LOCKED\n', '']],
    NOTIFIER,
    'SKIP LOCKED|dos relevos',
  ],
  [
    'el token va al log',
    TOKEN,
    [['(vigente ${vigencia} s)`', '(vigente ${vigencia} s) ${cuerpo.access_token}`']],
    NOTIFIER,
    undefined,
  ],
  [
    'un 401 no invalida el token',
    RELEVO,
    [
      [
        '      this.tokens.invalidar(envio.token);\n      envio = await this.enviar(e.sobre);',
        '      envio = await this.enviar(e.sobre);',
      ],
    ],
    NOTIFIER,
    '401',
  ],
  [
    'un campo de más en el data de booking.*',
    BANDEJA,
    [
      [
        "'bookingId', rc.id::text, 'pnr', rc.pnr,",
        "'bookingId', rc.id::text, 'pnr', rc.pnr, 'extra', 1,",
      ],
    ],
    NOTIFIER,
    '12 tipos|UNA fila',
  ],
  [
    'con notifier se sigue repartiendo en webhook_entrega',
    PUBLICADOR,
    [["this.alNotifier = modoWebhooks(config) === 'notifier';", 'this.alNotifier = false;']],
    NOTIFIER,
    'UNA fila',
  ],
  [
    '/webhooks se monta también con notifier',
    'src/modules/vuelos/operaciones/operaciones.module.ts',
    [
      [
        'ConditionalModule.registerWhen(WebhookApiModule, (e) => !esModoNotifier(e), { debug: false })',
        'WebhookApiModule',
      ],
    ],
    NOTIFIER,
    '404',
  ],
  // --- Fachada del contrato v2 (fase V1) ---
  [
    '[v2] se confía en X-User-Id sin un token de partner',
    USUARIO_V2,
    [
      [
        'if (usuario.clienteId === undefined) return { ...usuario };',
        "if (usuario.clienteId === undefined && cabeceras['x-user-id'] === undefined) return { ...usuario };",
      ],
    ],
    CONTRATO_V2,
    'token de persona',
  ],
  [
    '[v2] con BOOKING_PROTOTIPO se cobra con la Payment API',
    COBROS,
    [
      [
        "      return 'APROBADO';\n    }",
        "      await this.pagos.autorizar(cobro);\n      return 'APROBADO';\n    }",
      ],
    ],
    CONTRATO_V2,
    'sin llamar a la Payment API',
  ],
  [
    '[v2] se cambia el X-Correlation-Id que llega',
    CORRELACION,
    [
      [
        'esCorrelationIdValido(valor) ? valor :',
        'esCorrelationIdValido(valor) ? valor.toLowerCase() :',
      ],
    ],
    CONTRATO_V2,
    'SIN cambios',
  ],
  [
    '[v2] el error no devuelve el correlation_id',
    PROBLEMA_V2,
    [['correlation_id: datos.correlationId,', 'correlation_id: undefined,']],
    CONTRATO_V2,
    'SIN cambios',
  ],
  [
    '[v2] el reintento de createBooking no marca Idempotent-Replayed',
    RESERVAS_V2,
    [
      [
        "    if (repetida) respuesta.setHeader(CABECERA_REPETIDA, 'true');\n    return this.fachada",
        '    return this.fachada',
      ],
    ],
    CONTRATO_V2,
    'el reintento es 200',
  ],
  [
    '[v2] un partner con X-User-Id opera la reserva de otro usuario final',
    FACHADA_V2,
    [['if (usuario.usuarioExterno === undefined) return;', 'return;']],
    CONTRATO_V2,
    'otro usuario final',
  ],
  [
    '[v2] el listado no filtra por X-User-Id',
    RESERVAS_V2,
    [
      [
        '      usuario.id,\n      usuario.usuarioExterno,\n    );',
        '      usuario.id,\n      undefined,\n    );',
      ],
    ],
    CONTRATO_V2,
    've solo las de ese usuario',
  ],
  [
    '[v2] no se compara payment.amount',
    COBROS,
    [['if (fachada?.monto) exigirMismoMonto(cobro, fachada.monto);', '']],
    CONTRATO_V2,
    'AMOUNT_MISMATCH',
  ],
  [
    '[v2] la referencia de Booking ya usada no se rechaza',
    COBROS,
    [
      [
        '      if (await this.registrados.referenciaUsada(cobro.referencia)) {\n        throw new ErrorNegocio(\n          422,',
        '      if (Number.isNaN(0)) {\n        throw new ErrorNegocio(\n          422,',
      ],
    ],
    CONTRATO_V2,
    'PAYMENT_REFERENCE_INVALID',
  ],
  [
    '[v2] la clave con otro cuerpo sigue siendo 422 como en v1',
    ERRORES_VUELOS,
    [
      [
        'v2: { status: 409, code: CodigoErrorV2.IDEMPOTENCY_KEY_REUSED },',
        'v2: { code: CodigoErrorV2.IDEMPOTENCY_KEY_REUSED },',
      ],
    ],
    CONTRATO_V2,
    'Idempotencia v2',
  ],
  [
    '[v2] la cancelación de una reserva cobrada por Booking pide el reembolso a la Payment API',
    CANCELACION,
    [["    if (emision.proveedor === 'BOOKING_PROTOTIPO') return 'APROBADO';\n", '']],
    CONTRATO_V2,
    'refund CALCULATED',
  ],
  [
    '[v2] la compensación cobra penalidad',
    CANCELACION,
    [
      [
        '(await this.cotizar(reservaId, idPropietario, true)).id',
        '(await this.cotizar(reservaId, idPropietario)).id',
      ],
    ],
    CONTRATO_V2,
    'SAGA_COMPENSATION: sin quoteId',
  ],
  [
    '[v2] repetir la compensación sobre una reserva cancelada es un error',
    CANCELACION,
    [["if (solicitud.reasonCode === 'SAGA_COMPENSATION') {", 'if (Number.isNaN(0)) {']],
    CONTRATO_V2,
    'repetirla responde lo mismo',
  ],
  [
    '[v2] ttlMinutes se ignora',
    RESERVAS_V2,
    [
      [
        '      clave,\n      solicitud.ttlMinutes,\n    );',
        '      clave,\n      undefined,\n    );',
      ],
    ],
    CONTRATO_V2,
    'createHold: 201 con ttlMinutes',
  ],
  [
    '[v2] el mapa de asientos no trae status',
    MAPPER_V2,
    [
      [
        'return estado === undefined ? asiento : { ...asiento, status: estado };',
        'return asiento;',
      ],
    ],
    CONTRATO_V2,
    'getSeatMap',
  ],
  [
    '[v2] issueTickets responde 200 en una reserva cancelada',
    FACHADA_V2,
    [
      [
        "if (!['CONFIRMADA', 'PENDIENTE_PAGO', 'EMITIENDO_BOLETOS'].includes(reserva.estado)) {",
        'if (Number.isNaN(0)) {',
      ],
    ],
    CONTRATO_V2,
    'issueTickets: 200 issued 0',
  ],
  [
    '[v2] ProblemDetails v2 deja VALIDATION_FAILED en un 404',
    CODIGO_V2,
    [['  if (status === 404) return CodigoErrorV2.NOT_FOUND;\n', '']],
    CONTRATO_V2,
    'getBooking, listTickets',
  ],
  [
    '[v2] la bandeja no guarda el X-Correlation-Id del hecho',
    PUBLICADOR,
    [['correlationId: correlacionActual() ?? null,', 'correlationId: null,']],
    CONTRATO_V2,
    'evento_saliente',
  ],
  [
    '[v2] el relevo no manda X-Correlation-Id al notifier',
    CLIENTE_NOTIFIER,
    [
      [
        '          ...(correlationId === null ? {} : { [CABECERA_CORRELACION]: correlationId }),\n',
        '',
      ],
    ],
    CONTRATO_V2,
    'evento_saliente',
  ],
  [
    '[v2] la Payment API no recibe el X-Correlation-Id',
    COBROS,
    [
      [
        'this.pagos.autorizar({ ...cobro, correlationId: correlacionActual() })',
        'this.pagos.autorizar(cobro)',
      ],
    ],
    CONTRATO_V2,
    'evento_saliente',
  ],
  [
    '[v2] gRPC no lee la metadata x-correlation-id',
    CONTEXTO_GRPC,
    [['correlaciones.length === 1 ? String(correlaciones[0]) : undefined,', 'undefined,']],
    CONTRATO_V2,
    'gRPC',
  ],
  [
    '[v2] las líneas de log no llevan [corr=]',
    LOGGER,
    [
      [
        'return `${linea.slice(0, fin)} [corr=${correlacion}]${linea.slice(fin)}`;',
        'return linea;',
      ],
    ],
    CONTRATO_V2,
    'cada línea de log',
  ],
  [
    '[v2] la línea de acceso no trae el operationId',
    GUARD_OPERACION,
    [['this.reflector.get<string>(OPERACION_CONTRATO, contexto.getHandler()) ??', 'undefined ??']],
    CONTRATO_V2,
    'cada línea de log',
  ],
  [
    '[v2] health responde 200 con la base caída',
    VUELOS_V2,
    [["if (salud.status === 'DOWN') respuesta.status(503);", '']],
    SALUD_V2,
    '503 DOWN',
  ],
  [
    '[v2] health espera a una dependencia colgada',
    SALUD_SERVICIO_V2,
    [['await conPlazo(chequeo(), REGLAS_SALUD_V2.plazoMs);', 'await chequeo();']],
    SALUD_V2,
    'menos de 1 s',
  ],
  [
    '[v2] health no reusa el resultado',
    SALUD_SERVICIO_V2,
    [['if (this.guardado && ahora.getTime() < this.guardado.hasta) {', 'if (Number.isNaN(0)) {']],
    SALUD_V2,
    'se reusa 5 s',
  ],
  [
    '[v2] identity caído deja el nodo HEALTHY',
    SALUD_SERVICIO_V2,
    [["externas.some((d) => d.status !== 'UP')", 'Number.isNaN(0)']],
    SALUD_V2,
    'DEGRADED',
  ],
];

const originales = new Map();

function restaurar() {
  for (const [archivo, contenido] of originales) fs.writeFileSync(archivo, contenido);
  originales.clear();
}

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    restaurar();
    process.exit(130);
  });
}

function aplicar(relativo, cambios) {
  const archivo = path.join(RAIZ, relativo);
  const original = fs.readFileSync(archivo, 'utf8');
  originales.set(archivo, original);
  let mutado = original;
  for (const [buscar, reemplazo] of cambios) {
    const veces = mutado.split(buscar).length - 1;
    if (veces !== 1) {
      throw new Error(
        `"${buscar.slice(0, 60)}" aparece ${veces} veces en ${relativo}: actualiza la mutación`,
      );
    }
    mutado = mutado.replace(buscar, () => reemplazo);
  }
  fs.writeFileSync(archivo, mutado);
}

function correrPruebas(archivos, filtro) {
  const argumentos = [JEST, '--config', 'test/jest-e2e.json', '--runInBand', ...archivos];
  if (filtro) argumentos.push('-t', filtro);
  const corrida = spawnSync(process.execPath, argumentos, { cwd: RAIZ, encoding: 'utf8' });
  const salida = `${corrida.stdout}${corrida.stderr}`;
  const resumen = /Tests:\s+(.*)/.exec(salida)?.[1] ?? 'sin resumen';
  const fallaron = Number(/(\d+) failed/.exec(resumen)?.[1] ?? 0);
  const pasaron = Number(/(\d+) passed/.exec(resumen)?.[1] ?? 0);
  return { codigo: corrida.status, resumen, fallaron, pasaron, salida };
}

function main() {
  const filtroNombre = process.argv[2];
  const elegidas = MUTACIONES.filter(([nombre]) => !filtroNombre || nombre.includes(filtroNombre));
  if (elegidas.length === 0) {
    console.error(`Ninguna mutación tiene "${filtroNombre}" en el nombre`);
    return 2;
  }

  const archivos = [...new Set(elegidas.map((m) => m[3]))];
  console.log(`Sin mutar: ${archivos.join(', ')}`);
  const base = correrPruebas(archivos);
  if (base.codigo !== 0 || base.fallaron > 0) {
    console.error(
      `Las pruebas ya fallan sin mutar (${base.resumen}):\n${base.salida.slice(-3000)}`,
    );
    return 2;
  }
  console.log(`  ${base.resumen}\n`);

  const vivas = [];
  for (const [nombre, archivo, cambios, pruebas, filtro] of elegidas) {
    let resultado;
    try {
      aplicar(archivo, cambios);
      resultado = correrPruebas([pruebas], filtro);
    } finally {
      restaurar();
    }
    // Muerta: alguna prueba falló. Un error de compilación también da código 1, pero sin
    // pruebas fallidas: eso es una mutación mal escrita, no una muerta.
    const muerta = resultado.fallaron > 0;
    const sinPruebas = resultado.fallaron === 0 && resultado.pasaron === 0;
    console.log(`${muerta ? 'muerta' : 'VIVA  '}  ${nombre}  (${resultado.resumen})`);
    if (!muerta) {
      vivas.push(nombre);
      if (sinPruebas || resultado.codigo !== 0) console.log(resultado.salida.slice(-2000));
    }
  }

  console.log(
    `\n${elegidas.length - vivas.length} de ${elegidas.length} mutaciones muertas` +
      (vivas.length ? `; sobreviven: ${vivas.join('; ')}` : ''),
  );
  return vivas.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  restaurar();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
