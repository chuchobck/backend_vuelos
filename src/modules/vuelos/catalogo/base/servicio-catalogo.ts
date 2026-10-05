import { cursorInvalido, enUso, noEncontrado, referenciaInvalida } from './errores-catalogo';
import { codificarCursor, decodificarCursor, LIMITE_POR_DEFECTO } from './paginacion';
import { Ejecutor, FiltroCatalogo, RepositorioCatalogo } from './repositorio-catalogo';

export interface PaginaFilas<Fila> {
  filas: Fila[];
  nextCursor?: string;
}

/**
 * Reglas comunes del catálogo: listar con cursor, obtener, crear, actualizar, dar de baja y
 * reactivar. Cada entidad pone lo propio: cómo se inserta y se modifica, qué impide darla
 * de baja y qué impide reactivarla.
 *
 * - Obtener devuelve también las filas inactivas (el administrador las necesita para
 *   reactivarlas); las listas las ocultan salvo con `includeInactive=true`.
 * - Dar de baja algo ya inactivo, o reactivar algo activo, no es un error: no cambia nada.
 * - Las escrituras corren en `transaccionAuditada`: la auditoría guarda al administrador.
 */
export abstract class ServicioCatalogo<
  Fila,
  Crear,
  Actualizar,
  Filtro extends FiltroCatalogo = FiltroCatalogo,
> {
  /** Nombre de la entidad en los mensajes al cliente (en inglés): `Airport`, `City`... */
  protected abstract readonly entidad: string;

  /** Cómo se dice la baja en el 409 (`deactivated`; una salida se `cancelled`). */
  protected readonly verboBaja: string = 'deactivated';

  constructor(protected readonly repositorio: RepositorioCatalogo<Fila, Filtro>) {}

  /** Inserta y devuelve la clave pública de la fila nueva. */
  protected abstract insertar(dto: Crear, tx: Ejecutor): Promise<string>;

  protected abstract modificar(fila: Fila, dto: Actualizar, tx: Ejecutor): Promise<void>;

  /**
   * Qué filas activas usan esta (en inglés, para el detalle del 409): `active airports`.
   * Vacío si se puede dar de baja.
   */
  protected abstract usosQueImpidenDesactivar(fila: Fila, tx: Ejecutor): Promise<string[]>;

  /**
   * Por qué no se puede reactivar, como `[campo, detalle]` para el 422: típicamente, que
   * la fila de la que depende está dada de baja. Sin motivo, devuelve undefined.
   */
  protected async motivoQueImpideReactivar(
    _fila: Fila,
    _tx: Ejecutor,
  ): Promise<[string, string] | undefined> {
    return undefined;
  }

  async listar(
    filtro: Filtro,
    limite = LIMITE_POR_DEFECTO,
    cursor?: string,
  ): Promise<PaginaFilas<Fila>> {
    let despuesDe: Fila | null = null;
    if (cursor !== undefined) {
      const clave = decodificarCursor(cursor);
      despuesDe = clave === undefined ? null : await this.repositorio.buscar(clave);
      if (despuesDe === null) throw cursorInvalido();
    }

    // Una fila de más dice si hay otra página sin contar todas las filas
    const filas = await this.repositorio.listar(filtro, despuesDe, limite + 1);
    const pagina = filas.slice(0, limite);
    const hayMas = filas.length > limite;
    return {
      filas: pagina,
      nextCursor: hayMas
        ? codificarCursor(this.repositorio.claveDe(pagina[pagina.length - 1]))
        : undefined,
    };
  }

  async obtener(clave: string): Promise<Fila> {
    const fila = await this.repositorio.buscar(clave);
    if (fila === null) throw noEncontrado(this.entidad, clave);
    return fila;
  }

  async crear(dto: Crear): Promise<Fila> {
    const clave = await this.repositorio.enTransaccion((tx) => this.insertar(dto, tx));
    return this.obtener(clave);
  }

  async actualizar(clave: string, dto: Actualizar): Promise<Fila> {
    await this.repositorio.enTransaccion(async (tx) => {
      await this.modificar(await this.exigir(clave, tx), dto, tx);
    });
    return this.obtener(clave);
  }

  async desactivar(clave: string): Promise<void> {
    await this.repositorio.enTransaccion(async (tx) => {
      const fila = await this.exigir(clave, tx);
      if (!this.repositorio.estaActiva(fila)) return;
      const usos = await this.usosQueImpidenDesactivar(fila, tx);
      if (usos.length > 0) throw enUso(this.entidad, clave, usos, this.verboBaja);
      await this.repositorio.fijarActivo(fila, false, tx);
    });
  }

  async reactivar(clave: string): Promise<Fila> {
    await this.repositorio.enTransaccion(async (tx) => {
      const fila = await this.exigir(clave, tx);
      if (this.repositorio.estaActiva(fila)) return;
      const motivo = await this.motivoQueImpideReactivar(fila, tx);
      if (motivo) throw referenciaInvalida(motivo[0], motivo[1]);
      await this.repositorio.fijarActivo(fila, true, tx);
    });
    return this.obtener(clave);
  }

  private async exigir(clave: string, tx: Ejecutor): Promise<Fila> {
    const fila = await this.repositorio.buscar(clave, tx);
    if (fila === null) throw noEncontrado(this.entidad, clave);
    return fila;
  }
}
