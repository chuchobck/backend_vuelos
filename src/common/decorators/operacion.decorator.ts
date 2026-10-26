import { SetMetadata } from '@nestjs/common';

export const OPERACION_CONTRATO = 'operacionContrato';

/**
 * El operationId del contrato que atiende la ruta (`createBooking`), para la línea de acceso. Lo
 * llevan las rutas de /api/v2; las de v1 se registran como `Controller.método`.
 */
export const OperacionContrato = (operationId: string) =>
  SetMetadata(OPERACION_CONTRATO, operationId);
