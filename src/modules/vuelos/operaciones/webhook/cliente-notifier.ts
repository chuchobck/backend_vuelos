import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CABECERA_CORRELACION } from '../../../../common/contexto/correlation-id';
import { configuracionNotifier } from '../../../../config/eventos';
import { codigoDeRed } from './cliente-token-identity';

/** Plazo de una publicación (conectar, enviar y recibir la respuesta). */
export const PLAZO_PUBLICACION_MS = 5_000;

/** Ruta del notifier donde se publican los eventos. */
export const RUTA_EVENTOS = '/internal/v1/events';

export interface ResultadoPublicacion {
  /** null: no hubo respuesta HTTP (red caída, plazo agotado). */
  codigoHttp: number | null;
  /** Retry-After de la respuesta, tal cual llegó. */
  retryAfter: string | null;
  /** Un código corto si no hubo respuesta (TIMEOUT, ECONNREFUSED...). */
  error: string | null;
}

/**
 * POST {NOTIFIER_URL}/internal/v1/events con el sobre tal como está guardado (un string: no se
 * vuelve a serializar), el token del cliente core-vuelos y, si el hecho lo tenía, su
 * X-Correlation-Id sin cambios. No sigue redirecciones (una 3xx es un
 * resultado, no un salto), corta a los 5 s y descarta el cuerpo de la respuesta. Nunca lanza.
 */
@Injectable()
export class ClienteNotifier {
  constructor(private readonly config: ConfigService) {}

  async publicar(
    sobre: string,
    token: string,
    correlationId: string | null = null,
  ): Promise<ResultadoPublicacion> {
    const { urlNotifier } = configuracionNotifier(this.config);
    try {
      const respuesta = await fetch(`${urlNotifier}${RUTA_EVENTOS}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(correlationId === null ? {} : { [CABECERA_CORRELACION]: correlationId }),
        },
        body: sobre,
        redirect: 'manual',
        signal: AbortSignal.timeout(PLAZO_PUBLICACION_MS),
      });
      await respuesta.body?.cancel().catch(() => undefined);
      return {
        codigoHttp: respuesta.status,
        retryAfter: respuesta.headers.get('retry-after'),
        error: null,
      };
    } catch (error) {
      return { codigoHttp: null, retryAfter: null, error: codigoDeRed(error, '') };
    }
  }
}
