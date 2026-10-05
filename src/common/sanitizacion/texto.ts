/**
 * Reglas de limpieza de texto, sin dependencias de Nest para poder probarlas solas.
 *
 * Se limpia en silencio solo lo que no cambia el significado (espacios en los bordes y la
 * forma Unicode). Lo que sí lo cambiaría (caracteres de control, etiquetas HTML) se rechaza.
 */

/** Cc: controles C0 y C1, incluidos NUL, saltos de línea, tabulaciones y DEL. */
const CONTROL = /\p{Cc}/u;

/** Cc menos tabulación, salto de línea y retorno de carro (para textos de varias líneas). */
const CONTROL_SIN_SALTOS = /(?![\t\n\r])\p{Cc}/u;

/**
 * Caracteres invisibles de formato que sirven para disfrazar texto, como rangos de puntos de
 * código: ancho cero y marcas de dirección (200B-200F), separadores de línea y de párrafo y
 * anulaciones bidireccionales (2028-202E, donde U+202E invierte lo que se ve), caracteres
 * invisibles de operación matemática (2060-2064), aislamientos bidireccionales (2066-2069) y
 * el BOM (FEFF).
 */
const RANGOS_INVISIBLES: Array<[number, number]> = [
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const INVISIBLES = new RegExp(
  `[${RANGOS_INVISIBLES.map(([desde, hasta]) => String.fromCodePoint(desde) + '-' + String.fromCodePoint(hasta)).join('')}]`,
  'u',
);

/** Un `<` seguido de letra, `/`, `!` o `?` abre una etiqueta, comentario o instrucción. */
const ETIQUETA_HTML = /<[a-zA-Z/!?]/;

/** Quita los espacios de los bordes y lleva el texto a la forma Unicode NFC (é = un solo carácter). */
export function normalizarTexto(texto: string): string {
  return texto.trim().normalize('NFC');
}

export interface OpcionesControl {
  /** Permite tabulación, salto de línea y retorno de carro (descripciones, comentarios). */
  multilinea?: boolean;
}

export function tieneCaracteresDeControl(texto: string, opciones: OpcionesControl = {}): boolean {
  const controles = opciones.multilinea ? CONTROL_SIN_SALTOS : CONTROL;
  return controles.test(texto) || INVISIBLES.test(texto);
}

export function tieneEtiquetasHtml(texto: string): boolean {
  return ETIQUETA_HTML.test(texto);
}
