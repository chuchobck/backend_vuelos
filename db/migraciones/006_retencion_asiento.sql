-- =============================================================================
--  006 · Asientos que aparta un hold (HoldRequest.assignedSeats de la fachada v2)
-- -----------------------------------------------------------------------------
--  Para una base que ya existe (la de Neon, por ejemplo). Una base nueva ya la
--  trae de esquema_vuelos.sql. Idempotente: correrla dos veces deja la base
--  igual. Solo agrega una tabla de detalle, su trigger y sus índices; no toca
--  inventario_cabina ni ningún dato.
-- =============================================================================

BEGIN;

SET search_path TO vuelos;

CREATE TABLE IF NOT EXISTS retencion_detalle_asiento (
    id                   bigint       GENERATED ALWAYS AS IDENTITY,
    retencion_id         uuid         NOT NULL,
    vuelo_programado_id  uuid         NOT NULL,
    asiento_id           bigint       NOT NULL,
    fecha_asignacion     timestamptz  NOT NULL,
    fecha_liberacion     timestamptz,
    CONSTRAINT pk_retencion_detalle_asiento PRIMARY KEY (id),
    CONSTRAINT fk_retencion_detalle_asiento_cabecera FOREIGN KEY (retencion_id) REFERENCES retencion_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT fk_retencion_detalle_asiento_vuelo FOREIGN KEY (vuelo_programado_id) REFERENCES vuelo_programado (id) ON DELETE RESTRICT,
    CONSTRAINT fk_retencion_detalle_asiento_asiento FOREIGN KEY (asiento_id) REFERENCES asiento (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_retencion_detalle_asiento_ocupado
    ON retencion_detalle_asiento (vuelo_programado_id, asiento_id) WHERE fecha_liberacion IS NULL;
CREATE INDEX IF NOT EXISTS ix_retencion_detalle_asiento_retencion ON retencion_detalle_asiento (retencion_id) WHERE fecha_liberacion IS NULL;
CREATE INDEX IF NOT EXISTS ix_retencion_detalle_asiento_asiento ON retencion_detalle_asiento (asiento_id);

-- El asiento que aparta una retención debe pertenecer al mapa de la aeronave del vuelo.
CREATE OR REPLACE FUNCTION fn_validar_asiento_retencion() RETURNS trigger
LANGUAGE plpgsql
SET search_path = vuelos, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM vuelo_programado vp
        JOIN mapa_asientos_detalle f ON f.mapa_asientos_id = vp.mapa_asientos_id
        JOIN asiento a ON a.mapa_asientos_detalle_id = f.id
        WHERE vp.id = NEW.vuelo_programado_id
          AND a.id = NEW.asiento_id
    ) THEN
        RAISE EXCEPTION 'El asiento % no pertenece al mapa de asientos del vuelo %', NEW.asiento_id, NEW.vuelo_programado_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_retencion_detalle_asiento_mapa';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_retencion_detalle_asiento_validar ON retencion_detalle_asiento;
CREATE TRIGGER tg_retencion_detalle_asiento_validar
    BEFORE INSERT OR UPDATE OF vuelo_programado_id, asiento_id ON retencion_detalle_asiento
    FOR EACH ROW EXECUTE FUNCTION fn_validar_asiento_retencion();

COMMENT ON TABLE retencion_detalle_asiento IS 'Asiento que una retención aparta en un vuelo (HoldRequest.assignedSeats de la fachada v2). No toma cupo aparte: el cupo de la cabina ya lo tomó la retención. Mientras la retención esté RETENIDA y sin vencer, nadie más puede apartarlo ni asignarlo.';
COMMENT ON COLUMN retencion_detalle_asiento.fecha_liberacion IS 'NULL mientras la retención lo aparta. Se llena al liberarla, al vencerla o al convertirla en reserva (el asiento pasa a reserva_detalle_asiento), y también si otra retención lo pide cuando esta ya venció. La fila no se borra.';

COMMIT;
