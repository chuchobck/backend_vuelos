import { CodigoError } from './codigo-error';
import { ErrorNegocio } from './error-negocio';

/**
 * Traduce los errores de Prisma 7 (adaptador de pg) y los de PostgreSQL, incluidos los que
 * levantan los triggers de db/esquema_vuelos.sql, al status y al `code` del contrato.
 *
 * Qué se vio al probarlo contra PostgreSQL 18 (ver docs/PLAN.md, Hallazgos de la fase 2):
 * - La información útil no está en el `code` de Prisma sino en
 *   `meta.driverAdapterError.cause`: `originalCode` (SQLSTATE), `kind` y, a veces,
 *   `constraint.index`. Una consulta con modelo y una `$queryRaw` fallan con códigos
 *   distintos (P2003 contra P2010) para el mismo SQLSTATE, así que se decide por el SQLSTATE.
 * - Un `RAISE EXCEPTION ... USING CONSTRAINT` de un trigger llega sin el nombre de la
 *   restricción: solo trae SQLSTATE y el texto del mensaje. Por eso los triggers se
 *   reconocen por su mensaje (POR_MENSAJE_TRIGGER) y una prueba e2e los dispara de verdad.
 * - Un `ON DELETE RESTRICT` es SQLSTATE 23001 (no 23503); Prisma lo marca como
 *   `kind: RestrictViolation` y, en una consulta con modelo, lo devuelve como P2003.
 *
 * Los textos de `detail` van al cliente: en inglés y sin nombres de tablas ni de columnas.
 */

interface ErrorBd {
  prismaCode?: string;
  /** SQLSTATE de PostgreSQL (`originalCode`). */
  sqlstate?: string;
  /** `kind` que asigna el adaptador (UniqueConstraintViolation, RestrictViolation...). */
  tipo?: string;
  restriccion?: string;
  mensaje?: string;
}

interface Regla {
  status: number;
  code: CodigoError;
  detalle: string;
}

const regla = (status: number, code: CodigoError, detalle: string): Regla => ({
  status,
  code,
  detalle,
});

/** Restricciones con nombre propio (UNIQUE, índices únicos parciales y CHECK) del esquema. */
const POR_RESTRICCION: Record<string, Regla> = {
  uq_reserva_detalle_asiento_ocupado: regla(
    409,
    CodigoError.SEAT_TAKEN,
    'The seat is already taken on this flight',
  ),
  uq_reserva_detalle_asiento_pasajero_vuelo: regla(
    409,
    CodigoError.VALIDATION_FAILED,
    'The passenger already has a seat on this flight',
  ),
  uq_reserva_detalle_pasajero_infante_por_adulto: regla(
    422,
    CodigoError.VALIDATION_FAILED,
    'An adult can be responsible for only one infant',
  ),
  uq_reserva_detalle_pago_emision: regla(
    409,
    CodigoError.VALIDATION_FAILED,
    'The booking already has an issuance payment',
  ),
  uq_reserva_detalle_pago_referencia: regla(
    409,
    CodigoError.PAYMENT_REFERENCE_INVALID,
    'The payment reference was already used',
  ),
  uq_boleto_cabecera_activo_por_pasajero: regla(
    409,
    CodigoError.TICKET_ALREADY_ISSUED,
    'The passenger already has an active ticket',
  ),
  uq_boleto_cabecera_numero: regla(
    409,
    CodigoError.TICKET_ISSUANCE_FAILED,
    'The ticket number could not be assigned; retry',
  ),
  uq_cotizacion_cancelacion_aceptada: regla(
    409,
    CodigoError.ALREADY_CANCELLED,
    'A cancellation quote was already accepted for this booking',
  ),
  uq_checkin_registrado: regla(
    409,
    CodigoError.CHECK_IN_NOT_AVAILABLE,
    'The passenger is already checked in for this flight',
  ),
  uq_reserva_cabecera_retencion: regla(
    409,
    CodigoError.OFFER_NO_LONGER_AVAILABLE,
    'The hold was already converted into a booking',
  ),
  uq_reserva_cabecera_pnr: regla(
    409,
    CodigoError.PNR_CREATION_FAILED,
    'The PNR could not be generated; retry',
  ),
  uq_webhook_cabecera_propietario_url: regla(
    409,
    CodigoError.VALIDATION_FAILED,
    'A webhook with this URL already exists',
  ),
  uq_usuario_correo: regla(
    409,
    CodigoError.VALIDATION_FAILED,
    'An account with this email already exists',
  ),
  uq_clave_idempotencia: regla(
    409,
    CodigoError.VALIDATION_FAILED,
    'The Idempotency-Key was already used for another request',
  ),
  ck_inventario_cabina_cupos_disponibles: regla(
    409,
    CodigoError.OFFER_NO_LONGER_AVAILABLE,
    'There are not enough seats left in the cabin',
  ),
  ck_reserva_detalle_equipaje_cantidad: regla(
    422,
    CodigoError.BAGGAGE_LIMIT_EXCEEDED,
    'The baggage quantity must be between 1 and 10',
  ),
  ck_retencion_cabecera_infantes: regla(
    422,
    CodigoError.VALIDATION_FAILED,
    'Infants cannot outnumber adults',
  ),
  ck_retencion_cabecera_maximo: regla(
    422,
    CodigoError.VALIDATION_FAILED,
    'At most 9 passengers that occupy a seat are allowed',
  ),
  ck_reserva_detalle_pasajero_infante: regla(
    422,
    CodigoError.VALIDATION_FAILED,
    'An infant needs a responsible adult',
  ),
};

