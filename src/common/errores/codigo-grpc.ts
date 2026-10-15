import { status as EstadoGrpc } from '@grpc/grpc-js';

/**
 * Código gRPC de cada status HTTP de un error. El status y el `code` de ProblemDetails viajan
 * aparte, en la metadata (problem-status y problem-code): este código es para quien solo mira
 * el estado de la llamada. Tabla y motivos en docs/GRPC.md.
 */
const POR_STATUS: Readonly<Record<number, EstadoGrpc>> = {
  400: EstadoGrpc.INVALID_ARGUMENT,
  401: EstadoGrpc.UNAUTHENTICATED,
  403: EstadoGrpc.PERMISSION_DENIED,
  404: EstadoGrpc.NOT_FOUND,
  // Bien formada, pero el estado de las cosas no la permite: conflicto, vencido, no procesable
  409: EstadoGrpc.FAILED_PRECONDITION,
  410: EstadoGrpc.FAILED_PRECONDITION,
  422: EstadoGrpc.FAILED_PRECONDITION,
  413: EstadoGrpc.RESOURCE_EXHAUSTED,
  429: EstadoGrpc.RESOURCE_EXHAUSTED,
  // La base no responde (traducirErrorBd): reintentable, como el 503 de REST
  503: EstadoGrpc.UNAVAILABLE,
};

/** El código gRPC de un status HTTP; otro 4xx es INVALID_ARGUMENT y otro 5xx, INTERNAL. */
export function codigoGrpc(status: number): EstadoGrpc {
  return POR_STATUS[status] ?? (status >= 500 ? EstadoGrpc.INTERNAL : EstadoGrpc.INVALID_ARGUMENT);
}
