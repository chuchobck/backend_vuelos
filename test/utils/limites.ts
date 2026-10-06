import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

/**
 * Contadores del límite de peticiones que una prueba puede poner en cero. Las pruebas que
 * repiten muchas búsquedas y holds sobre una misma app los reinician entre una y otra; las
 * que prueban el límite usan una app sin esto. Se pasa a crearApp({ limites }).
 */
export class LimitesReiniciables implements ThrottlerStorage {
  private actual = new ThrottlerStorageService();

  increment(...argumentos: Parameters<ThrottlerStorage['increment']>) {
    return this.actual.increment(...argumentos);
  }

  reiniciar(): void {
    this.actual.onApplicationShutdown();
    this.actual = new ThrottlerStorageService();
  }
}
