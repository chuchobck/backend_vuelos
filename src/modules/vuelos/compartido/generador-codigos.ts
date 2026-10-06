import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';

/**
 * Letras y dígitos del PNR sin los que se confunden al leerlos o dictarlos: sin 0 ni O, sin 1,
 * I ni L. Son 31 símbolos: 31^6 ≈ 887 millones de PNR posibles.
 */
export const ALFABETO_PNR = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LARGO_PNR = 6;
/** Dígitos del número de serie del boleto, después del prefijo de 3 de la aerolínea. */
export const LARGO_SERIE_BOLETO = 10;

/**
 * Códigos al azar (con crypto, no Math.random) para el PNR y el número de boleto. La unicidad
 * la garantiza la base (uq_reserva_cabecera_pnr, uq_boleto_cabecera_numero); quien inserta
 * vuelve a pedir otro si el que salió ya existe. Es un provider para que una prueba lo
 * reemplace y fuerce una colisión.
 */
@Injectable()
export class GeneradorCodigos {
  pnr(): string {
    let codigo = '';
    for (let i = 0; i < LARGO_PNR; i++) codigo += ALFABETO_PNR[randomInt(ALFABETO_PNR.length)];
    return codigo;
  }

  /** Los 10 dígitos de serie de un eTicketNumber (se le antepone el prefijo de la aerolínea). */
  serieBoleto(): string {
    let serie = '';
    for (let i = 0; i < LARGO_SERIE_BOLETO; i++) serie += String(randomInt(10));
    return serie;
  }
}
