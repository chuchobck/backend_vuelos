-- =============================================================================
--  007 · Embarque y puerta de salida (fase F1)
-- -----------------------------------------------------------------------------
--  Para una base que ya existe (la de Neon, por ejemplo). Una base nueva ya la
--  trae de esquema_vuelos.sql. Idempotente: correrla dos veces deja la base
--  igual. Solo agrega dos columnas que admiten NULL, sus restricciones y un
--  índice; no toca inventario_cabina ni ningún dato.
--
--  * checkin.fecha_abordaje: cuándo la puerta de embarque escaneó el pase del
--    pasajero en esa salida. NULL = no abordó.
--  * vuelo_programado.puerta_salida: la puerta que muestra la pantalla pública
--    de salidas. La pone el administrador (departureGate en /admin/departures).
-- =============================================================================

BEGIN;

SET search_path TO vuelos;

ALTER TABLE checkin ADD COLUMN IF NOT EXISTS fecha_abordaje timestamptz;
ALTER TABLE vuelo_programado ADD COLUMN IF NOT EXISTS puerta_salida text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_checkin_abordaje'
                      AND conrelid = 'vuelos.checkin'::regclass) THEN
        ALTER TABLE checkin ADD CONSTRAINT ck_checkin_abordaje
            CHECK (fecha_abordaje IS NULL OR estado = 'REGISTRADO');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_vuelo_programado_puerta_salida'
                      AND conrelid = 'vuelos.vuelo_programado'::regclass) THEN
        ALTER TABLE vuelo_programado ADD CONSTRAINT ck_vuelo_programado_puerta_salida CHECK (
            puerta_salida IS NULL OR (puerta_salida = btrim(puerta_salida) AND char_length(puerta_salida) BETWEEN 1 AND 10)
        );
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ix_checkin_abordado ON checkin (vuelo_programado_id) WHERE fecha_abordaje IS NOT NULL;

COMMENT ON COLUMN vuelo_programado.puerta_salida IS 'Puerta de embarque en el aeropuerto de origen (A3). NULL mientras no se asigne. La muestra la pantalla pública de salidas.';
COMMENT ON COLUMN checkin.fecha_abordaje IS 'Momento en que la puerta de embarque escaneó el pase del pasajero en esta salida (hora del Reloj de la API). NULL mientras no aborda. Se llena una sola vez, con un UPDATE condicionado a que siga NULL; un infante aborda con el pase de su adulto.';

COMMIT;
