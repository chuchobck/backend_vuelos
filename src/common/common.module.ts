import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { opcionesLimitePeticiones } from '../config/limite-peticiones';
import { ProblemDetailsFilter } from './filters/problem-details.filter';
import { AlmacenLimites } from './guards/almacen-limites';
import { GuardLimitePeticiones } from './guards/limite-peticiones.guard';
import { GuardOperacion } from './guards/operacion.guard';
import { Reloj } from './reloj';

/** Global: el Reloj se inyecta en cualquier módulo sin importarlo. */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: opcionesLimitePeticiones,
    }),
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    // Antes que todos: anota la operación para la línea de acceso (no niega nada)
    { provide: APP_GUARD, useClass: GuardOperacion },
    // Primer guard que niega: un cliente que se pasa del límite se corta antes de revisar su JWT.
    { provide: APP_GUARD, useClass: GuardLimitePeticiones },
    // Los contadores usan el Reloj inyectable (no Date.now()): el guard toma este, no el del módulo
    { provide: ThrottlerStorage, useClass: AlmacenLimites },
    Reloj,
  ],
  exports: [Reloj],
})
export class CommonModule {}
