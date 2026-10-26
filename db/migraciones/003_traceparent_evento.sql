-- =============================================================================
--  003 · traceparent en la bandeja de salida hacia el notifier (fase 7c)
-- -----------------------------------------------------------------------------
--  Para una base que ya existe. Una base nueva ya lo trae de esquema_vuelos.sql.
--  Idempotente: correrla dos veces deja la base igual. Solo agrega una columna
--  que admite nulos (los eventos viejos no tienen traza) y su comprobación.
-- =============================================================================

BEGIN;

SET search_path TO vuelos;

ALTER TABLE evento_saliente ADD COLUMN IF NOT EXISTS traceparent text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_evento_saliente_traceparent'
                      AND conrelid = 'vuelos.evento_saliente'::regclass) THEN
        ALTER TABLE evento_saliente
            ADD CONSTRAINT ck_evento_saliente_traceparent
            CHECK (traceparent IS NULL OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
    END IF;
END
$$;

COMMENT ON COLUMN evento_saliente.traceparent IS 'traceparent (W3C Trace Context) del contexto activo cuando ocurrió el hecho: el relevo abre su span hacia el notifier como continuación de esa traza. NULL en los eventos anteriores a la fase 7c. Nunca se manda a un tercero.';

COMMIT;
