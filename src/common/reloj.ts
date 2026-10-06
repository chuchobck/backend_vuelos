import { Injectable } from '@nestjs/common';

/**
 * La hora de la aplicación. Quien decide si algo venció (retenciones, claves de idempotencia)
 * la pide aquí en lugar de llamar a `new Date()`: las pruebas reemplazan este provider por uno
 * que se puede adelantar, sin esperas reales y sin depender del reloj de la máquina.
 */
@Injectable()
export class Reloj {
  ahora(): Date {
    return new Date();
  }
}
