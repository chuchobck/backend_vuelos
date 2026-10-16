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
const PURGA = 'src/modules/vuelos/operaciones/webhook/purga-bandeja.ts';
const PURGAR = 'scripts/purgar-eventos.cjs';
const PRUEBA_PURGA = 'test/purga-bandeja.e2e-spec.ts';

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
  [
    'la purga también borra los PENDIENTE',
    BANDEJA,
    [
      ["WHERE estado = 'PUBLICADO' AND id_evento IN (", 'WHERE id_evento IN ('],
      [
        "WHERE estado = 'PUBLICADO' AND publicado_en < ${corte}::timestamptz",
        "WHERE estado <> 'FALLIDO' AND creado_en < ${corte}::timestamptz",
      ],
    ],
    PRUEBA_PURGA,
    'PENDIENTE',
  ],
  [
    'la purga de PUBLICADO ignora la edad',
    BANDEJA,
    [['AND publicado_en < ${corte}::timestamptz', '']],
    PRUEBA_PURGA,
    'PUBLICADO viejos',
  ],
  [
    'la purga de FALLIDO ignora la edad',
    BANDEJA,
    [['AND proximo_intento < ${corte}::timestamptz', '']],
    PRUEBA_PURGA,
    'FALLIDO viejos',
  ],
  [
    'la purga borra sin mirar el arrendamiento (PUBLICADO)',
    BANDEJA,
    [
      [
        'AND publicado_en < ${corte}::timestamptz\n                    AND (arrendamiento_hasta IS NULL OR arrendamiento_hasta <= ${ahora}::timestamptz)',
        'AND publicado_en < ${corte}::timestamptz',
      ],
    ],
    PRUEBA_PURGA,
    'arrendamiento vigente',
  ],
  [
    'la purga borra sin mirar el arrendamiento (FALLIDO)',
    BANDEJA,
    [
      [
        'AND proximo_intento < ${corte}::timestamptz\n                    AND (arrendamiento_hasta IS NULL OR arrendamiento_hasta <= ${ahora}::timestamptz)',
        'AND proximo_intento < ${corte}::timestamptz',
      ],
    ],
    PRUEBA_PURGA,
    'arrendamiento vigente',
  ],
  [
    'la purga no tiene tope de lote',
    PURGA,
    [
      [
        'const cupo = Math.min(REGLAS_PURGA.lote, REGLAS_PURGA.maximoPorCorrida - total);',
        'const cupo = REGLAS_PURGA.maximoPorCorrida - total;',
      ],
    ],
    PRUEBA_PURGA,
    'lotes y tope',
  ],
  [
    'la purga no tiene tope por corrida',
    PURGA,
    [
      [
        'const cupo = Math.min(REGLAS_PURGA.lote, REGLAS_PURGA.maximoPorCorrida - total);',
        'const cupo = REGLAS_PURGA.lote;',
      ],
    ],
    PRUEBA_PURGA,
    'lotes y tope',
  ],
  [
    'la purga espera las filas bloqueadas (sin SKIP LOCKED)',
    BANDEJA,
    [
      [
        'LIMIT ${limite}\n                    FOR UPDATE SKIP LOCKED)`\n      : db',
        'LIMIT ${limite}\n                    FOR UPDATE)`\n      : db',
      ],
    ],
    PRUEBA_PURGA,
    'bloqueada',
  ],
  [
    'la purga cuenta los días con la hora de la máquina, no con el Reloj',
    PURGA,
    [
      [
        'PUBLICADO: new Date(ahora.getTime() - this.retencionPublicadosDias * DIA_MS),',
        'PUBLICADO: new Date(Date.now() - this.retencionPublicadosDias * DIA_MS),',
      ],
    ],
    PRUEBA_PURGA,
    'Reloj',
  ],
  [
    'la purga da un estado por vacío si una sentencia borra menos de lo pedido',
    PURGA,
    [['if (n === 0) pendientes.delete(estado);', 'if (n < cupo) pendientes.delete(estado);']],
    PRUEBA_PURGA,
    'lotes y tope|dos instancias',
  ],
  [
    'eventos:purgar --dry-run cuenta todo, sin mirar la edad',
    PURGAR,
    [
      [
        'FROM ${esquema}.evento_saliente\n            WHERE ${r.donde} AND ${sinArrendamiento}`,\n          [r.dias],',
        "FROM ${esquema}.evento_saliente\n            WHERE estado = '${estado}'`,\n          [],",
      ],
    ],
    PRUEBA_PURGA,
    'dry-run',
  ],
  [
    'eventos:purgar borra los PENDIENTE también',
    PURGAR,
    [
      ["WHERE estado = '${estado}' AND id_evento IN (", 'WHERE id_evento IN ('],
      [
        "donde: `estado = 'PUBLICADO' AND publicado_en < now() - $1 * interval '1 day'`,",
        "donde: `estado <> 'FALLIDO' AND creado_en < now() - $1 * interval '1 day'`,",
      ],
    ],
    PRUEBA_PURGA,
    'eventos:purgar',
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
