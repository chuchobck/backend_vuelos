import 'reflect-metadata';
import { ErrorNegocio } from '../src/common/errores/error-negocio';
import { AuthRepository } from '../src/modules/auth/auth.repository';
import {
  AdministradoresRepository,
  FilaAdministrador,
  ResultadoBaja,
} from '../src/modules/auth/administradores/administradores.repository';
import { AdministradoresService } from '../src/modules/auth/administradores/administradores.service';
import { ContrasenaService } from '../src/modules/auth/seguridad/contrasena.service';

// Reglas de las bajas y de la lista de administradores, sin la API ni la base (el runner solo
// corre test/*.e2e-spec.ts, de ahí el nombre). La regla contra la base va en admin-usuarios.

function servicio(opciones: { baja?: ResultadoBaja; filas?: FilaAdministrador[] } = {}) {
  const repositorio = {
    baja: jest.fn(async () => opciones.baja ?? 'dado-de-baja'),
    listar: jest.fn(async () => opciones.filas ?? []),
  };
  const auth = { crearUsuario: jest.fn(async (id: string, correo: string) => ({ id, correo })) };
  const contrasenas = { hashear: jest.fn(async () => '$argon2id$hash') };
  const instancia = new AdministradoresService(
    auth as unknown as AuthRepository,
    contrasenas as unknown as ContrasenaService,
    repositorio as unknown as AdministradoresRepository,
  );
  return { instancia, repositorio, auth, contrasenas };
}

const fila = (n: number): FilaAdministrador => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  correo: `a${n}@example.com`,
  activo: true,
  fechaCreacion: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
});

async function error(promesa: Promise<unknown>): Promise<ErrorNegocio> {
  try {
    await promesa;
  } catch (e) {
    return e as ErrorNegocio;
  }
  throw new Error('Se esperaba un error');
}

describe('baja de administradores: reglas del service', () => {
  const ID = '00000000-0000-4000-8000-0000000000aa';
  const YO = '00000000-0000-4000-8000-0000000000bb';

  it('la baja normal pasa los ids al repository y no devuelve nada', async () => {
    const { instancia, repositorio } = servicio();
    await expect(instancia.darDeBaja(ID, YO)).resolves.toBeUndefined();
    expect(repositorio.baja).toHaveBeenCalledWith(ID, YO);
  });

  it('idempotente: repetirla sobre quien ya estaba de baja también termina bien', async () => {
    const { instancia } = servicio({ baja: 'ya-estaba-de-baja' });
    await expect(instancia.darDeBaja(ID, YO)).resolves.toBeUndefined();
  });

  it('404 si no existe o no es administrador', async () => {
    const { instancia } = servicio({ baja: 'no-existe' });
    const e = await error(instancia.darDeBaja(ID, YO));
    expect(e.status).toBe(404);
    expect(e.message).toBe(`Administrator ${ID} was not found`);
  });

  it('409 si es la propia cuenta, con un mensaje claro', async () => {
    const { instancia } = servicio({ baja: 'es-el-mismo' });
    const e = await error(instancia.darDeBaja(YO, YO));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/your own account/);
  });

  it('409 si es el último administrador activo', async () => {
    const { instancia } = servicio({ baja: 'es-el-ultimo' });
    const e = await error(instancia.darDeBaja(ID, YO));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/last active administrator/);
  });
});

describe('alta y lista de administradores: service', () => {
  it('el alta fija el rol administrador en el servidor y guarda el hash, no la contraseña', async () => {
    const { instancia, auth, contrasenas } = servicio();
    await instancia.crear({ email: 'nuevo@example.com', password: 'una frase larga de prueba' });
    expect(contrasenas.hashear).toHaveBeenCalledWith('una frase larga de prueba');
    expect(auth.crearUsuario).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      'nuevo@example.com',
      '$argon2id$hash',
      'administrador',
    );
  });

  it('pide limite + 1 filas y entrega nextCursor solo si sobra una', async () => {
    const tres = [fila(3), fila(2), fila(1)];
    const { instancia, repositorio } = servicio({ filas: tres });
    const pagina = await instancia.listar({ limit: 2 });
    expect(repositorio.listar).toHaveBeenCalledWith({
      incluirInactivos: false,
      despuesDe: undefined,
      limite: 2,
    });
    expect(pagina.filas).toHaveLength(2);
    expect(pagina.nextCursor).toBeDefined();

    const { instancia: ultima } = servicio({ filas: [fila(2), fila(1)] });
    expect((await ultima.listar({ limit: 2 })).nextCursor).toBeUndefined();
  });

  it('el cursor devuelto se lee de vuelta: creación e id de la última fila de la página', async () => {
    const { instancia, repositorio } = servicio({ filas: [fila(3), fila(2), fila(1)] });
    const { nextCursor } = await instancia.listar({ limit: 2 });
    await instancia.listar({ limit: 2, cursor: nextCursor, includeInactive: true });
    expect(repositorio.listar).toHaveBeenLastCalledWith({
      incluirInactivos: true,
      despuesDe: { creada: fila(2).fechaCreacion, id: fila(2).id },
      limite: 2,
    });
  });

  it.each([
    'no-base64!',
    Buffer.from('x|y').toString('base64url'),
    Buffer.from('a').toString('base64url'),
  ])('un cursor que no es de esta lista es 400 (%s)', async (cursor) => {
    const { instancia } = servicio();
    const e = await error(instancia.listar({ cursor }));
    expect(e.status).toBe(400);
  });
});
