import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { obtenerContexto } from '../contexto/contexto-peticion';
import { OPERACION_CONTRATO } from '../decorators/operacion.decorator';

/**
 * Primer guard global: no niega nada, solo anota en el contexto qué operación atiende la
 * petición (el operationId de @OperacionContrato o `Controller.método`), para la línea de acceso.
 * Va antes que el límite y que el JWT para que un 429 o un 401 también la lleven.
 */
@Injectable()
export class GuardOperacion implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(contexto: ExecutionContext): boolean {
    const peticion = obtenerContexto();
    if (peticion && contexto.getType() === 'http') {
      peticion.operacion =
        this.reflector.get<string>(OPERACION_CONTRATO, contexto.getHandler()) ??
        `${contexto.getClass().name}.${contexto.getHandler().name}`;
    }
    return true;
  }
}
