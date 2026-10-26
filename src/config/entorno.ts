import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidateIf,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';
import { esOrigenEmisor, esUrlJwks, MODOS_AUTH, ModoAuth } from './autenticacion';
import { esUrlServicio, MODOS_WEBHOOKS, ModoWebhooks } from './eventos';
import { esOrigenValido, listarOrigenes } from './origenes-cors';
import { parsearTrustProxy } from './proxy';

export const ENTORNOS = ['development', 'production', 'test'] as const;
export const LARGO_MINIMO_JWT_SECRET = 32;
export const LARGO_MINIMO_WEBHOOK_KEY = 32;
export type Entorno = (typeof ENTORNOS)[number];

@ValidatorConstraint({ name: 'listaDeOrigenes' })
class ListaDeOrigenes implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    return typeof valor === 'string' && listarOrigenes(valor).every(esOrigenValido);
  }

  defaultMessage({ value }: ValidationArguments): string {
    const invalidos = listarOrigenes(String(value)).filter((origen) => !esOrigenValido(origen));
    return (
      'CORS_ORIGINS debe ser una lista de orígenes separados por coma, como ' +
      `https://app.example.com (sin ruta, sin barra final y sin "*"); inválidos: ${invalidos.join(', ')}`
    );
  }
}

/** Con AUTH_MODE=external, JWT_ISSUER es un origen sin ruta (https en producción). */
@ValidatorConstraint({ name: 'emisorExterno' })
class EmisorExterno implements ValidatorConstraintInterface {
  validate(valor: unknown, { object }: ValidationArguments): boolean {
    const variables = object as VariablesEntorno;
    if (variables.AUTH_MODE !== 'external') return true;
    return esOrigenEmisor(valor, variables.NODE_ENV === 'production');
  }

  defaultMessage(): string {
    return (
      'JWT_ISSUER debe ser, con AUTH_MODE=external, el origen del servicio de identidad sin ruta ' +
      'ni barra final, como https://identity.quinde.example (https con NODE_ENV=production)'
    );
  }
}

@ValidatorConstraint({ name: 'urlJwks' })
class UrlJwks implements ValidatorConstraintInterface {
  validate(valor: unknown, { object }: ValidationArguments): boolean {
    return esUrlJwks(valor, (object as VariablesEntorno).NODE_ENV === 'production');
  }

  defaultMessage(): string {
    return 'JWKS_URL debe ser una URL https (http solo fuera de producción) sin usuario, clave ni fragmento';
  }
}

/** NOTIFIER_URL e IDENTITY_TOKEN_URL: http(s) sin credenciales ni query; https en producción. */
@ValidatorConstraint({ name: 'urlServicio' })
class UrlServicio implements ValidatorConstraintInterface {
  validate(valor: unknown, { object }: ValidationArguments): boolean {
    return esUrlServicio(valor, (object as VariablesEntorno).NODE_ENV === 'production');
  }

  defaultMessage({ property }: ValidationArguments): string {
    return (
      `${property} debe ser una URL https (http solo fuera de producción) sin usuario, clave, ` +
      'query ni fragmento'
    );
  }
}

/** Solo con WEBHOOKS_MODE=notifier se validan (y se exigen) las variables del relevo. */
const conNotifier = (v: VariablesEntorno) => v.WEBHOOKS_MODE === 'notifier';

@ValidatorConstraint({ name: 'trustProxyValido' })
class TrustProxyValido implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    return typeof valor === 'string' && parsearTrustProxy(valor) !== undefined;
  }

  defaultMessage(): string {
    return (
      'TRUST_PROXY debe ser false, un número de proxies (1, 2...) o una lista separada por coma ' +
      'de IP, CIDR, loopback, linklocal o uniquelocal; "true" no se acepta porque deja falsear la IP'
    );
  }
}

/**
 * Variables de entorno que la API necesita para arrancar. Las obligatorias no tienen valor
 * por defecto: si falta una o tiene un formato inválido, la API no levanta. Las opcionales
 * (`@IsOptional`) llevan su valor por defecto documentado en `.env.example`.
 */
