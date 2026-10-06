import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { clase_cabina, tipo_codigo_barras } from '../../../../generated/prisma/client';

/** Lo que dice el código de barras de un pase. Ningún dato personal: ni nombre ni documento. */
export interface DatosCodigo {
  pnr: string;
  /** eTicketNumber de 13 dígitos del boleto del pasajero. */
  numeroBoleto: string;
  /** Número de vuelo comercial (LA1400). */
  numeroVuelo: string;
  /** Fecha local de salida en el origen (un `date`). */
  fechaSalida: Date;
  origen: string;
  destino: string;
  /** Asiento (12A). */
  asiento: string;
  /** Posición del pasajero en la reserva, desde 1. */
  secuencia: number;
}

const VERSION = 'BP1';
const LARGO_FIRMA = 12;
const FORMATO =
  /^BP1\|([A-Z0-9]{6})\|(\d{13})\|([A-Z0-9]{2}\d{1,4})\|(\d{8})\|([A-Z]{3})([A-Z]{3})\|(\d{1,3}[A-Z])\|(\d{3})\|([0-9a-f]{12})$/;

/**
 * Código de barras de un pase de abordar: un texto estructurado y firmado, parecido a un BCBP
 * simplificado:
 *
 *   BP1|<PNR>|<boleto>|<vuelo>|<aaaammdd>|<origen><destino>|<asiento>|<orden>|<firma>
 *
 * El contenido es el PNR, el número de boleto, el vuelo, la fecha, la ruta, el asiento y la
 * posición del pasajero en la reserva (para que dos pasajeros del mismo vuelo no repitan el
 * código): nada personal. La firma son los primeros 12 caracteres hexadecimales de un
 * HMAC-SHA256 del resto con una clave derivada de JWT_SECRET para este uso solamente, así quien
 * lee el código en la puerta puede comprobar que lo emitió esta API (`verificar`) sin consultar
 * la base. Es determinista: los mismos datos dan el mismo código.
 */
@Injectable()
export class CodigoPase {
  private readonly clave: Buffer;

  constructor(config: ConfigService) {
    this.clave = createHmac('sha256', config.getOrThrow<string>('JWT_SECRET'))
      .update('quinde-vuelos:codigo-pase-abordar')
      .digest();
  }

  generar(d: DatosCodigo): string {
    const fecha = d.fechaSalida.toISOString().slice(0, 10).replace(/-/g, '');
    const cuerpo = [
      VERSION,
      d.pnr,
      d.numeroBoleto,
      d.numeroVuelo,
      fecha,
      `${d.origen}${d.destino}`,
      d.asiento,
      String(d.secuencia).padStart(3, '0'),
    ].join('|');
    return `${cuerpo}|${this.firmar(cuerpo)}`;
  }

  /** Devuelve lo que dice el código si su formato y su firma son válidos; si no, null. */
  verificar(codigo: string): (Omit<DatosCodigo, 'fechaSalida'> & { fechaSalida: string }) | null {
    const m = FORMATO.exec(codigo);
    if (!m) return null;
    const cuerpo = codigo.slice(0, codigo.lastIndexOf('|'));
    const esperada = Buffer.from(this.firmar(cuerpo));
    const recibida = Buffer.from(m[9]);
    if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
    return {
      pnr: m[1],
      numeroBoleto: m[2],
      numeroVuelo: m[3],
      fechaSalida: `${m[4].slice(0, 4)}-${m[4].slice(4, 6)}-${m[4].slice(6, 8)}`,
      origen: m[5],
      destino: m[6],
      asiento: m[7],
      secuencia: Number(m[8]),
    };
  }

  private firmar(cuerpo: string): string {
    return createHmac('sha256', this.clave).update(cuerpo).digest('hex').slice(0, LARGO_FIRMA);
  }
}

/**
 * Grupo de abordaje por cabina: 1 ejecutiva y primera, 2 económica premium, 3 económica. El
 * catálogo no tiene otro dato para ordenar el abordaje.
 */
export function grupoDeAbordaje(cabina: clase_cabina): string {
  if (cabina === 'EJECUTIVA' || cabina === 'PRIMERA') return '1';
  return cabina === 'ECONOMICA_PREMIUM' ? '2' : '3';
}

/** Posición de abordaje: la fila del asiento con tres dígitos (12A es 012). */
export function posicionDeAbordaje(asiento: string): string {
  return asiento.replace(/[A-Z]$/, '').padStart(3, '0');
}

/**
 * Tipo de código por cabina: PDF417 (el estándar de las aerolíneas y el valor por defecto de la
 * base) en económica y AZTEC (que lee bien una pantalla de teléfono) en las demás.
 */
export function tipoDeCodigo(cabina: clase_cabina): tipo_codigo_barras {
  return cabina === 'ECONOMICA' ? 'PDF417' : 'AZTEC';
}
