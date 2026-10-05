#!/usr/bin/env node
// Imprime el hash argon2id de la contraseña que llega en la variable SEED_ADMIN_PASSWORD.
// Lo usa db/reset.sh para sembrar el administrador de desarrollo: SQL no sabe calcular
// argon2id. La contraseña se lee del entorno y no de un argumento para que no aparezca en
// la lista de procesos. Los parámetros son los mismos que usa la API (src/config/parametros-argon2.json).
//
//   SEED_ADMIN_PASSWORD='...' node db/hash-contrasena.js
'use strict';

const path = require('node:path');

let argon2;
try {
  argon2 = require('argon2');
} catch {
  console.error('Falta el paquete argon2: corre "npm ci" antes de ./db/reset.sh');
  process.exit(1);
}
const parametros = require(path.join(__dirname, '..', 'src', 'config', 'parametros-argon2.json'));

const contrasena = process.env.SEED_ADMIN_PASSWORD ?? '';
// Mismas reglas que el registro de la API: de 12 a 128 caracteres.
if (contrasena.length < 12 || contrasena.length > 128) {
  console.error('SEED_ADMIN_PASSWORD debe tener entre 12 y 128 caracteres');
  process.exit(1);
}

argon2
  .hash(contrasena, { type: argon2.argon2id, ...parametros })
  .then((hash) => process.stdout.write(hash))
  .catch((error) => {
    console.error(`No se pudo calcular el hash: ${error.message}`);
    process.exit(1);
  });
