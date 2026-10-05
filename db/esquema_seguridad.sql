-- =============================================================================
--  SISTEMA DE VUELOS - BOOKING ECUADOR
--  Seguridad: usuarios, roles y tokens de refresco del proveedor de identidad
--  simulado (RDA1)
-- -----------------------------------------------------------------------------
--  Requiere esquema_vuelos.sql ya cargado (usa el esquema vuelos y fn_auditar).
--  Mismas convenciones: nombres en español y snake_case, uuid en lo que viaja
--  por la API (el "sub" del JWT es usuario.id), bigint IDENTITY en lo interno,
--  instantes en timestamptz, "activo" para la eliminación lógica.
--
--  AISLAMIENTO: ninguna tabla de vuelos apunta a estas. Las retenciones,
--  reservas y webhooks guardan el "sub" como texto en id_propietario, así que
--  cuando en RDA2 llegue el proveedor de identidad real estas tablas se quitan
--  sin tocar el resto del esquema.
--
--  Qué permisos (scopes) da cada rol NO está aquí: vive en el código
--  (src/modules/auth/scopes.ts), junto a los @Scopes que los exigen.
-- =============================================================================

BEGIN;

SET search_path TO vuelos;


-- =============================================================================
-- 1. TIPOS ENUMERADOS
-- =============================================================================

CREATE TYPE motivo_revocacion AS ENUM ('CIERRE_SESION', 'REUTILIZACION', 'USUARIO_INACTIVO');
COMMENT ON TYPE motivo_revocacion IS 'Por qué se revocó un token de refresco: CIERRE_SESION=logout, REUTILIZACION=llegó un token ya rotado (se revoca toda la familia), USUARIO_INACTIVO=el usuario se desactivó.';


-- =============================================================================
-- 2. USUARIOS Y ROLES
-- =============================================================================

CREATE TABLE usuario (
    id               uuid         NOT NULL DEFAULT gen_random_uuid(),
    correo           text         NOT NULL,
    hash_contrasena  text         NOT NULL,
    activo           boolean      NOT NULL DEFAULT true,
    fecha_creacion   timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_usuario PRIMARY KEY (id),
    CONSTRAINT uq_usuario_correo UNIQUE (correo),
    -- El correo se guarda ya normalizado: sin espacios en los bordes y en minúsculas.
    CONSTRAINT ck_usuario_correo CHECK (
            correo = lower(btrim(correo))
        AND char_length(correo) <= 254
        AND correo ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    ),
    -- Solo hashes argon2id en formato PHC: nunca una contraseña en texto plano. Los
    -- parámetros (m, t, p) pueden venir en cualquier orden: argon2 de Node escribe m,p,t.
    CONSTRAINT ck_usuario_hash_contrasena CHECK (hash_contrasena ~ '^\$argon2id\$v=19\$[a-z]=[0-9]+(,[a-z]=[0-9]+)*\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$')
);

CREATE TABLE rol (
    id           bigint   GENERATED ALWAYS AS IDENTITY,
    codigo       text     NOT NULL,
    descripcion  text     NOT NULL,
    activo       boolean  NOT NULL DEFAULT true,
    CONSTRAINT pk_rol PRIMARY KEY (id),
    CONSTRAINT uq_rol_codigo UNIQUE (codigo),
    CONSTRAINT ck_rol_codigo CHECK (codigo ~ '^[a-z_]+$'),
    CONSTRAINT ck_rol_descripcion CHECK (btrim(descripcion) <> '')
);

CREATE TABLE usuario_rol (
    id                bigint       GENERATED ALWAYS AS IDENTITY,
    usuario_id        uuid         NOT NULL,
    rol_id            bigint       NOT NULL,
    activo            boolean      NOT NULL DEFAULT true,
    fecha_asignacion  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_usuario_rol PRIMARY KEY (id),
    CONSTRAINT uq_usuario_rol UNIQUE (usuario_id, rol_id),
    CONSTRAINT fk_usuario_rol_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE RESTRICT,
    CONSTRAINT fk_usuario_rol_rol FOREIGN KEY (rol_id) REFERENCES rol (id) ON DELETE RESTRICT
);


-- =============================================================================
-- 3. TOKENS DE REFRESCO
--     Rotación con detección de reutilización: cada uso crea un token nuevo en
--     la misma familia y marca el anterior con reemplazado_por_id. Si llega un
--     token que ya tiene reemplazo, alguien lo copió: se revoca toda la familia.
--     El token viaja una sola vez al cliente; aquí solo queda su SHA-256.
-- =============================================================================