export class VariablesEntorno {
  // class-validator evalúa de abajo hacia arriba: lo obligatorio va pegado a la propiedad.
  @Matches(/^postgres(ql)?:\/\/\S+$/, {
    message: 'DATABASE_URL debe ser una URL de PostgreSQL (postgresql://...)',
  })
  @IsString({ message: 'DATABASE_URL es obligatoria' })
  DATABASE_URL: string;

  @Min(1, { message: 'PORT debe estar entre 1 y 65535' })
  @Max(65535, { message: 'PORT debe estar entre 1 y 65535' })
  @IsInt({ message: 'PORT es obligatorio y debe ser un número entero' })
  PORT: number;

  @IsIn(ENTORNOS, { message: `NODE_ENV es obligatorio y debe ser uno de: ${ENTORNOS.join(', ')}` })
  NODE_ENV: Entorno;

  /**
   * Clave HS256 de los tokens de acceso con AUTH_MODE=local (obligatoria ahí). Con menos de 32
   * caracteres (256 bits si es aleatoria) la firma se podría adivinar por fuerza bruta. Con
   * AUTH_MODE=external no firma ni verifica nada de los tokens: solo hace falta si de ella sale
   * la firma de los pases (BOARDING_PASS_SECRET sin valor). Generar con:
   *   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   */
  @MinLength(LARGO_MINIMO_JWT_SECRET, {
    message: `JWT_SECRET debe tener al menos ${LARGO_MINIMO_JWT_SECRET} caracteres`,
  })
  @IsString({ message: 'JWT_SECRET es obligatoria con AUTH_MODE=local' })
  @ValidateIf((v: VariablesEntorno) => v.AUTH_MODE !== 'external' || v.JWT_SECRET !== undefined)
  JWT_SECRET?: string;

  /**
   * Clave de la que se deriva la firma HMAC de los códigos de barras de los pases de abordar
   * (CodigoPase). Sin valor: JWT_SECRET, de donde salía antes; con el mismo valor, los pases ya
   * emitidos siguen verificando. Con otro, los pases ya emitidos dejan de verificar.
   */
  @MinLength(LARGO_MINIMO_JWT_SECRET, {
    message: `BOARDING_PASS_SECRET debe tener al menos ${LARGO_MINIMO_JWT_SECRET} caracteres`,
  })
  @IsString({
    message:
      'BOARDING_PASS_SECRET es obligatoria con AUTH_MODE=external si no hay JWT_SECRET: de ella ' +
      'sale la firma de los pases de abordar',
  })
  // Vacía cuenta como no definida (BOARDING_PASS_SECRET= en un .env): se usa JWT_SECRET. Con
  // AUTH_MODE=external y sin JWT_SECRET, alguna de las dos tiene que estar.
  @ValidateIf(
    (v: VariablesEntorno) =>
      (v.BOARDING_PASS_SECRET ?? '') !== '' ||
      (v.AUTH_MODE === 'external' && v.JWT_SECRET === undefined),
  )
  BOARDING_PASS_SECRET?: string;

  /**
   * Clave con la que se cifra el secreto de cada webhook (AES-256-GCM, derivada con HKDF). Hace
   * falta porque el secreto se necesita en claro para firmar las entregas. Obligatoria, de al
   * menos 32 caracteres: sin ella la API no arranca. Cambiarla deja ilegibles los secretos ya
   * guardados (los webhooks hay que volver a registrarlos). Generar con:
   *   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   */
  @MinLength(LARGO_MINIMO_WEBHOOK_KEY, {
    message: `WEBHOOK_SECRET_KEY debe tener al menos ${LARGO_MINIMO_WEBHOOK_KEY} caracteres`,
  })
  @IsString({ message: 'WEBHOOK_SECRET_KEY es obligatoria' })
  WEBHOOK_SECRET_KEY: string;

  /**
   * Quién emite los tokens que la API acepta (src/config/autenticacion.ts). Sin valor: local, la
   * propia API con /auth y HS256, como siempre. external: el servicio de identidad, por su JWKS.
   */
  @IsIn(MODOS_AUTH, { message: `AUTH_MODE debe ser uno de: ${MODOS_AUTH.join(', ')}` })
  @IsOptional()
  AUTH_MODE?: ModoAuth;