/** Triggers de la sección 15 del esquema: SQLSTATE 23514 y solo el mensaje como pista. */
const POR_MENSAJE_TRIGGER: Array<{ patron: RegExp; regla: Regla }> = [
  {
    patron: /^Un infante no ocupa asiento/,
    regla: regla(422, CodigoError.INFANT_SEAT_NOT_ALLOWED, 'An infant cannot be assigned a seat'),
  },
  {
    patron: /no pertenece al mapa de asientos/,
    regla: regla(
      422,
      CodigoError.VALIDATION_FAILED,
      'The seat does not belong to the seat map of this flight',
    ),
  },
  {
    patron: /no es un adulto de la reserva/,
    regla: regla(
      422,
      CodigoError.VALIDATION_FAILED,
      'The responsible adult must be an adult passenger of the same booking',
    ),
  },
  {
    patron: /deben pertenecer a la misma reserva/,
    regla: regla(
      422,
      CodigoError.VALIDATION_FAILED,
      'The passenger, itinerary and payment of the baggage must belong to the same booking',
    ),
  },
];

const KINDS_BASE_NO_DISPONIBLE = new Set([
  'DatabaseNotReachable',
  'DatabaseDoesNotExist',
  'DatabaseAccessDenied',
  'ConnectionClosed',
  'TooManyConnections',
  'SocketTimeout',
  'TlsConnectionError',
]);
const CODIGOS_PRISMA_BASE_NO_DISPONIBLE = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

/**
 * Devuelve el ErrorNegocio que corresponde a un error de base de datos, o `undefined` si el
 * error no es de la base o no está previsto (en ese caso el filtro responde 500).
 */
export function traducirErrorBd(error: unknown): ErrorNegocio | undefined {
  const bd = extraerErrorBd(error);
  if (bd === undefined) return undefined;

  const traducido = clasificar(bd);
  if (traducido === undefined) return undefined;

  const { status, code, detalle } = traducido.regla;
  return new ErrorNegocio(status, code, detalle, {
    cabeceras: traducido.cabeceras,
    causa: error,
  });
}

