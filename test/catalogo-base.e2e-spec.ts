import {
  Controller,
  Delete,
  Get,
  HttpCode,
  INestApplication,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import * as request from 'supertest';
import { Publico } from '../src/common/decorators/publico.decorator';
import { ErrorNegocio } from '../src/common/errores/error-negocio';
import {
  codificarCursor,
  ConsultaCatalogoDto,
  decodificarCursor,
} from '../src/modules/vuelos/catalogo/base/paginacion';
import {
  Ejecutor,
  FiltroCatalogo,
  RepositorioCatalogo,
} from '../src/modules/vuelos/catalogo/base/repositorio-catalogo';
import { ServicioCatalogo } from '../src/modules/vuelos/catalogo/base/servicio-catalogo';
import { crearApp } from './utils/crear-app';
import { esperarProblemDetails } from './utils/problem-details';

/** Una fila de prueba: `padre` simula la fila de la que depende (para reactivar). */
interface Fila {
  codigo: string;
  activo: boolean;
  padreActivo: boolean;
  enUsoPor: string[];
}

/** Repository en memoria: prueba la lógica de la base sin depender de una tabla. */
class RepositorioEnMemoria extends RepositorioCatalogo<Fila> {
  readonly filas: Fila[] = [];
  transacciones = 0;

  constructor() {
    super(null);
  }

  claveDe(fila: Fila): string {
    return fila.codigo;
  }

  async buscar(clave: string): Promise<Fila | null> {
    return this.filas.find((f) => f.codigo === clave) ?? null;
  }

  async listar(filtro: FiltroCatalogo, despuesDe: Fila | null, cantidad: number): Promise<Fila[]> {
    const desde = despuesDe ? this.filas.indexOf(despuesDe) + 1 : 0;
    return this.filas
      .slice(desde)
      .filter((f) => filtro.incluirInactivos || f.activo)
      .slice(0, cantidad);
  }

  estaActiva(fila: Fila): boolean {
    return fila.activo;
  }

  async fijarActivo(fila: Fila, activo: boolean): Promise<void> {
    fila.activo = activo;
  }

  override async enTransaccion<T>(trabajo: (tx: Ejecutor) => Promise<T>): Promise<T> {
    this.transacciones++;
    return trabajo(null);
  }
}

class ServicioDePrueba extends ServicioCatalogo<Fila, { codigo: string }, { activo?: never }> {
  protected readonly entidad = 'Thing';

  constructor(readonly repo: RepositorioEnMemoria) {
    super(repo);
  }

  protected async insertar(dto: { codigo: string }): Promise<string> {
    this.repo.filas.push({ codigo: dto.codigo, activo: true, padreActivo: true, enUsoPor: [] });
    return dto.codigo;
  }

  protected async modificar(): Promise<void> {}

  protected async usosQueImpidenDesactivar(fila: Fila): Promise<string[]> {
    return fila.enUsoPor;
  }

  protected async motivoQueImpideReactivar(fila: Fila): Promise<[string, string] | undefined> {
    return fila.padreActivo ? undefined : ['parent', 'The parent is inactive'];
  }
}

function nuevoServicio(codigos: string[]): ServicioDePrueba {
  const repo = new RepositorioEnMemoria();
  for (const codigo of codigos) {
    repo.filas.push({ codigo, activo: true, padreActivo: true, enUsoPor: [] });
  }
  return new ServicioDePrueba(repo);
}

async function esperarError(promesa: Promise<unknown>, status: number): Promise<ErrorNegocio> {
  const error = await promesa.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ErrorNegocio);
  expect((error as ErrorNegocio).status).toBe(status);
  return error as ErrorNegocio;
}