  /**
   * `iss` de los tokens. Con AUTH_MODE=local, el que emite y acepta la API; sin valor:
   * quinde-vuelos-api. Con AUTH_MODE=external es obligatoria: el JWT_ISSUER del servicio de
   * identidad, un origen sin ruta (https en producción), que se compara texto a texto.
   */
  @Validate(EmisorExterno)
  @Matches(/^\S+$/, { message: 'JWT_ISSUER no puede tener espacios' })
  @MaxLength(200, { message: 'JWT_ISSUER admite hasta 200 caracteres' })
  @IsString({ message: 'JWT_ISSUER es obligatoria con AUTH_MODE=external' })
  @ValidateIf((v: VariablesEntorno) => v.JWT_ISSUER !== undefined || v.AUTH_MODE === 'external')
  JWT_ISSUER?: string;

  /**
   * `aud` de los tokens. Con AUTH_MODE=local, el que emite y acepta la API; sin valor:
   * quinde-vuelos-api. Con AUTH_MODE=external es obligatoria (quinde-vuelos-api, el `aud` que
   * emite el servicio de identidad para el core).
   */
  @Matches(/^\S+$/, { message: 'JWT_AUDIENCE no puede tener espacios' })
  @MaxLength(200, { message: 'JWT_AUDIENCE admite hasta 200 caracteres' })
  @IsString({ message: 'JWT_AUDIENCE es obligatoria con AUTH_MODE=external' })
  @ValidateIf((v: VariablesEntorno) => v.JWT_AUDIENCE !== undefined || v.AUTH_MODE === 'external')
  JWT_AUDIENCE?: string;

  /**
   * De dónde se bajan las claves públicas con AUTH_MODE=external. Sin valor:
   * {JWT_ISSUER}/.well-known/jwks.json. Sirve si el JWKS se lee por otra ruta (una red interna).
   */
  @Validate(UrlJwks)
  @IsOptional()
  JWKS_URL?: string;

  /**
   * Quién reparte los webhooks (src/config/eventos.ts). Sin valor: local, el core, como siempre.
   * notifier: el core publica cada evento al servicio notifier y no monta /webhooks.
   */
  @IsIn(MODOS_WEBHOOKS, { message: `WEBHOOKS_MODE debe ser uno de: ${MODOS_WEBHOOKS.join(', ')}` })
  @IsOptional()
  WEBHOOKS_MODE?: ModoWebhooks;

  /** Base del notifier (POST {NOTIFIER_URL}/internal/v1/events). Obligatoria con WEBHOOKS_MODE=notifier. */
  @Validate(UrlServicio)
  @IsString({ message: 'NOTIFIER_URL es obligatoria con WEBHOOKS_MODE=notifier' })
  @ValidateIf(conNotifier)
  NOTIFIER_URL?: string;

  /** /oauth2/token del servicio de identidad. Obligatoria con WEBHOOKS_MODE=notifier. */
  @Validate(UrlServicio)
  @IsString({ message: 'IDENTITY_TOKEN_URL es obligatoria con WEBHOOKS_MODE=notifier' })
  @ValidateIf(conNotifier)
  IDENTITY_TOKEN_URL?: string;

  /** client_id del cliente core-vuelos (con events:publish). Obligatoria con WEBHOOKS_MODE=notifier. */
  @Matches(/^[a-z0-9][a-z0-9._-]{2,63}$/, {
    message: 'NOTIFIER_CLIENT_ID debe ser un client_id de identity (minúsculas, números, . _ -)',
  })
  @IsString({ message: 'NOTIFIER_CLIENT_ID es obligatoria con WEBHOOKS_MODE=notifier' })
  @ValidateIf(conNotifier)
  NOTIFIER_CLIENT_ID?: string;

  /** Su client_secret. Obligatoria con WEBHOOKS_MODE=notifier; nunca va al log. */
  @MinLength(16, { message: 'NOTIFIER_CLIENT_SECRET debe tener al menos 16 caracteres' })
  @IsString({ message: 'NOTIFIER_CLIENT_SECRET es obligatoria con WEBHOOKS_MODE=notifier' })
  @ValidateIf(conNotifier)
  NOTIFIER_CLIENT_SECRET?: string;

