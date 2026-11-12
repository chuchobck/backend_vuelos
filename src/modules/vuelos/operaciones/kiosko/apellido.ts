import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Un apellido como lo compara el kiosko: sin tildes ni otras marcas, en mayúsculas y solo con
 * letras y dígitos. "D'Alessio Pérez", "dalessio perez" y " D ALESSIO  PEREZ " son
 * DALESSIOPEREZ. La ñ queda como N: un teclado de kiosko puede no tenerla.
 */
export function normalizarApellido(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Contra qué se compara cuando el PNR no existe: la rama hace el mismo trabajo. */
const RELLENO = 'sin-reserva';

/**
 * Compara el apellido que escribió el pasajero con los de la reserva sin fugas de tiempo: no se
 * comparan los textos sino su HMAC-SHA256 (con una clave al azar de este proceso), de largo fijo
 * y con `timingSafeEqual`; no corta en la primera coincidencia y, si la reserva no existe, compara
 * igual contra un relleno. Lo que tarda no dice si el PNR existe ni cuánto se parece el apellido.
 */
@Injectable()
export class ComparadorApellidos {
  private readonly clave = randomBytes(32);

  /** Si `recibido` es el apellido completo de alguno de `guardados` (vacío: nunca). */
  coincide(recibido: string, guardados: readonly string[]): boolean {
    const normalizado = normalizarApellido(recibido);
    const esperada = this.huella(normalizado);
    let alguno = false;
    for (const guardado of guardados.length > 0 ? guardados : [RELLENO]) {
      const igual = timingSafeEqual(esperada, this.huella(normalizarApellido(guardado)));
      alguno = igual || alguno;
    }
    // Un apellido que queda vacío al normalizarlo (solo signos) no identifica a nadie
    return alguno && guardados.length > 0 && normalizado !== '';
  }

  private huella(texto: string): Buffer {
    return createHmac('sha256', this.clave).update(texto).digest();
  }
}
