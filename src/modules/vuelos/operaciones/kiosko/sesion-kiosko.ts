import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CodigoError } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { esUuid } from '../../../../common/pipes/formatos';
import { Reloj } from '../../../../common/reloj';

/** Reglas de la sesión de un kiosko. */
export const REGLAS_KIOSKO = {
  /** Minutos que vale la sesión desde la búsqueda: lo que tarda un check-in en el kiosko. */
  duracionMinutos: 10,
  /** El esquema de `Authorization`: no es `Bearer`, así nadie la confunde con un token de acceso. */
  esquema: 'Kiosk',
};

const VERSION = 'ksk1';
const CABECERA = /^Kiosk ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

const sesionInvalida = (motivo: string) =>
  new ErrorNegocio(401, CodigoError.KIOSK_SESSION_INVALID, motivo, {
    cabeceras: { 'WWW-Authenticate': REGLAS_KIOSKO.esquema },
  });

/**
 * La sesión de un kiosko: lo que autoriza el check-in y los pases de UNA reserva después de
 * encontrarla por PNR y apellido, sin cuenta (docs/F1-DISENO.md, sección 4).
 *
 *   ksk1.<payload>.<firma>      (las tres partes en base64url)
 *
 * El payload es `{ r: <id de la reserva>, e: <vence, en segundos> }` y la firma, un HMAC-SHA256
 * con una clave derivada solo para esto del mismo secreto que los pases (BOARDING_PASS_SECRET o
 * JWT_SECRET). No es un token de acceso: tiene otra clave, otro formato y otro esquema de
 * `Authorization` (`Kiosk`), así que `JwtAuthGuard` nunca lo acepta y un JWT nunca pasa por
 * sesión. No guarda estado: vale 10 minutos según el `Reloj` y no se revoca.
 *
 * El token nunca va al log ni a un mensaje de error.
 */
@Injectable()
export class SesionKiosko {
  private readonly clave: Buffer;

  constructor(
    config: ConfigService,
    private readonly reloj: Reloj,
  ) {
    const secreto =
      config.get<string>('BOARDING_PASS_SECRET') || config.getOrThrow<string>('JWT_SECRET');
    this.clave = createHmac('sha256', secreto).update('quinde-vuelos:sesion-kiosko').digest();
  }

  /** Una sesión nueva para esa reserva y cuándo vence. */
  emitir(reservaId: string): { token: string; vence: Date } {
    const segundos =
      Math.floor(this.reloj.ahora().getTime() / 1000) + REGLAS_KIOSKO.duracionMinutos * 60;
    const cuerpo = `${VERSION}.${Buffer.from(JSON.stringify({ r: reservaId, e: segundos })).toString('base64url')}`;
    return { token: `${cuerpo}.${this.firmar(cuerpo)}`, vence: new Date(segundos * 1000) };
  }

  /**
   * El id de la reserva de la sesión que viene en `Authorization: Kiosk <token>`. 401
   * KIOSK_SESSION_INVALID si falta, no tiene el formato, la firma no es la de esta API o venció.
   */
  verificar(autorizacion: string | undefined): string {
    const coincidencia = CABECERA.exec(autorizacion ?? '');
    if (!coincidencia) throw sesionInvalida('A kiosk session is required');
    const token = coincidencia[1];
    const cuerpo = token.slice(0, token.lastIndexOf('.'));
    const [version, payload] = cuerpo.split('.');
    const esperada = Buffer.from(this.firmar(cuerpo));
    const recibida = Buffer.from(token.slice(cuerpo.length + 1));
    if (
      version !== VERSION ||
      esperada.length !== recibida.length ||
      !timingSafeEqual(esperada, recibida)
    ) {
      throw sesionInvalida('The kiosk session is not valid');
    }
    const datos = leerPayload(payload);
    if (!datos) throw sesionInvalida('The kiosk session is not valid');
    if (datos.e * 1000 <= this.reloj.ahora().getTime()) {
      throw sesionInvalida('The kiosk session has expired');
    }
    return datos.r;
  }

  private firmar(cuerpo: string): string {
    return createHmac('sha256', this.clave).update(cuerpo).digest('base64url');
  }
}

/** El payload ya verificado; null si no es el que esta API firma (no debería pasar). */
function leerPayload(payload: string): { r: string; e: number } | null {
  try {
    const datos: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof datos !== 'object' || datos === null) return null;
    const { r, e } = datos as { r?: unknown; e?: unknown };
    return esUuid(r) && typeof e === 'number' && Number.isInteger(e) ? { r, e } : null;
  } catch {
    return null;
  }
}