  /** Relevo de la bandeja de eventos al notifier (solo WEBHOOKS_MODE=notifier). Sin valor: true. */
  @IsIn(['true', 'false'], { message: 'EVENT_RELAY_JOB_ENABLED debe ser true o false' })
  @IsOptional()
  @ValidateIf(conNotifier)
  EVENT_RELAY_JOB_ENABLED?: string;

  /** Cada cuántos segundos corre el relevo. Sin valor: 5. */
  @Max(3600, { message: 'EVENT_RELAY_JOB_INTERVAL_SECONDS debe estar entre 1 y 3600' })
  @Min(1, { message: 'EVENT_RELAY_JOB_INTERVAL_SECONDS debe estar entre 1 y 3600' })
  @IsInt({ message: 'EVENT_RELAY_JOB_INTERVAL_SECONDS debe ser un número entero' })
  @IsOptional()
  @ValidateIf(conNotifier)
  EVENT_RELAY_JOB_INTERVAL_SECONDS?: number;

  /**
   * Si el sobre de cada evento lleva además `correlationId` (el X-Correlation-Id del hecho). Sin
   * valor: false, porque los esquemas 1.0 del notifier no lo admiten (additionalProperties:
   * false); se enciende cuando el notifier lo acepte. La columna y la cabecera van siempre.
   */
  @IsIn(['true', 'false'], { message: 'EVENT_ENVELOPE_CORRELATION_ID debe ser true o false' })
  @IsOptional()
  EVENT_ENVELOPE_CORRELATION_ID?: string;

  /** Orígenes que pueden llamar desde un navegador. Sin valor: ninguno. */
  @Validate(ListaDeOrigenes)
  @IsOptional()
  CORS_ORIGINS?: string;

  /** Proxies delante de la API (Render: 1). Sin valor: ninguno. Ver src/config/proxy.ts. */
  @Validate(TrustProxyValido)
  @IsOptional()
  TRUST_PROXY?: string;

  /** Peticiones por IP y por ventana en toda la API. Sin valor: 100. */
  @Max(100_000, { message: 'RATE_LIMIT_MAX debe estar entre 1 y 100000' })
  @Min(1, { message: 'RATE_LIMIT_MAX debe estar entre 1 y 100000' })
  @IsInt({ message: 'RATE_LIMIT_MAX debe ser un número entero' })
  @IsOptional()
  RATE_LIMIT_MAX?: number;

  /**
   * Minutos que vale una oferta de POST /search (oferta_cabecera.fecha_expiracion). Sin valor:
   * 30. Debe alcanzar para elegir y retener; pasado ese plazo el seatmap da 404 y el hold 409.
   */
  @Max(240, { message: 'SEARCH_OFFER_TTL_MINUTES debe estar entre 5 y 240' })
  @Min(5, { message: 'SEARCH_OFFER_TTL_MINUTES debe estar entre 5 y 240' })
  @IsInt({ message: 'SEARCH_OFFER_TTL_MINUTES debe ser un número entero' })
  @IsOptional()
  SEARCH_OFFER_TTL_MINUTES?: number;

  /**
   * Minutos que un hold (POST /offers/hold) retiene el cupo antes de vencer. Sin valor: 15.
   * De 1 a 60: debe alcanzar para pagar y reservar, sin dejar cupo inmovilizado por horas.
   */
  @Max(60, { message: 'HOLD_TTL_MINUTES debe estar entre 1 y 60' })
  @Min(1, { message: 'HOLD_TTL_MINUTES debe estar entre 1 y 60' })
  @IsInt({ message: 'HOLD_TTL_MINUTES debe ser un número entero' })
  @IsOptional()
  HOLD_TTL_MINUTES?: number;

  /**
   * Minutos que vale una cotización de cancelación (GET .../cancellation-quote). Sin valor: 15.
   * De 1 a 60: lo que tarda una persona en decidir, sin que el precio quede viejo.
   */
  @Max(60, { message: 'CANCELLATION_QUOTE_TTL_MINUTES debe estar entre 1 y 60' })
  @Min(1, { message: 'CANCELLATION_QUOTE_TTL_MINUTES debe estar entre 1 y 60' })
  @IsInt({ message: 'CANCELLATION_QUOTE_TTL_MINUTES debe ser un número entero' })
  @IsOptional()
  CANCELLATION_QUOTE_TTL_MINUTES?: number;

