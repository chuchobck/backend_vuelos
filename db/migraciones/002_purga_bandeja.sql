-- =============================================================================
--  002 · Índices para la purga de la bandeja de eventos (WEBHOOKS_MODE=notifier)
-- -----------------------------------------------------------------------------
--  Para una base que ya existe. Una base nueva ya los trae de esquema_vuelos.sql.
--  Idempotente: correrla dos veces deja la base igual. Solo agrega índices
--  parciales y un comentario; no toca filas ni columnas.
-- =============================================================================

BEGIN;

SET search_path TO vuelos;

CREATE INDEX IF NOT EXISTS ix_evento_saliente_publicado ON evento_saliente (publicado_en) WHERE estado = 'PUBLICADO';
CREATE INDEX IF NOT EXISTS ix_evento_saliente_fallido ON evento_saliente (proximo_intento) WHERE estado = 'FALLIDO';

COMMENT ON COLUMN evento_saliente.proximo_intento IS 'Cuándo se vuelve a intentar publicar; de un evento FALLIDO es cuándo falló (la purga cuenta los días de retención desde ahí).';

COMMIT;
