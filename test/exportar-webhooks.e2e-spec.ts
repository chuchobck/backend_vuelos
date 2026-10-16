import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { desactivarUsuariosDePrueba } from './utils/auth';
import { crearApp } from './utils/crear-app';
import { con, nuevoCliente } from './utils/reserva';

const RAIZ = resolve(__dirname, '..');
const SCRIPT = join(RAIZ, 'scripts', 'exportar-webhooks.cjs');
const WEBHOOKS = '/flights/v1/webhooks';
const CAMPOS = [
  'id',
  'idPropietario',
  'url',
  'secretoCifrado',
  'eventos',
  'activo',
  'fechaCreacion',
];

function exportar(
  url: string,
  ...argumentos: string[]
): Promise<{ codigo: number; salida: string }> {
  return new Promise((resolver) => {
    execFile(
      process.execPath,
      [SCRIPT, ...argumentos],
      { cwd: RAIZ, env: { ...process.env, DATABASE_URL: url } },
      (error, stdout, stderr) => {
        const codigo = error ? Number((error as { code?: unknown }).code ?? 1) : 0;
        resolver({ codigo, salida: `${stdout}${stderr}` });
      },
    );
  });
}

describe('npm run webhooks:exportar', () => {
  let app: INestApplication;
  let url: string;
  let carpeta: string;
  let dueno: { id: string; token: string };
  let activa: string;
  let baja: string;
  // Una marca única en la ruta: la API valida el DNS al registrar, así que el host es localhost
  const host = `tercero-${randomUUID().slice(0, 8)}`;
  const secreto = 'secreto-del-tercero-para-exportar-01';

  beforeAll(async () => {
    app = await crearApp();
    url = app.get(ConfigService).getOrThrow<string>('DATABASE_URL');
    carpeta = mkdtempSync(join(tmpdir(), 'exportacion-webhooks-'));
    dueno = await nuevoCliente(app);
    const crear = async (eventos: string[]) =>
      (
        await con(app, dueno.token)('post', WEBHOOKS)
          .send({
            url: `http://localhost:9/${host}/${randomUUID()}`,
            events: eventos,
            secret: secreto,
          })
          .expect(201)
      ).body.id as string;
    activa = await crear(['booking.cancelled', 'booking.confirmed']);
    baja = await crear(['hold.expired']);
    await con(app, dueno.token)('delete', `${WEBHOOKS}/${baja}`).expect(204);
  });

  afterAll(async () => {
    await con(app, dueno.token)('delete', `${WEBHOOKS}/${activa}`);
    rmSync(carpeta, { recursive: true, force: true });
    for (const ruta of [join(RAIZ, 'exportacion-webhooks-e2e.jsonl')])
      rmSync(ruta, { force: true });
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  it('escribe JSON Lines con los siete campos del importador del notifier, en un archivo 600', async () => {
    const ruta = join(carpeta, 'exportacion-webhooks.jsonl');
    const corrida = await exportar(url, ruta);

    expect(corrida.codigo).toBe(0);
    expect(corrida.salida).toMatch(/Exportadas \d+ suscripciones \(\d+ activas\) de \d+ dueños\./);
    expect(statSync(ruta).mode & 0o777).toBe(0o600);

    const lineas = readFileSync(ruta, 'utf8').trimEnd().split('\n');
    const porId = new Map(lineas.map((l) => [JSON.parse(l).id as string, l]));
    for (const linea of lineas) expect(Object.keys(JSON.parse(linea))).toEqual(CAMPOS);

    const guardadas = await app.get(PrismaService).db.webhook_cabecera.findMany({
      where: { id: { in: [activa, baja] } },
    });
    for (const w of guardadas) {
      const linea = JSON.parse(porId.get(w.id)!);
      expect(linea).toEqual({
        id: w.id,
        idPropietario: dueno.id,
        url: w.url,
        // El valor cifrado tal como está en la base: nunca el secreto en claro
        secretoCifrado: w.secreto,
        eventos: w.id === activa ? ['booking.confirmed', 'booking.cancelled'] : ['hold.expired'],
        activo: w.id === activa,
        fechaCreacion: w.fecha_creacion.toISOString(),
      });
      expect(linea.secretoCifrado).toMatch(/^v1\./);
    }
    expect(readFileSync(ruta, 'utf8')).not.toContain(secreto);
  });

  it('por pantalla no salen secretos ni URLs', async () => {
    const corrida = await exportar(url, join(carpeta, 'otra.jsonl'));
    expect(corrida.codigo).toBe(0);
    expect(corrida.salida).not.toContain(host);
    expect(corrida.salida).not.toContain(secreto);
    expect(corrida.salida).not.toMatch(/v1\.[A-Za-z0-9_-]{10,}/);
    expect(corrida.salida).not.toContain('localhost:9');
  });

  it('no escribe dentro del repositorio ni pisa un archivo', async () => {
    const dentro = join(RAIZ, 'exportacion-webhooks-e2e.jsonl');
    const rechazo = await exportar(url, dentro);
    expect(rechazo.codigo).toBe(1);
    expect(rechazo.salida).toContain('tiene que quedar fuera del repositorio');
    expect(() => statSync(dentro)).toThrow();

    const existente = join(carpeta, 'ya-existe.jsonl');
    writeFileSync(existente, 'previo');
    const pisar = await exportar(url, existente);
    expect(pisar.codigo).toBe(1);
    expect(pisar.salida).toContain('el archivo ya existe');
    expect(readFileSync(existente, 'utf8')).toBe('previo');

    expect((await exportar(url)).salida).toContain('Falta el archivo de salida');
  });
});
