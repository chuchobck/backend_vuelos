-- =============================================================================
--  001 · Bandeja de salida hacia el notifier (fase 5b, WEBHOOKS_MODE=notifier)
-- -----------------------------------------------------------------------------
--  Para una base que ya existe (la de Neon, por ejemplo). Una base nueva ya la
--  trae de esquema_vuelos.sql. Idempotente: correrla dos veces deja la base
--  igual. Solo agrega; no toca webhook_entrega ni ninguna otra tabla.
-- =============================================================================

BEGIN;

SET search_path TO vuelos;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                    WHERE t.typname = 'estado_evento_saliente' AND n.nspname = 'vuelos') THEN
        CREATE TYPE estado_evento_saliente AS ENUM ('PENDIENTE', 'PUBLICADO', 'FALLIDO');
    END IF;
END
$$;
COMMENT ON TYPE estado_evento_saliente IS 'Ciclo de un evento en la bandeja hacia el notifier (WEBHOOKS_MODE=notifier): PENDIENTE (por publicar o por reintentar), PUBLICADO (el notifier respondió 200 o 202) o FALLIDO (el notifier lo rechazó o pasaron 48 h sin poder publicarlo).';

CREATE TABLE IF NOT EXISTS evento_saliente (
    id_evento            uuid                    NOT NULL,
    tipo                 text                    NOT NULL,
    id_propietario       text                    NOT NULL,
    sobre                text                    NOT NULL,
    estado               estado_evento_saliente  NOT NULL DEFAULT 'PENDIENTE',
    intentos             smallint                NOT NULL DEFAULT 0,
    proximo_intento      timestamptz             NOT NULL,
    arrendamiento_hasta  timestamptz,
    reintentar_hasta     timestamptz             NOT NULL,
    ultimo_codigo_http   smallint,
    ultimo_error         text,
    creado_en            timestamptz             NOT NULL,
    publicado_en         timestamptz,
    CONSTRAINT pk_evento_saliente PRIMARY KEY (id_evento),
    CONSTRAINT ck_evento_saliente_tipo CHECK (tipo ~ '^(booking|hold|flight)\.[a-z_]+$'),
    CONSTRAINT ck_evento_saliente_propietario CHECK (btrim(id_propietario) <> ''),
    CONSTRAINT ck_evento_saliente_sobre CHECK (sobre IS JSON OBJECT),
    CONSTRAINT ck_evento_saliente_intentos CHECK (intentos >= 0),
    CONSTRAINT ck_evento_saliente_codigo_http CHECK (ultimo_codigo_http IS NULL OR ultimo_codigo_http BETWEEN 100 AND 599),
    CONSTRAINT ck_evento_saliente_error CHECK (ultimo_error IS NULL OR ultimo_error ~ '^[A-Z0-9_]{1,60}$'),
    CONSTRAINT ck_evento_saliente_publicado CHECK ((estado = 'PUBLICADO') = (publicado_en IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_evento_saliente_pendiente ON evento_saliente (estado, proximo_intento) WHERE estado = 'PENDIENTE';

COMMENT ON TABLE evento_saliente IS 'Bandeja de salida hacia el notifier (WEBHOOKS_MODE=notifier): un evento por hecho de negocio, guardado en la misma transacción del hecho y publicado por RelevoEventos. No se audita fila por fila ni se borra.';
COMMENT ON COLUMN evento_saliente.id_evento IS 'eventId del sobre: el mismo en cada reintento de publicación (el notifier es idempotente por él).';
COMMENT ON COLUMN evento_saliente.sobre IS 'Sobre de POST /internal/v1/events congelado al ocurrir el hecho; se envía tal cual, byte a byte.';
COMMENT ON COLUMN evento_saliente.arrendamiento_hasta IS 'Hasta cuándo el relevo que tomó la fila la tiene apartada; vencido, otro proceso puede retomarla.';
COMMENT ON COLUMN evento_saliente.reintentar_hasta IS 'Hasta cuándo se reintenta (48 h desde que se creó o se reencoló); después queda FALLIDO.';

COMMIT;
