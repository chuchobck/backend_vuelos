/** Reglas del cortacircuitos hacia Booking. */
export const REGLAS_CORTACIRCUITO = {
  /** Fallos seguidos (red, plazo, 5xx, 429) que lo abren. */
  fallosParaAbrir: 5,
  /** Cuánto queda abierto la primera vez; si la prueba también falla, el doble, hasta el tope. */
  aperturaInicialMs: 30_000,
  aperturaMaximaMs: 300_000,
};

/**
 * Un cortacircuitos simple para no golpear a Booking mientras esté caído.
 *
 * - Cerrado: todo pasa. Cada fallo suma; un éxito (o una respuesta definitiva de Booking, aunque
 *   sea un rechazo: está vivo) lo pone en cero.
 * - Con `fallosParaAbrir` fallos seguidos se abre: `permite()` dice que no hasta `abiertoHasta`.
 * - Vencida la espera pasa UNA llamada de prueba (semiabierto). Si sale bien, se cierra; si falla,
 *   se abre otra vez con el doble de espera (tope `aperturaMaximaMs`).
 *
 * La hora la pone quien llama (el Reloj): las pruebas la adelantan. Vive en memoria de un proceso:
 * cada instancia aprende por su cuenta que Booking está caído.
 */
export class CortaCircuito {
  private fallos = 0;
  private aperturaMs = REGLAS_CORTACIRCUITO.aperturaInicialMs;
  private abiertoHasta: number | undefined;
  private pruebaEnCurso = false;

  /** ¿Se puede llamar ahora? En semiabierto, solo a la primera que pregunta. */
  permite(ahora: Date): boolean {
    if (this.abiertoHasta === undefined) return true;
    if (ahora.getTime() < this.abiertoHasta) return false;
    if (this.pruebaEnCurso) return false;
    this.pruebaEnCurso = true;
    return true;
  }

  /** ¿Dejaría pasar una llamada ahora? Solo mira: no gasta la llamada de prueba. */
  disponible(ahora: Date): boolean {
    if (this.abiertoHasta === undefined) return true;
    return ahora.getTime() >= this.abiertoHasta && !this.pruebaEnCurso;
  }

  /** Cuándo vuelve a dejar pasar una llamada, o undefined si está cerrado. */
  get reabreEn(): Date | undefined {
    return this.abiertoHasta === undefined ? undefined : new Date(this.abiertoHasta);
  }

  get abierto(): boolean {
    return this.abiertoHasta !== undefined;
  }

  exito(): void {
    this.fallos = 0;
    this.aperturaMs = REGLAS_CORTACIRCUITO.aperturaInicialMs;
    this.abiertoHasta = undefined;
    this.pruebaEnCurso = false;
  }

  fallo(ahora: Date): void {
    if (this.pruebaEnCurso) {
      // La llamada de prueba falló: otra vez abierto, con el doble de espera
      this.aperturaMs = Math.min(this.aperturaMs * 2, REGLAS_CORTACIRCUITO.aperturaMaximaMs);
      this.abiertoHasta = ahora.getTime() + this.aperturaMs;
      this.pruebaEnCurso = false;
      return;
    }
    this.fallos++;
    if (this.fallos >= REGLAS_CORTACIRCUITO.fallosParaAbrir && this.abiertoHasta === undefined) {
      this.abiertoHasta = ahora.getTime() + this.aperturaMs;
    }
  }

  /** Una llamada que no llegó a hacerse (se canceló antes): no cuenta ni para bien ni para mal. */
  liberarPrueba(): void {
    this.pruebaEnCurso = false;
  }
}