  /**
   * Minutos que vale una oferta de cambio de fecha (POST .../date-change/search). Sin valor: 15.
   * De 1 a 60: no toma cupo, así que el precio y el cupo se vuelven a comprobar al confirmar.
   */
  @Max(60, { message: 'CHANGE_OFFER_TTL_MINUTES debe estar entre 1 y 60' })
  @Min(1, { message: 'CHANGE_OFFER_TTL_MINUTES debe estar entre 1 y 60' })
  @IsInt({ message: 'CHANGE_OFFER_TTL_MINUTES debe ser un número entero' })
  @IsOptional()
  CHANGE_OFFER_TTL_MINUTES?: number;

  /**
   * Proceso periódico que vence los holds y borra las claves de idempotencia vencidas. Sin
   * valor: true. Con false solo quedan los vencimientos perezosos (las pruebas lo apagan).
   */
  @IsIn(['true', 'false'], { message: 'HOLD_EXPIRY_JOB_ENABLED debe ser true o false' })
  @IsOptional()
  HOLD_EXPIRY_JOB_ENABLED?: string;

  /** Cada cuántos segundos corre ese proceso. Sin valor: 60. */
  @Max(3600, { message: 'HOLD_EXPIRY_JOB_INTERVAL_SECONDS debe estar entre 5 y 3600' })
  @Min(5, { message: 'HOLD_EXPIRY_JOB_INTERVAL_SECONDS debe estar entre 5 y 3600' })
  @IsInt({ message: 'HOLD_EXPIRY_JOB_INTERVAL_SECONDS debe ser un número entero' })
  @IsOptional()
  HOLD_EXPIRY_JOB_INTERVAL_SECONDS?: number;

  /**
   * Proceso periódico que emite los boletos de las reservas con pago pendiente (las del 202)
   * cuando el pago se aprueba. Sin valor: true. Con false, esas reservas no avanzan solas.
   */
  @IsIn(['true', 'false'], { message: 'BOOKING_ISSUE_JOB_ENABLED debe ser true o false' })
  @IsOptional()
  BOOKING_ISSUE_JOB_ENABLED?: string;

  /** Cada cuántos segundos corre ese proceso. Sin valor: 30. */
  @Max(3600, { message: 'BOOKING_ISSUE_JOB_INTERVAL_SECONDS debe estar entre 5 y 3600' })
  @Min(5, { message: 'BOOKING_ISSUE_JOB_INTERVAL_SECONDS debe estar entre 5 y 3600' })
  @IsInt({ message: 'BOOKING_ISSUE_JOB_INTERVAL_SECONDS debe ser un número entero' })
  @IsOptional()
  BOOKING_ISSUE_JOB_INTERVAL_SECONDS?: number;

  /**
   * Proceso periódico que completa la postventa en 202 (maletas, cambios de fecha y
   * cancelaciones con el pago o el reembolso pendientes) y purga las ofertas de cambio y las
   * cotizaciones vencidas. Sin valor: true.
   */
  @IsIn(['true', 'false'], { message: 'POSTSALE_JOB_ENABLED debe ser true o false' })
  @IsOptional()
  POSTSALE_JOB_ENABLED?: string;

  /** Cada cuántos segundos corre ese proceso. Sin valor: 30. */
  @Max(3600, { message: 'POSTSALE_JOB_INTERVAL_SECONDS debe estar entre 5 y 3600' })
  @Min(5, { message: 'POSTSALE_JOB_INTERVAL_SECONDS debe estar entre 5 y 3600' })
  @IsInt({ message: 'POSTSALE_JOB_INTERVAL_SECONDS debe ser un número entero' })
  @IsOptional()
  POSTSALE_JOB_INTERVAL_SECONDS?: number;

