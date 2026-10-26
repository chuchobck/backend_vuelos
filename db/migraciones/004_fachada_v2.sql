-- =============================================================================
--  004 · Fachada del contrato v2 (fase V1, /api/v2/vuelos)
-- -----------------------------------------------------------------------------
--  Para una base que ya existe (la de Neon, por ejemplo). Una base nueva ya la
--  trae de esquema_vuelos.sql. Idempotente: correrla dos veces deja la base
--  igual. Solo agrega columnas, un tipo, restricciones e índices; no toca datos.
--
--  * evento_saliente.correlation_id: el X-Correlation-Id del hecho.
--  * reserva_cabecera: el partner (client_id), el usuario final (X-User-Id) y el
--    salesChannel de una reserva hecha por Booking.
--  * reserva_detalle_pago.proveedor: quién cobró (la aerolínea o Booking).
--
--  El número 004 deja libres el 002 (purga de la bandeja) y el 003 (traceparent
--  de la bandeja), que van en otras ramas: no dependen de esta ni esta de ellas.
-- =============================================================================

BEGIN;

SET search_path TO vuelos;

-- Bandeja hacia el notifier ---------------------------------------------------

ALTER TABLE evento_saliente ADD COLUMN IF NOT EXISTS correlation_id text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_evento_saliente_correlacion'
                      AND conrelid = 'vuelos.evento_saliente'::regclass) THEN
        ALTER TABLE evento_saliente ADD CONSTRAINT ck_evento_saliente_correlacion
            CHECK (correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9._:-]{1,100}$');
    END IF;
END
$$;

COMMENT ON COLUMN evento_saliente.correlation_id IS 'X-Correlation-Id de la petición que produjo el hecho; el relevo lo manda al notifier sin cambios. NULL si lo produjo un proceso periódico.';

-- Partner y canal de venta de la reserva --------------------------------------

ALTER TABLE reserva_cabecera ADD COLUMN IF NOT EXISTS id_cliente text;
ALTER TABLE reserva_cabecera ADD COLUMN IF NOT EXISTS id_usuario_externo text;
ALTER TABLE reserva_cabecera ADD COLUMN IF NOT EXISTS canal_socio text;
ALTER TABLE reserva_cabecera ADD COLUMN IF NOT EXISTS canal_orden text;
ALTER TABLE reserva_cabecera ADD COLUMN IF NOT EXISTS canal_paquete text;
ALTER TABLE reserva_cabecera ADD COLUMN IF NOT EXISTS canal_promocion boolean;
ALTER TABLE reserva_cabecera ADD COLUMN IF NOT EXISTS canal_descuento numeric(5,2);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_reserva_cabecera_cliente'
                      AND conrelid = 'vuelos.reserva_cabecera'::regclass) THEN
        ALTER TABLE reserva_cabecera ADD CONSTRAINT ck_reserva_cabecera_cliente
            CHECK (id_cliente IS NULL OR id_cliente ~ '^[A-Za-z0-9._:-]{1,100}$');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_reserva_cabecera_usuario_externo'
                      AND conrelid = 'vuelos.reserva_cabecera'::regclass) THEN
        ALTER TABLE reserva_cabecera ADD CONSTRAINT ck_reserva_cabecera_usuario_externo CHECK (
            id_usuario_externo IS NULL
            OR (id_cliente IS NOT NULL AND id_usuario_externo ~ '^[A-Za-z0-9._:@|-]{1,100}$')
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_reserva_cabecera_canal'
                      AND conrelid = 'vuelos.reserva_cabecera'::regclass) THEN
        ALTER TABLE reserva_cabecera ADD CONSTRAINT ck_reserva_cabecera_canal CHECK (
            (canal_socio IS NULL OR btrim(canal_socio) <> '')
            AND (canal_orden IS NULL OR btrim(canal_orden) <> '')
            AND (canal_paquete IS NULL OR btrim(canal_paquete) <> '')
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_reserva_cabecera_canal_descuento'
                      AND conrelid = 'vuelos.reserva_cabecera'::regclass) THEN
        ALTER TABLE reserva_cabecera ADD CONSTRAINT ck_reserva_cabecera_canal_descuento
            CHECK (canal_descuento IS NULL OR canal_descuento BETWEEN 0 AND 100);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ix_reserva_cabecera_usuario_externo
    ON reserva_cabecera (id_cliente, id_usuario_externo, fecha_creacion DESC)
    WHERE id_usuario_externo IS NOT NULL;

COMMENT ON COLUMN reserva_cabecera.id_cliente IS 'Claim client_id del token de partner (contrato v2) que creó la reserva; NULL si la creó una persona. El dueño sigue siendo el sub del token (retencion_cabecera.id_propietario).';
COMMENT ON COLUMN reserva_cabecera.id_usuario_externo IS 'X-User-Id que mandó el partner: el usuario final en Booking. Solo con id_cliente; un partner con X-User-Id solo ve las reservas de ese usuario.';
COMMENT ON COLUMN reserva_cabecera.canal_socio IS 'salesChannel.partnerId (contrato v2).';
COMMENT ON COLUMN reserva_cabecera.canal_orden IS 'salesChannel.partnerOrderId: la orden o carrito en Booking.';
COMMENT ON COLUMN reserva_cabecera.canal_paquete IS 'salesChannel.packageId: el combo (vuelo + auto + hotel), si la reserva es parte de uno.';
COMMENT ON COLUMN reserva_cabecera.canal_promocion IS 'salesChannel.promotionApplied.';
COMMENT ON COLUMN reserva_cabecera.canal_descuento IS 'salesChannel.discountPercentage (0 a 100). Se guarda tal cual: el precio es el congelado del hold.';

-- Quién cobró ------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                    WHERE t.typname = 'proveedor_pago' AND n.nspname = 'vuelos') THEN
        CREATE TYPE proveedor_pago AS ENUM ('AEROLINEA', 'BOOKING_PROTOTIPO');
    END IF;
END
$$;
COMMENT ON TYPE proveedor_pago IS 'Quién cobró (contrato v2, PaymentReference.provider): AEROLINEA=AIRLINE_DIRECT (la Payment API de la aerolínea juzga la referencia, como en v1) o BOOKING_PROTOTIPO (cobró Booking; aquí solo se valida la referencia y el reembolso se calcula sin ejecutarlo).';

-- Las filas que ya existen las cobró la Payment API de la aerolínea (v1): AEROLINEA
ALTER TABLE reserva_detalle_pago ADD COLUMN IF NOT EXISTS proveedor proveedor_pago NOT NULL DEFAULT 'AEROLINEA';

COMMENT ON COLUMN reserva_detalle_pago.proveedor IS 'Quién cobró. Con BOOKING_PROTOTIPO la Payment API de la aerolínea no se consulta y el reembolso solo se calcula.';

COMMIT;
