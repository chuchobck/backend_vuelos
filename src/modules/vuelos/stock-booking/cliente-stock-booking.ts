import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CABECERA_CORRELACION } from '../../../common/contexto/correlation-id';
import { Reloj } from '../../../common/reloj';
import { configuracionStockBooking } from '../../../config/stock-booking';
import { codigoDeRed } from '../operaciones/webhook/cliente-token-identity';
import { CortaCircuito } from './corta-circuito';
import { RegistroStock } from './item-stock';

/** Ruta que se registra como `http.route` del span y en las métricas (la URL completa no). */
export const RUTA_STOCK_BOOKING = '/api/v2/inventory/stock';

/** Lo máximo que se lee de una respuesta: el cuerpo de Booking no se guarda, solo se resume. */
const MAXIMO_CUERPO_BYTES = 4096;

/** Respuestas 4xx que son errores de validación de lo que mandamos: reintentar no sirve. */
export const RECHAZOS_DEFINITIVOS = new Set([400, 404, 409, 413, 415, 422]);

/**
 * Cómo salió un envío:
 * - `ok`: Booking respondió 2xx con `success: true`.
 * - `rechazado`: no se reintenta. Un 4xx de validación (400, 404, 409, 413, 415, 422) o un 2xx con
 *   `success: false` (Booking no integró el registro: p. ej. un item_id que no conoce).
 * - `reintentar`: se reintenta con espera. Red caída, plazo, 5xx, 429, un 3xx, un 401/403 (se
 *   arregla con configuración, sin perder la orden), un 4xx inesperado o un 2xx que no es JSON.
 * - `circuito-abierto`: no se llamó: el cortacircuitos está abierto.
 */
export type ResultadoEnvio =
  | { tipo: 'ok'; codigoHttp: number }
  | { tipo: 'rechazado'; codigoHttp: number; error: string; resumen: string | null }
  | { tipo: 'reintentar'; codigoHttp: number | null; error: string; retryAfter: string | null }
  | { tipo: 'circuito-abierto'; reabreEn: Date };

/**
 * POST {BOOKING_STOCK_URL} con UN registro (JSON), plazo `BOOKING_STOCK_TIMEOUT_MS` (5 s por
 * defecto: el ESB de Booking corta ahí), sin seguir redirecciones. Manda `X-Correlation-Id`, y nunca
 * `traceparent` (Booking es un tercero). No hay cabecera de autenticación documentada, así que no
 * se manda ninguna. Nunca lanza.
 *
 * Al log y a la base solo llegan un código corto (HTTP_503, TIMEOUT, SUCCESS_FALSE...) y, de un
 * rechazo, un resumen acotado y saneado del mensaje de Booking: nunca la URL ni el cuerpo entero.
 */
@Injectable()
export class ClienteStockBooking {
  readonly cortacircuito = new CortaCircuito();

  constructor(
    private readonly config: ConfigService,
    private readonly reloj: Reloj,
  ) {}

  /** ¿Conviene intentar ahora? No consume la llamada de prueba del cortacircuitos. */
  get circuitoAbierto(): boolean {
    return this.cortacircuito.abierto;
  }

  async enviar(registro: RegistroStock, correlationId: string): Promise<ResultadoEnvio> {
    const ahora = this.reloj.ahora();
    if (!this.cortacircuito.permite(ahora)) {
      return { tipo: 'circuito-abierto', reabreEn: this.cortacircuito.reabreEn ?? ahora };
    }
    const { url, plazoMs } = configuracionStockBooking(this.config);
    let resultado: ResultadoEnvio;
    try {
      const respuesta = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          [CABECERA_CORRELACION]: correlationId,
        },
        body: JSON.stringify(registro),
        redirect: 'manual',
        signal: AbortSignal.timeout(plazoMs),
      });
      resultado = await interpretar(respuesta);
    } catch (error) {
      resultado = {
        tipo: 'reintentar',
        codigoHttp: null,
        error: codigoDeRed(error, ''),
        retryAfter: null,
      };
    }
    // Un rechazo definitivo también prueba que Booking está vivo: solo lo que se reintenta cuenta como caída
    if (resultado.tipo === 'reintentar') this.cortacircuito.fallo(this.reloj.ahora());
    else this.cortacircuito.exito();
    return resultado;
  }
}

async function interpretar(respuesta: Response): Promise<ResultadoEnvio> {
  const codigoHttp = respuesta.status;
  const retryAfter = respuesta.headers.get('retry-after');
  const cuerpo = await leerCuerpo(respuesta);
  if (codigoHttp >= 200 && codigoHttp < 300) {
    const json = comoObjeto(cuerpo);
    if (json === undefined || typeof json.success !== 'boolean') {
      return { tipo: 'reintentar', codigoHttp, error: 'RESPUESTA_INVALIDA', retryAfter };
    }
    if (json.success) return { tipo: 'ok', codigoHttp };
    return {
      tipo: 'rechazado',
      codigoHttp,
      error: 'SUCCESS_FALSE',
      resumen: resumir(json),
    };
  }
  if (RECHAZOS_DEFINITIVOS.has(codigoHttp)) {
    return {
      tipo: 'rechazado',
      codigoHttp,
      error: `HTTP_${codigoHttp}`,
      resumen: resumir(comoObjeto(cuerpo)),
    };
  }
  return { tipo: 'reintentar', codigoHttp, error: `HTTP_${codigoHttp}`, retryAfter };
}

/** Lee hasta MAXIMO_CUERPO_BYTES de la respuesta y descarta el resto. */
async function leerCuerpo(respuesta: Response): Promise<string> {
  try {
    const lector = respuesta.body?.getReader();
    if (!lector) return '';
    const trozos: Uint8Array[] = [];
    let total = 0;
    while (total < MAXIMO_CUERPO_BYTES) {
      const { done, value } = await lector.read();
      if (done) break;
      trozos.push(value);
      total += value.byteLength;
    }
    await lector.cancel().catch(() => undefined);
    return Buffer.concat(trozos).subarray(0, MAXIMO_CUERPO_BYTES).toString('utf8');
  } catch {
    return '';
  }
}

function comoObjeto(texto: string): Record<string, unknown> | undefined {
  try {
    const valor: unknown = JSON.parse(texto);
    return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
      ? (valor as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * El mensaje de un rechazo, para el log: el primer `message`, `error` o `detail` que sea texto, de
 * hasta 120 caracteres y solo letras, números y puntuación simple (sin saltos de línea ni nada
 * que falsee una línea del log). null si no hay.
 */
export function resumir(cuerpo: Record<string, unknown> | undefined): string | null {
  if (cuerpo === undefined) return null;
  for (const campo of ['message', 'error', 'detail']) {
    const valor = cuerpo[campo];
    if (typeof valor === 'string' && valor.trim() !== '') {
      return valor
        .trim()
        .slice(0, 120)
        .replace(/[^\p{L}\p{N} .,:;()_/'-]/gu, '?');
    }
  }
  return null;
}