describe('Catálogo · servicio base', () => {
  it('pagina con cursor: limit filas por página y sin nextCursor en la última', async () => {
    const servicio = nuevoServicio(['A', 'B', 'C', 'D', 'E']);
    const vistos: string[] = [];
    let cursor: string | undefined;
    let paginas = 0;
    do {
      const pagina = await servicio.listar({ incluirInactivos: false }, 2, cursor);
      vistos.push(...pagina.filas.map((f) => f.codigo));
      cursor = pagina.nextCursor;
      paginas++;
    } while (cursor !== undefined);

    expect(vistos).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(paginas).toBe(3);
  });

  it('una página exacta no deja un nextCursor que lleve a una página vacía', async () => {
    const servicio = nuevoServicio(['A', 'B']);
    const pagina = await servicio.listar({ incluirInactivos: false }, 2);
    expect(pagina.filas).toHaveLength(2);
    expect(pagina.nextCursor).toBeUndefined();
  });

  it('el cursor es opaco y no es la clave en claro; uno inventado responde 400', async () => {
    const servicio = nuevoServicio(['A', 'B', 'C']);
    const { nextCursor } = await servicio.listar({ incluirInactivos: false }, 1);
    expect(nextCursor).not.toBe('A');
    expect(decodificarCursor(nextCursor)).toBe('A');

    await esperarError(servicio.listar({ incluirInactivos: false }, 1, codificarCursor('Z')), 400);
    await esperarError(servicio.listar({ incluirInactivos: false }, 1, 'no-es-base64url!'), 400);
  });

  it('la lista oculta los inactivos salvo con incluirInactivos; obtener los devuelve igual', async () => {
    const servicio = nuevoServicio(['A', 'B', 'C']);
    await servicio.desactivar('B');

    const activos = await servicio.listar({ incluirInactivos: false }, 10);
    const todos = await servicio.listar({ incluirInactivos: true }, 10);
    expect(activos.filas.map((f) => f.codigo)).toEqual(['A', 'C']);
    expect(todos.filas.map((f) => f.codigo)).toEqual(['A', 'B', 'C']);
    expect((await servicio.obtener('B')).activo).toBe(false);
  });

  it('un cursor que apunta a una fila dada de baja sigue sirviendo', async () => {
    const servicio = nuevoServicio(['A', 'B', 'C']);
    const { nextCursor } = await servicio.listar({ incluirInactivos: false }, 1);
    await servicio.desactivar('A');
    const siguiente = await servicio.listar({ incluirInactivos: false }, 5, nextCursor);
    expect(siguiente.filas.map((f) => f.codigo)).toEqual(['B', 'C']);
  });

  it('obtener, actualizar, desactivar y reactivar una clave inexistente responden 404', async () => {
    const servicio = nuevoServicio(['A']);
    for (const promesa of [
      servicio.obtener('X'),
      servicio.actualizar('X', {}),
      servicio.desactivar('X'),
      servicio.reactivar('X'),
    ]) {
      const error = await esperarError(promesa, 404);
      expect(error.detalle).toBe('Thing X was not found');
    }
  });

  it('desactivar algo en uso responde 409 y lo deja activo', async () => {
    const servicio = nuevoServicio(['A']);
    servicio.repo.filas[0].enUsoPor = ['2 active children'];

    const error = await esperarError(servicio.desactivar('A'), 409);
    expect(error.detalle).toBe('Thing A cannot be deactivated: it is used by 2 active children');
    expect(servicio.repo.filas[0].activo).toBe(true);
  });

  it('desactivar y reactivar son idempotentes y corren en una transacción', async () => {
    const servicio = nuevoServicio(['A']);
    await servicio.desactivar('A');
    await servicio.desactivar('A');
    expect(servicio.repo.filas[0].activo).toBe(false);

    expect((await servicio.reactivar('A')).activo).toBe(true);
    expect((await servicio.reactivar('A')).activo).toBe(true);
    expect(servicio.repo.transacciones).toBe(4);
  });

  it('reactivar algo cuya fila de la que depende está inactiva responde 422', async () => {
    const servicio = nuevoServicio(['A']);
    await servicio.desactivar('A');
    servicio.repo.filas[0].padreActivo = false;

    const error = await esperarError(servicio.reactivar('A'), 422);
    expect(error.invalidParams).toEqual([{ name: 'parent', reason: 'The parent is inactive' }]);
    expect(servicio.repo.filas[0].activo).toBe(false);
  });

  it('crear inserta en una transacción y devuelve la fila creada', async () => {
    const servicio = nuevoServicio([]);
    const fila = await servicio.crear({ codigo: 'N' });
    expect(fila).toMatchObject({ codigo: 'N', activo: true });
    expect(servicio.repo.transacciones).toBe(1);
  });
});

/** Expone el servicio en memoria por HTTP para probar la consulta y los errores del filtro. */
const servicioHttp = nuevoServicio(['A', 'B', 'C']);

@Publico()
@Controller('prueba-catalogo')
class ControllerDePrueba {
  @Get()
  async listar(@Query() consulta: ConsultaCatalogoDto) {
    const pagina = await servicioHttp.listar(
      { incluirInactivos: consulta.includeInactive ?? false },
      consulta.limit,
      consulta.cursor,
    );
    return { items: pagina.filas.map((f) => f.codigo), nextCursor: pagina.nextCursor };
  }

  @Get(':codigo')
  async obtener(@Param('codigo') codigo: string) {
    return servicioHttp.obtener(codigo);
  }

  @Delete(':codigo')
  @HttpCode(204)
  async desactivar(@Param('codigo') codigo: string) {
    await servicioHttp.desactivar(codigo);
  }

  @Post(':codigo/reactivate')
  @HttpCode(200)
  async reactivar(@Param('codigo') codigo: string) {
    return servicioHttp.reactivar(codigo);
  }
}

describe('Catálogo · consulta y errores por HTTP', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const RUTA = '/flights/v1/prueba-catalogo';

  beforeAll(async () => {
    app = await crearApp([ControllerDePrueba]);
  });
  afterAll(async () => {
    await app.close();
  });

  it('limit, cursor e includeInactive llegan tipados', async () => {
    const primera = await http().get(RUTA).query({ limit: '2' }).expect(200);
    expect(primera.body.items).toEqual(['A', 'B']);
    const segunda = await http()
      .get(RUTA)
      .query({ limit: '2', cursor: primera.body.nextCursor })
      .expect(200);
    expect(segunda.body).toEqual({ items: ['C'] });

    await http().delete(`${RUTA}/B`).expect(204);
    expect((await http().get(RUTA).expect(200)).body.items).toEqual(['A', 'C']);
    expect((await http().get(RUTA).query({ includeInactive: 'true' })).body.items).toEqual([
      'A',
      'B',
      'C',
    ]);
    await http().post(`${RUTA}/B/reactivate`).expect(200);
  });

  it.each([
    [{ limit: '0' }, 'limit'],
    [{ limit: '51' }, 'limit'],
    [{ limit: 'diez' }, 'limit'],
    [{ includeInactive: 'si' }, 'includeInactive'],
    [{ cursor: 'con espacios y ;' }, 'cursor'],
    [{ cursor: codificarCursor('NO-EXISTE') }, 'cursor'],
    [{ otro: '1' }, 'otro'],
  ])('%p responde 400 nombrando el parámetro', async (query, campo) => {
    const respuesta = await http().get(RUTA).query(query);
    expect(respuesta.status).toBe(400);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.invalidParams.map((p: { name: string }) => p.name)).toContain(campo);
  });

  it('una clave inexistente responde 404 como ProblemDetails', async () => {
    const respuesta = await http().get(`${RUTA}/X`);
    expect(respuesta.status).toBe(404);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.detail).toBe('Thing X was not found');
  });
});