CREATE TABLE token_refresco (
    id                  uuid               NOT NULL DEFAULT gen_random_uuid(),
    usuario_id          uuid               NOT NULL,
    id_familia          uuid               NOT NULL,
    hash_token          varchar(64)        NOT NULL,
    fecha_creacion      timestamptz        NOT NULL DEFAULT now(),
    fecha_expiracion    timestamptz        NOT NULL,
    fecha_revocacion    timestamptz,
    motivo_revocacion   motivo_revocacion,
    reemplazado_por_id  uuid,
    CONSTRAINT pk_token_refresco PRIMARY KEY (id),
    CONSTRAINT uq_token_refresco_hash UNIQUE (hash_token),
    CONSTRAINT fk_token_refresco_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE RESTRICT,
    -- SET NULL y no RESTRICT: una purga futura de tokens vencidos borra primero los más
    -- viejos de la familia, que son los que apuntan a los nuevos.
    CONSTRAINT fk_token_refresco_reemplazo FOREIGN KEY (reemplazado_por_id) REFERENCES token_refresco (id) ON DELETE SET NULL,
    CONSTRAINT ck_token_refresco_hash CHECK (hash_token ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_token_refresco_vigencia CHECK (fecha_expiracion > fecha_creacion),
    CONSTRAINT ck_token_refresco_revocacion CHECK ((fecha_revocacion IS NULL) = (motivo_revocacion IS NULL)),
    CONSTRAINT ck_token_refresco_reemplazo CHECK (reemplazado_por_id <> id)
);


-- =============================================================================
-- 4. AUDITORÍA
--     Usuarios y roles sí se auditan (alta, baja lógica, cambio de rol). Los
--     tokens de refresco no: son de alto volumen (dos filas por cada refresh) y
--     su propia tabla ya guarda cuándo se crearon, rotaron y revocaron.
--     fn_auditar enmascara hash_contrasena (ver sección 13 de esquema_vuelos.sql).
-- =============================================================================

DO $$
DECLARE
    v_tabla text;
BEGIN
    FOREACH v_tabla IN ARRAY ARRAY['usuario', 'rol', 'usuario_rol'] LOOP
        EXECUTE format(
            'CREATE TRIGGER tg_%s_auditoria AFTER INSERT OR UPDATE OR DELETE ON vuelos.%I '
            'FOR EACH ROW EXECUTE FUNCTION vuelos.fn_auditar()', v_tabla, v_tabla);
    END LOOP;
END;
$$;


-- =============================================================================
-- 5. ÍNDICES
--     Las FK que ya son la primera columna de una PK o UNIQUE no se repiten.
-- =============================================================================

CREATE INDEX ix_usuario_rol_rol ON usuario_rol (rol_id);
CREATE INDEX ix_token_refresco_usuario ON token_refresco (usuario_id);
CREATE INDEX ix_token_refresco_familia ON token_refresco (id_familia);
CREATE INDEX ix_token_refresco_reemplazo ON token_refresco (reemplazado_por_id) WHERE reemplazado_por_id IS NOT NULL;
CREATE INDEX ix_token_refresco_fecha_expiracion ON token_refresco (fecha_expiracion);


-- =============================================================================
-- 6. COMENTARIOS
-- =============================================================================

COMMENT ON TABLE usuario        IS 'Cuenta del proveedor de identidad simulado. Su id es el "sub" del JWT y el id_propietario de retenciones, reservas y webhooks.';
COMMENT ON TABLE rol            IS 'Rol de un usuario. Los scopes de cada rol están en el código (src/modules/auth/scopes.ts).';
COMMENT ON TABLE usuario_rol    IS 'Roles asignados a un usuario. Quitar un rol es activo = false.';
COMMENT ON TABLE token_refresco IS 'Tokens de refresco emitidos, guardados solo como hash. Una familia nace en el login y crece con cada rotación.';

COMMENT ON COLUMN usuario.correo IS 'Normalizado por la API (trim y minúsculas) antes de guardarse. Es el usuario del login.';
COMMENT ON COLUMN usuario.hash_contrasena IS 'Hash argon2id en formato PHC ($argon2id$v=19$m=...,p=...,t=...$sal$hash). La auditoría lo enmascara.';
COMMENT ON COLUMN usuario.activo IS 'false impide iniciar sesión y refrescar; los tokens de acceso ya emitidos vencen solos (15 minutos).';
COMMENT ON COLUMN token_refresco.id_familia IS 'Mismo valor para todos los tokens que nacen de un login. Reutilizar uno rotado revoca la familia completa.';
COMMENT ON COLUMN token_refresco.hash_token IS 'SHA-256 en hexadecimal del token (256 bits aleatorios). Un hash rápido alcanza: el token no se puede adivinar como una contraseña.';
COMMENT ON COLUMN token_refresco.fecha_revocacion IS 'Revocación explícita (logout, reutilización, usuario inactivo). Un token rotado no se revoca: se marca con reemplazado_por_id.';
COMMENT ON COLUMN token_refresco.reemplazado_por_id IS 'Token que lo reemplazó al rotar. Si llega un token con este campo lleno, fue reutilizado.';

COMMIT;
