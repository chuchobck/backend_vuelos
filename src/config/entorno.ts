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
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';
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
   * Clave HS256 de los tokens de acceso. Con menos de 32 caracteres (256 bits si es aleatoria)
   * la firma se podría adivinar por fuerza bruta. Generar con:
   *   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   */
  @MinLength(LARGO_MINIMO_JWT_SECRET, {
    message: `JWT_SECRET debe tener al menos ${LARGO_MINIMO_JWT_SECRET} caracteres`,
  })
  @IsString({ message: 'JWT_SECRET es obligatoria' })
  JWT_SECRET: string;

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

  /** `iss` de los tokens que emite y acepta la API. Sin valor: quinde-vuelos-api. */
  @Matches(/^\S+$/, { message: 'JWT_ISSUER no puede tener espacios' })
  @MaxLength(200, { message: 'JWT_ISSUER admite hasta 200 caracteres' })
  @IsOptional()
  JWT_ISSUER?: string;

  /** `aud` de los tokens que emite y acepta la API. Sin valor: quinde-vuelos-api. */
  @Matches(/^\S+$/, { message: 'JWT_AUDIENCE no puede tener espacios' })
  @MaxLength(200, { message: 'JWT_AUDIENCE admite hasta 200 caracteres' })
  @IsOptional()
  JWT_AUDIENCE?: string;

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
