-- =============================================================================
--  SISTEMA DE VUELOS - BOOKING ECUADOR
--  Datos semilla de seguridad: roles y administrador de desarrollo
-- -----------------------------------------------------------------------------
--  Requiere esquema_seguridad.sql ya cargado. Se carga con db/reset.sh, que
--  define dos variables de psql antes de este archivo:
--
--    correo_admin  correo del administrador (SEED_ADMIN_EMAIL)
--    hash_admin    hash argon2id de SEED_ADMIN_PASSWORD (db/hash-contrasena.js)
--
--  La contraseña nunca está en git. Si SEED_ADMIN_PASSWORD no está definida,
--  reset.sh no define hash_admin y el administrador no se crea: solo los roles.
-- =============================================================================

BEGIN;

SET search_path TO vuelos;

-- La carga masiva no se registra en la auditoría (ver sección 13 de esquema_vuelos.sql).
SET LOCAL app.auditoria = 'off';

INSERT INTO rol (codigo, descripcion) VALUES
    ('cliente',       'Cliente que busca, retiene, compra y gestiona sus reservas. Rol del registro público.'),
    ('administrador', 'Administra el catálogo (rutas /admin). Tiene todos los scopes.');

\if :{?hash_admin}
    INSERT INTO usuario (correo, hash_contrasena) VALUES (:'correo_admin', :'hash_admin');

    INSERT INTO usuario_rol (usuario_id, rol_id)
    SELECT u.id, r.id
      FROM usuario u CROSS JOIN rol r
     WHERE u.correo = :'correo_admin' AND r.codigo = 'administrador';

    \echo 'Administrador de desarrollo creado:' :'correo_admin'
\else
    \echo 'SEED_ADMIN_PASSWORD no está definida: no se crea el administrador de desarrollo.'
\endif

COMMIT;