function clasificar(bd: ErrorBd): { regla: Regla; cabeceras?: Record<string, string> } | undefined {
  const { sqlstate, prismaCode, tipo } = bd;

  // Base caída o saturada: el cliente puede reintentar.
  if (
    (tipo !== undefined && KINDS_BASE_NO_DISPONIBLE.has(tipo)) ||
    (prismaCode !== undefined && CODIGOS_PRISMA_BASE_NO_DISPONIBLE.has(prismaCode)) ||
    (sqlstate !== undefined && /^(08|53300|57P0[123])/.test(sqlstate))
  ) {
    return {
      regla: regla(503, CodigoError.VALIDATION_FAILED, 'The database is temporarily unavailable'),
      cabeceras: { 'Retry-After': '5' },
    };
  }

  // Choque con otra transacción (escritura concurrente o deadlock): reintentar sirve.
  if (
    sqlstate === '40001' ||
    sqlstate === '40P01' ||
    prismaCode === 'P2034' ||
    tipo === 'TransactionWriteConflict' ||
    tipo === 'Deadlock'
  ) {
    return {
      regla: regla(
        409,
        CodigoError.VALIDATION_FAILED,
        'The operation conflicted with a concurrent change; retry',
      ),
      cabeceras: { 'Retry-After': '1' },
    };
  }

  if (sqlstate === '23505' || prismaCode === 'P2002') {
    return {
      regla:
        reglaPorRestriccion(bd) ??
        regla(
          409,
          CodigoError.VALIDATION_FAILED,
          'A record with the same unique value already exists',
        ),
    };
  }

  // 23001 es el ON DELETE RESTRICT; 23503 es la FK que no encuentra la fila padre.
  if (sqlstate === '23001' || sqlstate === '23503' || prismaCode === 'P2003') {
    const sigueReferenciado =
      sqlstate === '23001' ||
      tipo === 'RestrictViolation' ||
      /^update or delete on table/.test(bd.mensaje ?? '');
    return {
      regla: sigueReferenciado
        ? regla(
            409,
            CodigoError.VALIDATION_FAILED,
            'The record is referenced by other records and cannot be removed',
          )
        : regla(422, CodigoError.VALIDATION_FAILED, 'A referenced record does not exist'),
    };
  }

  if (sqlstate === '23514') {
    return { regla: reglaPorRestriccion(bd) ?? reglaPorTrigger(bd) ?? reglaCheckGenerica() };
  }

  if (sqlstate === '23502' || prismaCode === 'P2011') {
    return { regla: regla(400, CodigoError.VALIDATION_FAILED, 'A required value is missing') };
  }

  if (sqlstate === '22001' || prismaCode === 'P2000') {
    return { regla: regla(400, CodigoError.VALIDATION_FAILED, 'A value is too long') };
  }
  if (sqlstate === '22003' || prismaCode === 'P2020') {
    return { regla: regla(400, CodigoError.VALIDATION_FAILED, 'A value is out of range') };
  }
  if ((sqlstate !== undefined && sqlstate.startsWith('22')) || prismaCode === 'P2023') {
    return { regla: regla(400, CodigoError.VALIDATION_FAILED, 'A value has an invalid format') };
  }

  if (prismaCode === 'P2025') {
    return { regla: regla(404, CodigoError.VALIDATION_FAILED, 'The record was not found') };
  }

  return undefined;
}

function reglaPorRestriccion(bd: ErrorBd): Regla | undefined {
  return bd.restriccion === undefined ? undefined : POR_RESTRICCION[bd.restriccion];
}

function reglaPorTrigger(bd: ErrorBd): Regla | undefined {
  return POR_MENSAJE_TRIGGER.find(({ patron }) => patron.test(bd.mensaje ?? ''))?.regla;
}

function reglaCheckGenerica(): Regla {
  return regla(422, CodigoError.VALIDATION_FAILED, 'The data violates a business rule');
}

/** Lee lo que el adaptador de pg deja en el error de Prisma. */
function extraerErrorBd(error: unknown): ErrorBd | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { name?: unknown; code?: unknown; meta?: unknown; errorCode?: unknown };

  // Un fallo al conectar antes de la primera consulta.
  if (e.name === 'PrismaClientInitializationError') {
    return { prismaCode: typeof e.errorCode === 'string' ? e.errorCode : 'P1001' };
  }
  if (e.name !== 'PrismaClientKnownRequestError') return undefined;

  const causa = (e.meta as { driverAdapterError?: { cause?: Record<string, unknown> } } | undefined)
    ?.driverAdapterError?.cause;
  const mensaje = texto(causa?.originalMessage) ?? texto(causa?.message);
  const restriccionAdaptador = (causa?.constraint as { index?: unknown } | undefined)?.index;

  return {
    prismaCode: typeof e.code === 'string' ? e.code : undefined,
    sqlstate: texto(causa?.originalCode) ?? texto(causa?.code),
    tipo: texto(causa?.kind),
    restriccion: texto(restriccionAdaptador) ?? restriccionDelMensaje(mensaje),
    mensaje,
  };
}

/** `... violates check constraint "ck_x"` → `ck_x`. */
function restriccionDelMensaje(mensaje: string | undefined): string | undefined {
  return mensaje?.match(/constraint "([^"]+)"/)?.[1];
}

function texto(valor: unknown): string | undefined {
  return typeof valor === 'string' ? valor : undefined;
}