  /**
   * Proceso periódico que envía los webhooks pendientes (POST firmado a la URL de cada
   * suscripción) y reintenta los fallidos. Sin valor: true. Con false, los eventos se acumulan en
   * la bandeja sin enviarse (las pruebas lo apagan).
   */
  @IsIn(['true', 'false'], { message: 'WEBHOOK_DELIVERY_JOB_ENABLED debe ser true o false' })
  @IsOptional()
  WEBHOOK_DELIVERY_JOB_ENABLED?: string;

  /** Cada cuántos segundos corre ese proceso. Sin valor: 10. */
  @Max(3600, { message: 'WEBHOOK_DELIVERY_JOB_INTERVAL_SECONDS debe estar entre 5 y 3600' })
  @Min(5, { message: 'WEBHOOK_DELIVERY_JOB_INTERVAL_SECONDS debe estar entre 5 y 3600' })
  @IsInt({ message: 'WEBHOOK_DELIVERY_JOB_INTERVAL_SECONDS debe ser un número entero' })
  @IsOptional()
  WEBHOOK_DELIVERY_JOB_INTERVAL_SECONDS?: number;

  /**
   * Horas antes de la salida de cada vuelo en que abre su check-in. Sin valor: 48. De 2 a 168
   * (una semana): debe ser mayor que el cierre (como mucho 90 minutos).
   */
  @Max(168, { message: 'CHECKIN_OPENS_HOURS_BEFORE debe estar entre 2 y 168' })
  @Min(2, { message: 'CHECKIN_OPENS_HOURS_BEFORE debe estar entre 2 y 168' })
  @IsInt({ message: 'CHECKIN_OPENS_HOURS_BEFORE debe ser un número entero' })
  @IsOptional()
  CHECKIN_OPENS_HOURS_BEFORE?: number;

  /**
   * Minutos antes de la salida de cada vuelo en que cierra su check-in. Sin valor: 60. De 15 a
   * 90: el tiempo que el aeropuerto necesita para cerrar el vuelo.
   */
  @Max(90, { message: 'CHECKIN_CLOSES_MINUTES_BEFORE debe estar entre 15 y 90' })
  @Min(15, { message: 'CHECKIN_CLOSES_MINUTES_BEFORE debe estar entre 15 y 90' })
  @IsInt({ message: 'CHECKIN_CLOSES_MINUTES_BEFORE debe ser un número entero' })
  @IsOptional()
  CHECKIN_CLOSES_MINUTES_BEFORE?: number;

  /**
   * Servidor gRPC interno (contracts/proto/flights/v1/flights.proto), además de REST. Sin
   * valor: false. Con false el puerto no se abre y la API es la misma que sin gRPC.
   */
  @IsIn(['true', 'false'], { message: 'GRPC_ENABLED debe ser true o false' })
  @IsOptional()
  GRPC_ENABLED?: string;

  /** Puerto del servidor gRPC, en 0.0.0.0; distinto de PORT. Sin valor: 50051. */
  @Min(1, { message: 'GRPC_PORT debe estar entre 1 y 65535' })
  @Max(65535, { message: 'GRPC_PORT debe estar entre 1 y 65535' })
  @IsInt({ message: 'GRPC_PORT debe ser un número entero' })
  @IsOptional()
  GRPC_PORT?: number;

  /** Duración de la ventana del límite, en segundos. Sin valor: 60. */
  @Max(86_400, { message: 'RATE_LIMIT_WINDOW_SECONDS debe estar entre 1 y 86400' })
  @Min(1, { message: 'RATE_LIMIT_WINDOW_SECONDS debe estar entre 1 y 86400' })
  @IsInt({ message: 'RATE_LIMIT_WINDOW_SECONDS debe ser un número entero' })
  @IsOptional()
  RATE_LIMIT_WINDOW_SECONDS?: number;
}

/** Se pasa a ConfigModule.forRoot({ validate }); corre una sola vez, al arrancar. */
export function validarEntorno(config: Record<string, unknown>): VariablesEntorno {
  const variables = plainToInstance(VariablesEntorno, config, { enableImplicitConversion: true });
  const errores = validateSync(variables, { stopAtFirstError: true });

  if (errores.length > 0) {
    const detalle = errores
      .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`)
      .join('\n');
    throw new Error(`Variables de entorno inválidas o faltantes:\n${detalle}`);
  }
  return variables;
}
