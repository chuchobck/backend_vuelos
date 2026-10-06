import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { opcionesLimitePeticiones } from '../config/limite-peticiones';
import { ProblemDetailsFilter } from './filters/problem-details.filter';
import { GuardLimitePeticiones } from './guards/limite-peticiones.guard';
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
    // Primer guard global: un cliente que se pasa del límite se corta antes de revisar su JWT.
    { provide: APP_GUARD, useClass: GuardLimitePeticiones },
    Reloj,
  ],
  exports: [Reloj],
})
export class CommonModule {}
