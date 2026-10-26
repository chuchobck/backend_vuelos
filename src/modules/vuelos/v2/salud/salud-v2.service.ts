import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reloj } from '../../../../common/reloj';
import { configuracionExterna, modoAuth } from '../../../../config/autenticacion';
import { modoWebhooks } from '../../../../config/eventos';
import { DependenciaSaludDto, SaludV2Dto } from './dto/salud-v2.dto';
import { SaludV2Repository } from './salud-v2.repository';

/** Reglas de GET /api/v2/vuelos/health. */
export const REGLAS_SALUD_V2 = {
  /** Tope de cada chequeo (se hacen a la vez): la respuesta sale en menos de 1 s. */
  plazoMs: 400,
  /** Cuánto se reusa un resultado: el Monitor de Nodos sondea seguido y no debe cargar la base. */
  cacheSegundos: 5,
  /** Versión del contrato que sirve la fachada. */
  version: '2.0.0',
  nodoPorDefecto: 'NODE_VUE_QUINDE',
  proveedorPorDefecto: 'Quinde',
};

/** Ruta de salud del notifier, bajo NOTIFIER_URL. */
const RUTA_SALUD_NOTIFIER = '/health';

class PlazoAgotado extends Error {}

/** `trabajo`, o PlazoAgotado si no termina a tiempo (el trabajo sigue, pero nadie lo espera). */
async function conPlazo<T>(trabajo: Promise<T>, ms: number): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const plazo = new Promise<never>((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new PlazoAgotado()), ms);
  });
  try {
    return await Promise.race([trabajo, plazo]);
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Salud del nodo para el Monitor de Nodos de Booking (contrato v2, getHealth).
 *
 * - postgres siempre; identity (su JWKS) con AUTH_MODE=external; el notifier (su /health) con
 *   WEBHOOKS_MODE=notifier. Cada uno con su latencia y un plazo de 400 ms, todos a la vez.
 * - HEALTHY si todo responde; DEGRADED si cae identity o el notifier (el core sigue: el JWKS
 *   está en caché y los eventos esperan en la bandeja); DOWN si cae la base (503).
 * - El resultado se reusa 5 s (con la hora del Reloj) y las peticiones simultáneas comparten el
 *   mismo chequeo: nunca se cuelga ni carga la base por sondeo.
 * - circuit_breaker_estado: el core no tiene un cortacircuitos propio; es OPEN mientras la base
 *   no responde (no se atiende nada que la necesite) y CLOSED si responde.
 */
@Injectable()
export class SaludV2Service {
  private readonly logger = new Logger(SaludV2Service.name);
  private readonly inicio: Date;
  private guardado: { salud: SaludV2Dto; hasta: number } | undefined;
  private enCurso: Promise<SaludV2Dto> | undefined;

  constructor(
    private readonly repositorio: SaludV2Repository,
    private readonly config: ConfigService,
    private readonly reloj: Reloj,
  ) {
    this.inicio = reloj.ahora();
  }

  revisar(): Promise<SaludV2Dto> {
    const ahora = this.reloj.ahora();
    if (this.guardado && ahora.getTime() < this.guardado.hasta) {
      return Promise.resolve(this.guardado.salud);
    }
    this.enCurso ??= this.medir(ahora).finally(() => (this.enCurso = undefined));
    return this.enCurso;
  }

  private async medir(ahora: Date): Promise<SaludV2Dto> {
    const desde = process.hrtime.bigint();
    const [base, holds, vuelos, ...externas] = await Promise.all([
      this.dependencia('postgres', () => this.repositorio.consultarBase()),
      this.contar(() => this.repositorio.holdsActivos(ahora)),
      this.contar(() => this.repositorio.vuelosDeHoy(ahora)),
      ...this.externas(),
    ]);
    const dependencias = [base, ...externas];
    const status =
      base.status === 'DOWN'
        ? 'DOWN'
        : externas.some((d) => d.status !== 'UP')
          ? 'DEGRADED'
          : 'HEALTHY';

    const salud: SaludV2Dto = {
      status,
      nodo_id: this.config.get<string>('NODO_ID') || REGLAS_SALUD_V2.nodoPorDefecto,
      nombre_proveedor:
        this.config.get<string>('NOMBRE_PROVEEDOR') || REGLAS_SALUD_V2.proveedorPorDefecto,
      vertical: 'VUELOS',
      version: REGLAS_SALUD_V2.version,
      uptime_seconds: Math.max(0, Math.floor((ahora.getTime() - this.inicio.getTime()) / 1000)),
      latencia_ms: milisegundosDesde(desde),
      circuit_breaker_estado: base.status === 'DOWN' ? 'OPEN' : 'CLOSED',
      ...(holds === null ? {} : { holds_activos_count: holds }),
      ...(vuelos === null ? {} : { vuelos_programados_hoy: vuelos }),
      dependencias,
      timestamp: ahora.toISOString(),
    };
    if (status !== 'HEALTHY') {
      const caidas = dependencias.filter((d) => d.status !== 'UP').map((d) => d.nombre);
      this.logger.warn(`Nodo ${status}: no responde ${caidas.join(', ')}`);
    }
    this.guardado = {
      salud,
      hasta: ahora.getTime() + REGLAS_SALUD_V2.cacheSegundos * 1000,
    };
    return salud;
  }

  /** identity y el notifier, solo en los modos que dependen de ellos. */
  private externas(): Array<Promise<DependenciaSaludDto>> {
    const externas: Array<Promise<DependenciaSaludDto>> = [];
    if (modoAuth(this.config) === 'external') {
      const url = configuracionExterna(this.config).urlJwks;
      externas.push(this.dependencia('identity', () => responde(url)));
    }
    if (modoWebhooks(this.config) === 'notifier') {
      const base = this.config.getOrThrow<string>('NOTIFIER_URL').replace(/\/+$/, '');
      externas.push(this.dependencia('notifier', () => responde(base + RUTA_SALUD_NOTIFIER)));
    }
    return externas;
  }

  private async dependencia(
    nombre: string,
    chequeo: () => Promise<unknown>,
  ): Promise<DependenciaSaludDto> {
    const desde = process.hrtime.bigint();
    try {
      await conPlazo(chequeo(), REGLAS_SALUD_V2.plazoMs);
      return { nombre, status: 'UP', latencia_ms: milisegundosDesde(desde) };
    } catch {
      return { nombre, status: 'DOWN', latencia_ms: milisegundosDesde(desde) };
    }
  }

  /** Un conteo, o null si la base no contesta a tiempo (el campo se omite). */
  private async contar(conteo: () => Promise<number>): Promise<number | null> {
    try {
      return await conPlazo(conteo(), REGLAS_SALUD_V2.plazoMs);
    } catch {
      return null;
    }
  }
}

/** GET con un plazo propio; lanza si no hay respuesta o no es 2xx. No sigue redirecciones. */
async function responde(url: string): Promise<void> {
  const respuesta = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(REGLAS_SALUD_V2.plazoMs),
  });
  await respuesta.body?.cancel().catch(() => undefined);
  if (respuesta.status < 200 || respuesta.status > 299) {
    throw new Error(`HTTP_${respuesta.status}`);
  }
}

function milisegundosDesde(desde: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - desde) / 1e6);
}
