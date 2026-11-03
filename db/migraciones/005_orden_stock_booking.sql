-- =============================================================================
--  005 · Cola del empuje de stock a Booking (fase S1, BOOKING_STOCK_ENABLED=true)
-- -----------------------------------------------------------------------------
--  Para una base que ya existe (la de Neon, por ejemplo). Una base nueva ya la
--  trae de esquema_vuelos.sql. Idempotente: correrla dos veces deja la base
--  igual. Solo agrega; no toca inventario_cabina ni ninguna otra tabla.
-- =============================================================================

BEGIN;

SET search_path TO vuelos;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                    WHERE t.typname = 'estado_orden_stock' AND n.nspname = 'vuelos') THEN
        CREATE TYPE estado_orden_stock AS ENUM ('PENDIENTE', 'ENVIADO', 'FALLIDO');
    END IF;
END
$$;
COMMENT ON TYPE estado_orden_stock IS 'Ciclo de una orden de empuje de stock a Booking: PENDIENTE (por mandar o por reintentar), ENVIADO (Booking respondió success) o FALLIDO (Booking la rechazó, o se agotaron los intentos). Un cambio de cupo posterior la vuelve PENDIENTE.';

CREATE TABLE IF NOT EXISTS orden_stock_booking (
    vuelo_programado_id  uuid                NOT NULL,
    clase_cabina         clase_cabina        NOT NULL,
    estado               estado_orden_stock  NOT NULL DEFAULT 'PENDIENTE',
    -- Sube con cada orden nueva de la misma clave: el trabajador solo da por ENVIADA la versión que mandó
    version              bigint              NOT NULL DEFAULT 1,
    intentos             smallint            NOT NULL DEFAULT 0,
    proximo_intento      timestamptz         NOT NULL,
    arrendamiento_hasta  timestamptz,
    ultimo_codigo_http   smallint,
    ultimo_error         text,
    correlation_id       text,
    solicitado_en        timestamptz         NOT NULL,
    enviado_en           timestamptz,
    unidades_enviadas    smallint,
    CONSTRAINT pk_orden_stock_booking PRIMARY KEY (vuelo_programado_id, clase_cabina),
    CONSTRAINT fk_orden_stock_booking_vuelo_programado FOREIGN KEY (vuelo_programado_id) REFERENCES vuelo_programado (id) ON DELETE CASCADE,
    CONSTRAINT ck_orden_stock_booking_version CHECK (version >= 1),
    CONSTRAINT ck_orden_stock_booking_intentos CHECK (intentos >= 0),
    CONSTRAINT ck_orden_stock_booking_codigo_http CHECK (ultimo_codigo_http IS NULL OR ultimo_codigo_http BETWEEN 100 AND 599),
    -- Solo un código corto (HTTP_503, TIMEOUT, SUCCESS_FALSE...): ni URL, ni cuerpo de Booking
    CONSTRAINT ck_orden_stock_booking_error CHECK (ultimo_error IS NULL OR ultimo_error ~ '^[A-Z0-9_]{1,60}$'),
    CONSTRAINT ck_orden_stock_booking_correlacion CHECK (correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
    CONSTRAINT ck_orden_stock_booking_enviado CHECK ((estado = 'ENVIADO') = (enviado_en IS NOT NULL)),
    CONSTRAINT ck_orden_stock_booking_unidades CHECK (unidades_enviadas IS NULL OR unidades_enviadas >= 0)
);

CREATE INDEX IF NOT EXISTS ix_orden_stock_booking_pendiente ON orden_stock_booking (proximo_intento) WHERE estado = 'PENDIENTE';

COMMENT ON TABLE orden_stock_booking IS 'Cola del empuje de stock a Booking (BOOKING_STOCK_ENABLED=true): UNA fila por (salida, cabina) con el cupo por mandar. La escribe, en la misma transacción del cambio, quien mueve inventario_cabina; StockBookingWorker lee el cupo ACTUAL y manda el valor absoluto. Órdenes repetidas de la misma clave se juntan (upsert). No se borra: queda acotada por inventario_cabina.';
COMMENT ON COLUMN orden_stock_booking.version IS 'Cuántas órdenes ha recibido la clave. El trabajador marca ENVIADA solo la versión que mandó: si llegó una nueva mientras tanto, sigue PENDIENTE.';
COMMENT ON COLUMN orden_stock_booking.arrendamiento_hasta IS 'Hasta cuándo el trabajador que tomó la fila la tiene apartada (una clave nunca se manda en paralelo); vencido, otro proceso puede retomarla.';
COMMENT ON COLUMN orden_stock_booking.unidades_enviadas IS 'available_units de la última vez que Booking respondió success (diagnóstico).';
COMMENT ON COLUMN orden_stock_booking.correlation_id IS 'X-Correlation-Id de la petición que produjo el último cambio; el trabajador lo manda a Booking. NULL si lo produjo un proceso periódico o la sincronización.';

COMMIT;
