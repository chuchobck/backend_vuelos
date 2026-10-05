-- =============================================================================
--  SISTEMA DE VUELOS - BOOKING ECUADOR
--  Modelo relacional en Tercera Forma Normal (3FN)
-- -----------------------------------------------------------------------------
--  Motor objetivo : PostgreSQL 18 (el script corre sin cambios en 16 y 17)
--  Contrato base  : contracts/vuelos-openapi.yaml (GDS Flight Core API v1.5.0.0)
--  Alcance        : búsqueda, ofertas, retención (hold), reserva, boletos,
--                   postventa, check-in, estado de vuelos, webhooks,
--                   idempotencia y auditoría (log de cambios)
--  Extensiones    : ninguna (gen_random_uuid() es nativa desde PostgreSQL 13)
-- -----------------------------------------------------------------------------
--  CONVENCIONES
--   * Nombres en español y snake_case. Los documentos transaccionales usan
--     <entidad>_cabecera y <entidad>_detalle[_<qué detalla>].
--   * PK uuid en todo identificador que viaja por la API; bigint IDENTITY en lo
--     interno. Las FK repiten exactamente el tipo de la PK referenciada.
--   * Dinero en numeric(12,2). Los totales NO se guardan: se calculan (vistas).
--   * Instantes en timestamptz (se guardan en UTC). Ecuador continental es
--     America/Guayaquil (UTC-5) y Galápagos es Pacific/Galapagos (UTC-6).
--   * Estados en ENUM con valores en español. La equivalencia con los valores
--     del contrato está en el COMMENT ON TYPE de cada uno.
--   * Eliminación lógica: los catálogos y maestros llevan la columna "activo".
--     Los documentos de venta no se borran: cambian de estado.
--   * Auditoría: la tabla "auditoria" registra sola cada alta, cambio y baja
--     de las tablas de negocio. La API solo indica quién actúa (sección 13).
--   * ON DELETE CASCADE solo de detalle a cabecera en agregados efímeros o de
--     configuración. Todo lo demás es RESTRICT. Un borrado bloqueado por
--     RESTRICT responde SQLSTATE 23503 en PostgreSQL 16 y 17, y 23001 en 18.
--
--  IDENTIFICADORES DEL CONTRATO Y DÓNDE VIVEN
--     offerId        -> oferta_cabecera.id
--     itineraryId    -> itinerario_cabecera.id
--     segmentId      -> vuelo_programado.id
--     holdId         -> retencion_cabecera.id
--     bookingId      -> reserva_cabecera.id
--     passengerId    -> reserva_detalle_pasajero.codigo_pasajero (lo envía el cliente)
--     ticketId       -> boleto_cabecera.id
--     changeOfferId  -> cambio_cabecera.id
--     quoteId        -> cotizacion_cancelacion.id
--     webhook id     -> webhook_cabecera.id
--     eventId        -> evento.id
--
--  VOLUMEN SUPUESTO
--     Miles de filas en la etapa académica. Los índices ya contemplan crecer a
--     millones en vuelo_programado, tarifa_*, oferta_* y evento*. No se
--     particiona todavía.
--
--  REINICIO EN DESARROLLO (borra todo el esquema):
--     DROP SCHEMA IF EXISTS vuelos CASCADE;
-- =============================================================================

BEGIN;

CREATE SCHEMA vuelos;
COMMENT ON SCHEMA vuelos IS 'Dominio de Vuelos del Booking Ecuador. Aísla sus tablas de los dominios de alojamientos, autos y atracciones.';

SET search_path TO vuelos;


-- =============================================================================
-- 1. TIPOS ENUMERADOS (listas fijas y cortas)
-- =============================================================================

CREATE TYPE clase_cabina AS ENUM ('ECONOMICA', 'ECONOMICA_PREMIUM', 'EJECUTIVA', 'PRIMERA');
COMMENT ON TYPE clase_cabina IS 'Contrato cabinClass: ECONOMICA=ECONOMY, ECONOMICA_PREMIUM=PREMIUM_ECONOMY, EJECUTIVA=BUSINESS, PRIMERA=FIRST.';

CREATE TYPE tipo_pasajero AS ENUM ('ADULTO', 'JOVEN', 'NINO', 'INFANTE');
COMMENT ON TYPE tipo_pasajero IS 'Contrato passengerType: ADULTO=ADULT, JOVEN=YOUTH, NINO=CHILD, INFANTE=INFANT.';

CREATE TYPE tipo_documento AS ENUM ('PASAPORTE', 'CEDULA');
COMMENT ON TYPE tipo_documento IS 'Contrato documentType: PASAPORTE=PASSPORT, CEDULA=NATIONAL_ID (cédula de identidad o documento nacional equivalente).';

CREATE TYPE genero AS ENUM ('M', 'F', 'X');
COMMENT ON TYPE genero IS 'Contrato gender: mismos valores M, F, X.';

CREATE TYPE posicion_asiento AS ENUM ('VENTANA', 'CENTRO', 'PASILLO');
COMMENT ON TYPE posicion_asiento IS 'Contrato characteristics: VENTANA=WINDOW, PASILLO=AISLE. CENTRO no genera característica.';

CREATE TYPE estado_vuelo AS ENUM ('PROGRAMADO', 'EMBARCANDO', 'DESPEGADO', 'DEMORADO', 'ATERRIZADO', 'CANCELADO', 'DESVIADO');
COMMENT ON TYPE estado_vuelo IS 'Contrato FlightStatus.status: PROGRAMADO=SCHEDULED, EMBARCANDO=BOARDING, DESPEGADO=DEPARTED, DEMORADO=DELAYED, ATERRIZADO=ARRIVED, CANCELADO=CANCELLED, DESVIADO=DIVERTED.';

CREATE TYPE estado_retencion AS ENUM ('RETENIDA', 'LIBERADA', 'EXPIRADA', 'CONSUMIDA');
COMMENT ON TYPE estado_retencion IS 'Contrato HoldStatusResponse.status: RETENIDA=HELD, LIBERADA=RELEASED, EXPIRADA=EXPIRED, CONSUMIDA=CONSUMED.';

CREATE TYPE estado_reserva AS ENUM ('PENDIENTE', 'PENDIENTE_PAGO', 'EMITIENDO_BOLETOS', 'CONFIRMADA', 'FALLIDA', 'CAMBIO_PENDIENTE', 'CANCELACION_PENDIENTE', 'CANCELADA');
COMMENT ON TYPE estado_reserva IS 'Contrato BookingDetail.status: PENDIENTE=PENDING, PENDIENTE_PAGO=PENDING_PAYMENT, EMITIENDO_BOLETOS=TICKET_ISSUING, CONFIRMADA=CONFIRMED, FALLIDA=FAILED, CAMBIO_PENDIENTE=CHANGE_PENDING, CANCELACION_PENDIENTE=CANCELLATION_PENDING, CANCELADA=CANCELLED.';

CREATE TYPE concepto_pago AS ENUM ('EMISION', 'EQUIPAJE_ADICIONAL', 'CAMBIO_FECHA');
COMMENT ON TYPE concepto_pago IS 'Operación que acredita una referencia de pago: POST /bookings, POST /bookings/{id}/baggage o POST /bookings/{id}/date-change.';

CREATE TYPE estado_boleto AS ENUM ('PENDIENTE', 'EMITIENDO', 'EMITIDO', 'FALLIDO', 'ANULADO', 'REEMBOLSADO');
COMMENT ON TYPE estado_boleto IS 'Contrato TicketStatus: PENDIENTE=PENDING, EMITIENDO=ISSUING, EMITIDO=ISSUED, FALLIDO=FAILED, ANULADO=VOIDED, REEMBOLSADO=REFUNDED.';

CREATE TYPE estado_cupon AS ENUM ('PENDIENTE', 'EMITIDO', 'FALLIDO');
COMMENT ON TYPE estado_cupon IS 'Contrato TicketSegmentStatus: PENDIENTE=PENDING, EMITIDO=ISSUED, FALLIDO=FAILED.';

CREATE TYPE estado_cambio AS ENUM ('OFERTADO', 'PENDIENTE', 'CONFIRMADO', 'EXPIRADO', 'FALLIDO');
COMMENT ON TYPE estado_cambio IS 'Ciclo interno de una oferta de cambio de fecha. PENDIENTE corresponde a la respuesta 202 (reserva en CAMBIO_PENDIENTE).';

CREATE TYPE estado_checkin AS ENUM ('REGISTRADO', 'FALLIDO');
COMMENT ON TYPE estado_checkin IS 'Contrato CheckInResponse (por pasajero y segmento): REGISTRADO=CHECKED_IN, FALLIDO=FAILED. NOT_CHECKED_IN es la ausencia de fila.';

CREATE TYPE tipo_codigo_barras AS ENUM ('AZTEC', 'PDF417', 'QR');
COMMENT ON TYPE tipo_codigo_barras IS 'Contrato BoardingPass.barcodeType: mismos valores.';

CREATE TYPE operacion_auditoria AS ENUM ('INSERCION', 'ACTUALIZACION', 'ELIMINACION');
COMMENT ON TYPE operacion_auditoria IS 'Operación registrada en la auditoría: INSERCION=INSERT, ACTUALIZACION=UPDATE (incluye la eliminación lógica), ELIMINACION=DELETE físico.';

CREATE TYPE operacion_idempotente AS ENUM ('CREAR_RETENCION', 'CREAR_RESERVA', 'AGREGAR_EQUIPAJE', 'CONFIRMAR_CAMBIO_FECHA', 'CANCELAR_RESERVA');
COMMENT ON TYPE operacion_idempotente IS 'Operaciones que exigen la cabecera Idempotency-Key: POST /offers/hold, POST /bookings, POST .../baggage, POST .../date-change, POST .../cancel.';


-- =============================================================================
-- 2. CATÁLOGOS
-- =============================================================================

CREATE TABLE pais (
    id           bigint      GENERATED ALWAYS AS IDENTITY,
    codigo_iso2  varchar(2)  NOT NULL,
    codigo_iso3  varchar(3)  NOT NULL,
    nombre       text        NOT NULL,
    activo       boolean     NOT NULL DEFAULT true,
    CONSTRAINT pk_pais PRIMARY KEY (id),
    CONSTRAINT uq_pais_codigo_iso2 UNIQUE (codigo_iso2),
    CONSTRAINT uq_pais_codigo_iso3 UNIQUE (codigo_iso3),
    CONSTRAINT uq_pais_nombre UNIQUE (nombre),
    CONSTRAINT ck_pais_codigo_iso2 CHECK (codigo_iso2 ~ '^[A-Z]{2}$'),
    CONSTRAINT ck_pais_codigo_iso3 CHECK (codigo_iso3 ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_pais_nombre CHECK (btrim(nombre) <> '')
);

CREATE TABLE ciudad (
    id            bigint   GENERATED ALWAYS AS IDENTITY,
    pais_id       bigint   NOT NULL,
    nombre        text     NOT NULL,
    zona_horaria  text     NOT NULL DEFAULT 'America/Guayaquil',
    activo        boolean  NOT NULL DEFAULT true,
    CONSTRAINT pk_ciudad PRIMARY KEY (id),
    CONSTRAINT uq_ciudad_pais_nombre UNIQUE (pais_id, nombre),
    CONSTRAINT fk_ciudad_pais FOREIGN KEY (pais_id) REFERENCES pais (id) ON DELETE RESTRICT,
    CONSTRAINT ck_ciudad_nombre CHECK (btrim(nombre) <> ''),
    CONSTRAINT ck_ciudad_zona_horaria CHECK (zona_horaria ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$')
);

CREATE TABLE aeropuerto (
    id           bigint      GENERATED ALWAYS AS IDENTITY,
    codigo_iata  varchar(3)  NOT NULL,
    nombre       text        NOT NULL,
    ciudad_id    bigint      NOT NULL,
    activo       boolean     NOT NULL DEFAULT true,
    CONSTRAINT pk_aeropuerto PRIMARY KEY (id),
    CONSTRAINT uq_aeropuerto_codigo_iata UNIQUE (codigo_iata),
    CONSTRAINT fk_aeropuerto_ciudad FOREIGN KEY (ciudad_id) REFERENCES ciudad (id) ON DELETE RESTRICT,
    CONSTRAINT ck_aeropuerto_codigo_iata CHECK (codigo_iata ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_aeropuerto_nombre CHECK (btrim(nombre) <> '')
);

CREATE TABLE aerolinea (
    id             bigint      GENERATED ALWAYS AS IDENTITY,
    codigo_iata    varchar(2)  NOT NULL,
    nombre         text        NOT NULL,
    prefijo_boleto varchar(3),
    activo         boolean     NOT NULL DEFAULT true,
    CONSTRAINT pk_aerolinea PRIMARY KEY (id),
    CONSTRAINT uq_aerolinea_codigo_iata UNIQUE (codigo_iata),
    CONSTRAINT uq_aerolinea_prefijo_boleto UNIQUE (prefijo_boleto),
    CONSTRAINT ck_aerolinea_codigo_iata CHECK (codigo_iata ~ '^[A-Z0-9]{2}$'),
    CONSTRAINT ck_aerolinea_prefijo_boleto CHECK (prefijo_boleto ~ '^[0-9]{3}$'),
    CONSTRAINT ck_aerolinea_nombre CHECK (btrim(nombre) <> '')
);

CREATE TABLE modelo_aeronave (
    id           bigint      GENERATED ALWAYS AS IDENTITY,
    codigo_iata  varchar(3)  NOT NULL,
    nombre       text        NOT NULL,
    activo       boolean     NOT NULL DEFAULT true,
    CONSTRAINT pk_modelo_aeronave PRIMARY KEY (id),
    CONSTRAINT uq_modelo_aeronave_codigo_iata UNIQUE (codigo_iata),
    CONSTRAINT ck_modelo_aeronave_codigo_iata CHECK (codigo_iata ~ '^[A-Z0-9]{3}$'),
    CONSTRAINT ck_modelo_aeronave_nombre CHECK (btrim(nombre) <> '')
);

CREATE TABLE moneda (
    id          bigint      GENERATED ALWAYS AS IDENTITY,
    codigo_iso  varchar(3)  NOT NULL,
    nombre      text        NOT NULL,
    decimales   smallint    NOT NULL DEFAULT 2,
    activo      boolean     NOT NULL DEFAULT true,
    CONSTRAINT pk_moneda PRIMARY KEY (id),
    CONSTRAINT uq_moneda_codigo_iso UNIQUE (codigo_iso),
    CONSTRAINT ck_moneda_codigo_iso CHECK (codigo_iso ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_moneda_decimales CHECK (decimales BETWEEN 0 AND 2),
    CONSTRAINT ck_moneda_nombre CHECK (btrim(nombre) <> '')
);

CREATE TABLE familia_tarifa (
    id                                bigint        GENERATED ALWAYS AS IDENTITY,
    aerolinea_id                      bigint        NOT NULL,
    clase_cabina                      clase_cabina  NOT NULL,
    codigo                            text          NOT NULL,
    nombre                            text          NOT NULL,
    es_cambiable                      boolean       NOT NULL,
    porcentaje_penalidad_cancelacion  numeric(5,2)  NOT NULL DEFAULT 100,
    incluye_articulo_personal         boolean       NOT NULL DEFAULT true,
    equipaje_mano_incluido            smallint      NOT NULL DEFAULT 0,
    equipaje_bodega_incluido          smallint      NOT NULL DEFAULT 0,
    maximo_equipaje_adicional         smallint      NOT NULL DEFAULT 3,
    activo                            boolean       NOT NULL DEFAULT true,
    CONSTRAINT pk_familia_tarifa PRIMARY KEY (id),
    CONSTRAINT uq_familia_tarifa_aerolinea_cabina_codigo UNIQUE (aerolinea_id, clase_cabina, codigo),
    CONSTRAINT fk_familia_tarifa_aerolinea FOREIGN KEY (aerolinea_id) REFERENCES aerolinea (id) ON DELETE RESTRICT,
    CONSTRAINT ck_familia_tarifa_codigo CHECK (codigo ~ '^[A-Z0-9_]{2,20}$'),
    CONSTRAINT ck_familia_tarifa_nombre CHECK (btrim(nombre) <> ''),
    CONSTRAINT ck_familia_tarifa_penalidad CHECK (porcentaje_penalidad_cancelacion BETWEEN 0 AND 100),
    CONSTRAINT ck_familia_tarifa_equipaje CHECK (
        equipaje_mano_incluido BETWEEN 0 AND 3
        AND equipaje_bodega_incluido BETWEEN 0 AND 5
        AND maximo_equipaje_adicional BETWEEN 0 AND 10
    )
);

CREATE TABLE tipo_evento (
    id           bigint   GENERATED ALWAYS AS IDENTITY,
    codigo       text     NOT NULL,
    descripcion  text     NOT NULL,
    activo       boolean  NOT NULL DEFAULT true,
    CONSTRAINT pk_tipo_evento PRIMARY KEY (id),
    CONSTRAINT uq_tipo_evento_codigo UNIQUE (codigo),
    CONSTRAINT ck_tipo_evento_codigo CHECK (codigo ~ '^[a-z_]+\.[a-z_]+$'),
    CONSTRAINT ck_tipo_evento_descripcion CHECK (btrim(descripcion) <> '')
);


-- =============================================================================
-- 3. MAPAS DE ASIENTOS (configuración de cabina por aerolínea y aeronave)
-- =============================================================================

CREATE TABLE mapa_asientos_cabecera (
    id                  bigint   GENERATED ALWAYS AS IDENTITY,
    aerolinea_id        bigint   NOT NULL,
    modelo_aeronave_id  bigint   NOT NULL,
    nombre              text     NOT NULL,
    activo              boolean  NOT NULL DEFAULT true,
    CONSTRAINT pk_mapa_asientos_cabecera PRIMARY KEY (id),
    CONSTRAINT uq_mapa_asientos_cabecera_nombre UNIQUE (aerolinea_id, modelo_aeronave_id, nombre),
    CONSTRAINT fk_mapa_asientos_cabecera_aerolinea FOREIGN KEY (aerolinea_id) REFERENCES aerolinea (id) ON DELETE RESTRICT,
    CONSTRAINT fk_mapa_asientos_cabecera_modelo FOREIGN KEY (modelo_aeronave_id) REFERENCES modelo_aeronave (id) ON DELETE RESTRICT,
    CONSTRAINT ck_mapa_asientos_cabecera_nombre CHECK (btrim(nombre) <> '')
);

CREATE TABLE mapa_asientos_detalle (
    id                 bigint        GENERATED ALWAYS AS IDENTITY,
    mapa_asientos_id   bigint        NOT NULL,
    numero_fila        smallint      NOT NULL,
    clase_cabina       clase_cabina  NOT NULL,
    espacio_extra      boolean       NOT NULL DEFAULT false,
    salida_emergencia  boolean       NOT NULL DEFAULT false,
    CONSTRAINT pk_mapa_asientos_detalle PRIMARY KEY (id),
    CONSTRAINT uq_mapa_asientos_detalle_fila UNIQUE (mapa_asientos_id, numero_fila),
    CONSTRAINT fk_mapa_asientos_detalle_cabecera FOREIGN KEY (mapa_asientos_id) REFERENCES mapa_asientos_cabecera (id) ON DELETE CASCADE,
    CONSTRAINT ck_mapa_asientos_detalle_fila CHECK (numero_fila BETWEEN 1 AND 99)
);

CREATE TABLE asiento (
    id                        bigint            GENERATED ALWAYS AS IDENTITY,
    mapa_asientos_detalle_id  bigint            NOT NULL,
    letra                     varchar(1)        NOT NULL,
    posicion                  posicion_asiento  NOT NULL,
    CONSTRAINT pk_asiento PRIMARY KEY (id),
    CONSTRAINT uq_asiento_fila_letra UNIQUE (mapa_asientos_detalle_id, letra),
    CONSTRAINT fk_asiento_fila FOREIGN KEY (mapa_asientos_detalle_id) REFERENCES mapa_asientos_detalle (id) ON DELETE CASCADE,
    CONSTRAINT ck_asiento_letra CHECK (letra ~ '^[A-HJK]$')
);


-- =============================================================================
-- 4. VUELOS E INVENTARIO
-- =============================================================================

CREATE TABLE vuelo (
    id                      bigint      GENERATED ALWAYS AS IDENTITY,
    aerolinea_id            bigint      NOT NULL,
    aerolinea_operadora_id  bigint      NOT NULL,
    numero                  varchar(4)  NOT NULL,
    aeropuerto_origen_id    bigint      NOT NULL,
    aeropuerto_destino_id   bigint      NOT NULL,
    activo                  boolean     NOT NULL DEFAULT true,
    CONSTRAINT pk_vuelo PRIMARY KEY (id),
    CONSTRAINT uq_vuelo_aerolinea_numero UNIQUE (aerolinea_id, numero),
    CONSTRAINT fk_vuelo_aerolinea FOREIGN KEY (aerolinea_id) REFERENCES aerolinea (id) ON DELETE RESTRICT,
    CONSTRAINT fk_vuelo_aerolinea_operadora FOREIGN KEY (aerolinea_operadora_id) REFERENCES aerolinea (id) ON DELETE RESTRICT,
    CONSTRAINT fk_vuelo_aeropuerto_origen FOREIGN KEY (aeropuerto_origen_id) REFERENCES aeropuerto (id) ON DELETE RESTRICT,
    CONSTRAINT fk_vuelo_aeropuerto_destino FOREIGN KEY (aeropuerto_destino_id) REFERENCES aeropuerto (id) ON DELETE RESTRICT,
    CONSTRAINT ck_vuelo_numero CHECK (numero ~ '^[1-9][0-9]{0,3}$'),
    CONSTRAINT ck_vuelo_ruta CHECK (aeropuerto_origen_id <> aeropuerto_destino_id)
);

CREATE TABLE vuelo_programado (
    id                  uuid          NOT NULL DEFAULT gen_random_uuid(),
    vuelo_id            bigint        NOT NULL,
    mapa_asientos_id    bigint        NOT NULL,
    fecha_salida        date          NOT NULL,
    salida_programada   timestamptz   NOT NULL,
    llegada_programada  timestamptz   NOT NULL,
    salida_estimada     timestamptz,
    llegada_estimada    timestamptz,
    salida_real         timestamptz,
    llegada_real        timestamptz,
    terminal_salida     text,
    terminal_llegada    text,
    estado              estado_vuelo  NOT NULL DEFAULT 'PROGRAMADO',
    CONSTRAINT pk_vuelo_programado PRIMARY KEY (id),
    CONSTRAINT uq_vuelo_programado_vuelo_fecha UNIQUE (vuelo_id, fecha_salida),
    CONSTRAINT fk_vuelo_programado_vuelo FOREIGN KEY (vuelo_id) REFERENCES vuelo (id) ON DELETE RESTRICT,
    CONSTRAINT fk_vuelo_programado_mapa_asientos FOREIGN KEY (mapa_asientos_id) REFERENCES mapa_asientos_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT ck_vuelo_programado_llegada CHECK (llegada_programada > salida_programada),
    CONSTRAINT ck_vuelo_programado_fecha_salida CHECK (
        fecha_salida BETWEEN (salida_programada AT TIME ZONE 'UTC')::date - 1
                         AND (salida_programada AT TIME ZONE 'UTC')::date + 1
    ),
    CONSTRAINT ck_vuelo_programado_estimadas CHECK (
        salida_estimada IS NULL OR llegada_estimada IS NULL OR llegada_estimada > salida_estimada
    ),
    CONSTRAINT ck_vuelo_programado_reales CHECK (
        llegada_real IS NULL OR (salida_real IS NOT NULL AND llegada_real > salida_real)
    )
);

CREATE TABLE inventario_cabina (
    id                   bigint        GENERATED ALWAYS AS IDENTITY,
    vuelo_programado_id  uuid          NOT NULL,
    clase_cabina         clase_cabina  NOT NULL,
    cupos_totales        smallint      NOT NULL,
    cupos_disponibles    smallint      NOT NULL,
    CONSTRAINT pk_inventario_cabina PRIMARY KEY (id),
    CONSTRAINT uq_inventario_cabina_vuelo_cabina UNIQUE (vuelo_programado_id, clase_cabina),
    CONSTRAINT fk_inventario_cabina_vuelo_programado FOREIGN KEY (vuelo_programado_id) REFERENCES vuelo_programado (id) ON DELETE CASCADE,
    CONSTRAINT ck_inventario_cabina_cupos_totales CHECK (cupos_totales >= 0),
    CONSTRAINT ck_inventario_cabina_cupos_disponibles CHECK (cupos_disponibles BETWEEN 0 AND cupos_totales)
);

CREATE TABLE tarifa_cabecera (
    id                         bigint         GENERATED ALWAYS AS IDENTITY,
    vuelo_programado_id        uuid           NOT NULL,
    familia_tarifa_id          bigint         NOT NULL,
    moneda_id                  bigint         NOT NULL,
    precio_equipaje_adicional  numeric(12,2)  NOT NULL,
    cargo_cambio               numeric(12,2)  NOT NULL DEFAULT 0,
    activo                     boolean        NOT NULL DEFAULT true,
    CONSTRAINT pk_tarifa_cabecera PRIMARY KEY (id),
    CONSTRAINT uq_tarifa_cabecera_vuelo_familia UNIQUE (vuelo_programado_id, familia_tarifa_id),
    CONSTRAINT fk_tarifa_cabecera_vuelo_programado FOREIGN KEY (vuelo_programado_id) REFERENCES vuelo_programado (id) ON DELETE RESTRICT,
    CONSTRAINT fk_tarifa_cabecera_familia_tarifa FOREIGN KEY (familia_tarifa_id) REFERENCES familia_tarifa (id) ON DELETE RESTRICT,
    CONSTRAINT fk_tarifa_cabecera_moneda FOREIGN KEY (moneda_id) REFERENCES moneda (id) ON DELETE RESTRICT,
    CONSTRAINT ck_tarifa_cabecera_montos CHECK (precio_equipaje_adicional >= 0 AND cargo_cambio >= 0)
);

CREATE TABLE tarifa_detalle (
    id             bigint         GENERATED ALWAYS AS IDENTITY,
    tarifa_id      bigint         NOT NULL,
    tipo_pasajero  tipo_pasajero  NOT NULL,
    tarifa_base    numeric(12,2)  NOT NULL,
    impuestos      numeric(12,2)  NOT NULL,
    CONSTRAINT pk_tarifa_detalle PRIMARY KEY (id),
    CONSTRAINT uq_tarifa_detalle_tarifa_tipo UNIQUE (tarifa_id, tipo_pasajero),
    CONSTRAINT fk_tarifa_detalle_cabecera FOREIGN KEY (tarifa_id) REFERENCES tarifa_cabecera (id) ON DELETE CASCADE,
    CONSTRAINT ck_tarifa_detalle_montos CHECK (tarifa_base >= 0 AND impuestos >= 0)
);


-- =============================================================================
-- 5. ITINERARIOS Y OFERTAS (resultado de POST /search)
-- =============================================================================

CREATE TABLE itinerario_cabecera (
    id              uuid         NOT NULL DEFAULT gen_random_uuid(),
    fecha_creacion  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_itinerario_cabecera PRIMARY KEY (id)
);

CREATE TABLE itinerario_detalle (
    id                   bigint    GENERATED ALWAYS AS IDENTITY,
    itinerario_id        uuid      NOT NULL,
    orden                smallint  NOT NULL,
    vuelo_programado_id  uuid      NOT NULL,
    CONSTRAINT pk_itinerario_detalle PRIMARY KEY (id),
    CONSTRAINT uq_itinerario_detalle_orden UNIQUE (itinerario_id, orden),
    CONSTRAINT uq_itinerario_detalle_vuelo UNIQUE (itinerario_id, vuelo_programado_id),
    CONSTRAINT fk_itinerario_detalle_cabecera FOREIGN KEY (itinerario_id) REFERENCES itinerario_cabecera (id) ON DELETE CASCADE,
    CONSTRAINT fk_itinerario_detalle_vuelo_programado FOREIGN KEY (vuelo_programado_id) REFERENCES vuelo_programado (id) ON DELETE RESTRICT,
    CONSTRAINT ck_itinerario_detalle_orden CHECK (orden BETWEEN 1 AND 4)
);

CREATE TABLE oferta_cabecera (
    id                  uuid         NOT NULL DEFAULT gen_random_uuid(),
    aerolinea_id        bigint       NOT NULL,
    huella_dispositivo  text         NOT NULL,
    fecha_creacion      timestamptz  NOT NULL DEFAULT now(),
    fecha_expiracion    timestamptz  NOT NULL,
    CONSTRAINT pk_oferta_cabecera PRIMARY KEY (id),
    CONSTRAINT fk_oferta_cabecera_aerolinea FOREIGN KEY (aerolinea_id) REFERENCES aerolinea (id) ON DELETE RESTRICT,
    CONSTRAINT ck_oferta_cabecera_huella CHECK (btrim(huella_dispositivo) <> ''),
    CONSTRAINT ck_oferta_cabecera_vigencia CHECK (fecha_expiracion > fecha_creacion)
);

CREATE TABLE oferta_detalle (
    id             bigint    GENERATED ALWAYS AS IDENTITY,
    oferta_id      uuid      NOT NULL,
    itinerario_id  uuid      NOT NULL,
    orden          smallint  NOT NULL,
    CONSTRAINT pk_oferta_detalle PRIMARY KEY (id),
    CONSTRAINT uq_oferta_detalle_orden UNIQUE (oferta_id, orden),
    CONSTRAINT uq_oferta_detalle_itinerario UNIQUE (oferta_id, itinerario_id),
    CONSTRAINT fk_oferta_detalle_cabecera FOREIGN KEY (oferta_id) REFERENCES oferta_cabecera (id) ON DELETE CASCADE,
    CONSTRAINT fk_oferta_detalle_itinerario FOREIGN KEY (itinerario_id) REFERENCES itinerario_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT ck_oferta_detalle_orden CHECK (orden BETWEEN 1 AND 6)
);


-- =============================================================================
-- 6. RETENCIÓN DE CUPOS (hold)
-- =============================================================================

CREATE TABLE retencion_cabecera (
    id                uuid              NOT NULL DEFAULT gen_random_uuid(),
    oferta_id         uuid              NOT NULL,
    id_propietario    text              NOT NULL,
    moneda_id         bigint            NOT NULL,
    estado            estado_retencion  NOT NULL DEFAULT 'RETENIDA',
    adultos           smallint          NOT NULL DEFAULT 1,
    jovenes           smallint          NOT NULL DEFAULT 0,
    ninos             smallint          NOT NULL DEFAULT 0,
    infantes          smallint          NOT NULL DEFAULT 0,
    fecha_creacion    timestamptz       NOT NULL DEFAULT now(),
    fecha_expiracion  timestamptz       NOT NULL,
    fecha_cierre      timestamptz,
    CONSTRAINT pk_retencion_cabecera PRIMARY KEY (id),
    CONSTRAINT fk_retencion_cabecera_oferta FOREIGN KEY (oferta_id) REFERENCES oferta_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT fk_retencion_cabecera_moneda FOREIGN KEY (moneda_id) REFERENCES moneda (id) ON DELETE RESTRICT,
    CONSTRAINT ck_retencion_cabecera_propietario CHECK (btrim(id_propietario) <> ''),
    CONSTRAINT ck_retencion_cabecera_pasajeros CHECK (adultos >= 1 AND jovenes >= 0 AND ninos >= 0 AND infantes >= 0),
    CONSTRAINT ck_retencion_cabecera_infantes CHECK (infantes <= adultos),
    CONSTRAINT ck_retencion_cabecera_maximo CHECK (adultos + jovenes + ninos <= 9),
    CONSTRAINT ck_retencion_cabecera_vigencia CHECK (fecha_expiracion > fecha_creacion),
    CONSTRAINT ck_retencion_cabecera_cierre CHECK ((estado = 'RETENIDA') = (fecha_cierre IS NULL))
);

CREATE TABLE retencion_detalle (
    id                     bigint         GENERATED ALWAYS AS IDENTITY,
    retencion_id           uuid           NOT NULL,
    itinerario_id          uuid           NOT NULL,
    familia_tarifa_id      bigint         NOT NULL,
    tarifa_base_congelada  numeric(12,2)  NOT NULL,
    impuestos_congelados   numeric(12,2)  NOT NULL,
    CONSTRAINT pk_retencion_detalle PRIMARY KEY (id),
    CONSTRAINT uq_retencion_detalle_itinerario UNIQUE (retencion_id, itinerario_id),
    CONSTRAINT fk_retencion_detalle_cabecera FOREIGN KEY (retencion_id) REFERENCES retencion_cabecera (id) ON DELETE CASCADE,
    CONSTRAINT fk_retencion_detalle_itinerario FOREIGN KEY (itinerario_id) REFERENCES itinerario_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT fk_retencion_detalle_familia_tarifa FOREIGN KEY (familia_tarifa_id) REFERENCES familia_tarifa (id) ON DELETE RESTRICT,
    CONSTRAINT ck_retencion_detalle_montos CHECK (tarifa_base_congelada >= 0 AND impuestos_congelados >= 0)
);


-- =============================================================================
-- 7. RESERVA (booking / PNR)
-- =============================================================================

CREATE TABLE reserva_cabecera (
    id                   uuid            NOT NULL DEFAULT gen_random_uuid(),
    retencion_id         uuid            NOT NULL,
    pnr                  varchar(6)      NOT NULL,
    estado               estado_reserva  NOT NULL DEFAULT 'PENDIENTE',
    fecha_creacion       timestamptz     NOT NULL DEFAULT now(),
    fecha_actualizacion  timestamptz     NOT NULL DEFAULT now(),
    CONSTRAINT pk_reserva_cabecera PRIMARY KEY (id),
    CONSTRAINT uq_reserva_cabecera_retencion UNIQUE (retencion_id),
    CONSTRAINT uq_reserva_cabecera_pnr UNIQUE (pnr),
    CONSTRAINT fk_reserva_cabecera_retencion FOREIGN KEY (retencion_id) REFERENCES retencion_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT ck_reserva_cabecera_pnr CHECK (pnr ~ '^[A-Z0-9]{6}$')
);

CREATE TABLE reserva_detalle_itinerario (
    id                 bigint         GENERATED ALWAYS AS IDENTITY,
    reserva_id         uuid           NOT NULL,
    itinerario_id      uuid           NOT NULL,
    familia_tarifa_id  bigint         NOT NULL,
    orden              smallint       NOT NULL,
    tarifa_base        numeric(12,2)  NOT NULL,
    impuestos          numeric(12,2)  NOT NULL,
    vigente            boolean        NOT NULL DEFAULT true,
    CONSTRAINT pk_reserva_detalle_itinerario PRIMARY KEY (id),
    CONSTRAINT uq_reserva_detalle_itinerario UNIQUE (reserva_id, itinerario_id),
    CONSTRAINT fk_reserva_detalle_itinerario_reserva FOREIGN KEY (reserva_id) REFERENCES reserva_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT fk_reserva_detalle_itinerario_itinerario FOREIGN KEY (itinerario_id) REFERENCES itinerario_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT fk_reserva_detalle_itinerario_familia FOREIGN KEY (familia_tarifa_id) REFERENCES familia_tarifa (id) ON DELETE RESTRICT,
    CONSTRAINT ck_reserva_detalle_itinerario_orden CHECK (orden BETWEEN 1 AND 6),
    CONSTRAINT ck_reserva_detalle_itinerario_montos CHECK (tarifa_base >= 0 AND impuestos >= 0)
);

CREATE TABLE reserva_detalle_pasajero (
    id                           bigint          GENERATED ALWAYS AS IDENTITY,
    reserva_id                   uuid            NOT NULL,
    codigo_pasajero              text            NOT NULL,
    tipo_pasajero                tipo_pasajero   NOT NULL,
    adulto_responsable_id        bigint,
    nombres                      text            NOT NULL,
    apellidos                    text            NOT NULL,
    tipo_documento               tipo_documento  NOT NULL,
    numero_documento             varchar(20)     NOT NULL,
    pais_nacionalidad_id         bigint          NOT NULL,
    fecha_vencimiento_documento  date,
    fecha_nacimiento             date            NOT NULL,
    genero                       genero          NOT NULL,
    correo                       text            NOT NULL,
    telefono                     varchar(16)     NOT NULL,
    CONSTRAINT pk_reserva_detalle_pasajero PRIMARY KEY (id),
    CONSTRAINT uq_reserva_detalle_pasajero_codigo UNIQUE (reserva_id, codigo_pasajero),
    CONSTRAINT uq_reserva_detalle_pasajero_documento UNIQUE (reserva_id, tipo_documento, numero_documento),
    CONSTRAINT fk_reserva_detalle_pasajero_reserva FOREIGN KEY (reserva_id) REFERENCES reserva_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT fk_reserva_detalle_pasajero_adulto FOREIGN KEY (adulto_responsable_id) REFERENCES reserva_detalle_pasajero (id) ON DELETE RESTRICT,
    CONSTRAINT fk_reserva_detalle_pasajero_pais FOREIGN KEY (pais_nacionalidad_id) REFERENCES pais (id) ON DELETE RESTRICT,
    CONSTRAINT ck_reserva_detalle_pasajero_codigo CHECK (btrim(codigo_pasajero) <> ''),
    CONSTRAINT ck_reserva_detalle_pasajero_nombres CHECK (btrim(nombres) <> '' AND btrim(apellidos) <> ''),
    CONSTRAINT ck_reserva_detalle_pasajero_documento CHECK (numero_documento ~ '^[A-Z0-9]{5,20}$'),
    CONSTRAINT ck_reserva_detalle_pasajero_pasaporte CHECK (tipo_documento <> 'PASAPORTE' OR fecha_vencimiento_documento IS NOT NULL),
    CONSTRAINT ck_reserva_detalle_pasajero_nacimiento CHECK (fecha_nacimiento >= DATE '1900-01-01'),
    CONSTRAINT ck_reserva_detalle_pasajero_correo CHECK (correo ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    CONSTRAINT ck_reserva_detalle_pasajero_telefono CHECK (telefono ~ '^\+?[0-9]{7,15}$'),
    CONSTRAINT ck_reserva_detalle_pasajero_infante CHECK (tipo_pasajero <> 'INFANTE' OR adulto_responsable_id IS NOT NULL),
    CONSTRAINT ck_reserva_detalle_pasajero_no_propio CHECK (adulto_responsable_id IS NULL OR adulto_responsable_id <> id)
);

CREATE TABLE reserva_detalle_asiento (
    id                   bigint       GENERATED ALWAYS AS IDENTITY,
    pasajero_id          bigint       NOT NULL,
    vuelo_programado_id  uuid         NOT NULL,
    asiento_id           bigint       NOT NULL,
    fecha_asignacion     timestamptz  NOT NULL DEFAULT now(),
    fecha_liberacion     timestamptz,
    CONSTRAINT pk_reserva_detalle_asiento PRIMARY KEY (id),
    CONSTRAINT fk_reserva_detalle_asiento_pasajero FOREIGN KEY (pasajero_id) REFERENCES reserva_detalle_pasajero (id) ON DELETE RESTRICT,
    CONSTRAINT fk_reserva_detalle_asiento_vuelo FOREIGN KEY (vuelo_programado_id) REFERENCES vuelo_programado (id) ON DELETE RESTRICT,
    CONSTRAINT fk_reserva_detalle_asiento_asiento FOREIGN KEY (asiento_id) REFERENCES asiento (id) ON DELETE RESTRICT
);

CREATE TABLE reserva_detalle_pago (
    id               bigint         GENERATED ALWAYS AS IDENTITY,
    reserva_id       uuid           NOT NULL,
    referencia_pago  text           NOT NULL,
    concepto         concepto_pago  NOT NULL,
    fecha_registro   timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT pk_reserva_detalle_pago PRIMARY KEY (id),
    CONSTRAINT uq_reserva_detalle_pago_referencia UNIQUE (referencia_pago),
    CONSTRAINT fk_reserva_detalle_pago_reserva FOREIGN KEY (reserva_id) REFERENCES reserva_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT ck_reserva_detalle_pago_referencia CHECK (btrim(referencia_pago) <> '')
);

CREATE TABLE reserva_detalle_equipaje (
    id                     bigint         GENERATED ALWAYS AS IDENTITY,
    pasajero_id            bigint         NOT NULL,
    reserva_itinerario_id  bigint         NOT NULL,
    pago_id                bigint         NOT NULL,
    cantidad               smallint       NOT NULL,
    precio_unitario        numeric(12,2)  NOT NULL,
    fecha_registro         timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT pk_reserva_detalle_equipaje PRIMARY KEY (id),
    CONSTRAINT fk_reserva_detalle_equipaje_pasajero FOREIGN KEY (pasajero_id) REFERENCES reserva_detalle_pasajero (id) ON DELETE RESTRICT,
    CONSTRAINT fk_reserva_detalle_equipaje_itinerario FOREIGN KEY (reserva_itinerario_id) REFERENCES reserva_detalle_itinerario (id) ON DELETE RESTRICT,
    CONSTRAINT fk_reserva_detalle_equipaje_pago FOREIGN KEY (pago_id) REFERENCES reserva_detalle_pago (id) ON DELETE RESTRICT,
    CONSTRAINT ck_reserva_detalle_equipaje_cantidad CHECK (cantidad BETWEEN 1 AND 10),
    CONSTRAINT ck_reserva_detalle_equipaje_precio CHECK (precio_unitario >= 0)
);

CREATE TABLE reserva_detalle_historial (
    id               bigint          GENERATED ALWAYS AS IDENTITY,
    reserva_id       uuid            NOT NULL,
    estado_anterior  estado_reserva,
    estado_nuevo     estado_reserva,
    descripcion      text            NOT NULL,
    fecha_evento     timestamptz     NOT NULL DEFAULT now(),
    CONSTRAINT pk_reserva_detalle_historial PRIMARY KEY (id),
    CONSTRAINT fk_reserva_detalle_historial_reserva FOREIGN KEY (reserva_id) REFERENCES reserva_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT ck_reserva_detalle_historial_descripcion CHECK (btrim(descripcion) <> ''),
    CONSTRAINT ck_reserva_detalle_historial_transicion CHECK (
        (estado_anterior IS NULL AND estado_nuevo IS NULL)
        OR (estado_nuevo IS NOT NULL AND estado_anterior IS DISTINCT FROM estado_nuevo)
    )
);


-- =============================================================================
-- 8. BOLETOS (tickets electrónicos y sus cupones)
-- =============================================================================

CREATE TABLE boleto_cabecera (
    id              uuid           NOT NULL DEFAULT gen_random_uuid(),
    pasajero_id     bigint         NOT NULL,
    numero_boleto   varchar(13),
    estado          estado_boleto  NOT NULL DEFAULT 'PENDIENTE',
    fecha_emision   timestamptz,
    motivo_fallo    text,
    fecha_creacion  timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT pk_boleto_cabecera PRIMARY KEY (id),
    CONSTRAINT uq_boleto_cabecera_numero UNIQUE (numero_boleto),
    CONSTRAINT fk_boleto_cabecera_pasajero FOREIGN KEY (pasajero_id) REFERENCES reserva_detalle_pasajero (id) ON DELETE RESTRICT,
    CONSTRAINT ck_boleto_cabecera_numero CHECK (numero_boleto ~ '^[0-9]{13}$'),
    CONSTRAINT ck_boleto_cabecera_emitido CHECK (
        estado NOT IN ('EMITIDO', 'ANULADO', 'REEMBOLSADO')
        OR (numero_boleto IS NOT NULL AND fecha_emision IS NOT NULL)
    ),
    CONSTRAINT ck_boleto_cabecera_motivo_fallo CHECK (motivo_fallo IS NULL OR estado = 'FALLIDO')
);

CREATE TABLE boleto_detalle (
    id                   bigint        GENERATED ALWAYS AS IDENTITY,
    boleto_id            uuid          NOT NULL,
    vuelo_programado_id  uuid          NOT NULL,
    numero_cupon         smallint,
    estado               estado_cupon  NOT NULL DEFAULT 'PENDIENTE',
    CONSTRAINT pk_boleto_detalle PRIMARY KEY (id),
    CONSTRAINT uq_boleto_detalle_vuelo UNIQUE (boleto_id, vuelo_programado_id),
    CONSTRAINT uq_boleto_detalle_cupon UNIQUE (boleto_id, numero_cupon),
    CONSTRAINT fk_boleto_detalle_cabecera FOREIGN KEY (boleto_id) REFERENCES boleto_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT fk_boleto_detalle_vuelo_programado FOREIGN KEY (vuelo_programado_id) REFERENCES vuelo_programado (id) ON DELETE RESTRICT,
    CONSTRAINT ck_boleto_detalle_cupon CHECK (numero_cupon >= 1),
    CONSTRAINT ck_boleto_detalle_emitido CHECK (estado <> 'EMITIDO' OR numero_cupon IS NOT NULL)
);


-- =============================================================================
-- 9. POSTVENTA: CAMBIO DE FECHA Y CANCELACIÓN
-- =============================================================================

CREATE TABLE cambio_cabecera (
    id                uuid           NOT NULL DEFAULT gen_random_uuid(),
    reserva_id        uuid           NOT NULL,
    estado            estado_cambio  NOT NULL DEFAULT 'OFERTADO',
    cargo_cambio      numeric(12,2)  NOT NULL DEFAULT 0,
    pago_id           bigint,
    fecha_creacion    timestamptz    NOT NULL DEFAULT now(),
    fecha_expiracion  timestamptz    NOT NULL,
    fecha_resolucion  timestamptz,
    CONSTRAINT pk_cambio_cabecera PRIMARY KEY (id),
    CONSTRAINT uq_cambio_cabecera_pago UNIQUE (pago_id),
    CONSTRAINT fk_cambio_cabecera_reserva FOREIGN KEY (reserva_id) REFERENCES reserva_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT fk_cambio_cabecera_pago FOREIGN KEY (pago_id) REFERENCES reserva_detalle_pago (id) ON DELETE RESTRICT,
    CONSTRAINT ck_cambio_cabecera_cargo CHECK (cargo_cambio >= 0),
    CONSTRAINT ck_cambio_cabecera_vigencia CHECK (fecha_expiracion > fecha_creacion),
    CONSTRAINT ck_cambio_cabecera_resolucion CHECK ((estado IN ('OFERTADO', 'PENDIENTE')) = (fecha_resolucion IS NULL))
);

CREATE TABLE cambio_detalle (
    id                     bigint         GENERATED ALWAYS AS IDENTITY,
    cambio_id              uuid           NOT NULL,
    reserva_itinerario_id  bigint         NOT NULL,
    itinerario_nuevo_id    uuid           NOT NULL,
    diferencia_tarifa      numeric(12,2)  NOT NULL,
    diferencia_impuestos   numeric(12,2)  NOT NULL,
    CONSTRAINT pk_cambio_detalle PRIMARY KEY (id),
    CONSTRAINT uq_cambio_detalle_itinerario UNIQUE (cambio_id, reserva_itinerario_id),
    CONSTRAINT fk_cambio_detalle_cabecera FOREIGN KEY (cambio_id) REFERENCES cambio_cabecera (id) ON DELETE CASCADE,
    CONSTRAINT fk_cambio_detalle_itinerario_original FOREIGN KEY (reserva_itinerario_id) REFERENCES reserva_detalle_itinerario (id) ON DELETE RESTRICT,
    CONSTRAINT fk_cambio_detalle_itinerario_nuevo FOREIGN KEY (itinerario_nuevo_id) REFERENCES itinerario_cabecera (id) ON DELETE RESTRICT
);

CREATE TABLE cotizacion_cancelacion (
    id                uuid           NOT NULL DEFAULT gen_random_uuid(),
    reserva_id        uuid           NOT NULL,
    monto_reembolso   numeric(12,2)  NOT NULL,
    monto_penalidad   numeric(12,2)  NOT NULL,
    fecha_creacion    timestamptz    NOT NULL DEFAULT now(),
    fecha_expiracion  timestamptz    NOT NULL,
    fecha_aceptacion  timestamptz,
    motivo            text,
    fecha_completada  timestamptz,
    CONSTRAINT pk_cotizacion_cancelacion PRIMARY KEY (id),
    CONSTRAINT fk_cotizacion_cancelacion_reserva FOREIGN KEY (reserva_id) REFERENCES reserva_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT ck_cotizacion_cancelacion_montos CHECK (monto_reembolso >= 0 AND monto_penalidad >= 0),
    CONSTRAINT ck_cotizacion_cancelacion_vigencia CHECK (fecha_expiracion > fecha_creacion),
    CONSTRAINT ck_cotizacion_cancelacion_aceptacion CHECK (fecha_aceptacion IS NULL OR fecha_aceptacion <= fecha_expiracion),
    CONSTRAINT ck_cotizacion_cancelacion_motivo CHECK (motivo IS NULL OR fecha_aceptacion IS NOT NULL),
    CONSTRAINT ck_cotizacion_cancelacion_completada CHECK (
        fecha_completada IS NULL
        OR (fecha_aceptacion IS NOT NULL AND fecha_completada >= fecha_aceptacion)
    )
);


-- =============================================================================
-- 10. CHECK-IN Y PASE DE ABORDAR
-- =============================================================================

CREATE TABLE checkin (
    id                   bigint          GENERATED ALWAYS AS IDENTITY,
    pasajero_id          bigint          NOT NULL,
    vuelo_programado_id  uuid            NOT NULL,
    estado               estado_checkin  NOT NULL,
    motivo_fallo         text,
    fecha_registro       timestamptz     NOT NULL DEFAULT now(),
    CONSTRAINT pk_checkin PRIMARY KEY (id),
    CONSTRAINT fk_checkin_pasajero FOREIGN KEY (pasajero_id) REFERENCES reserva_detalle_pasajero (id) ON DELETE RESTRICT,
    CONSTRAINT fk_checkin_vuelo_programado FOREIGN KEY (vuelo_programado_id) REFERENCES vuelo_programado (id) ON DELETE RESTRICT,
    CONSTRAINT ck_checkin_motivo_fallo CHECK (motivo_fallo IS NULL OR estado = 'FALLIDO')
);

CREATE TABLE pase_abordar (
    id                  bigint              GENERATED ALWAYS AS IDENTITY,
    checkin_id          bigint              NOT NULL,
    grupo_abordaje      text,
    posicion_abordaje   text,
    codigo_barras       text                NOT NULL,
    tipo_codigo_barras  tipo_codigo_barras  NOT NULL DEFAULT 'PDF417',
    fecha_emision       timestamptz         NOT NULL DEFAULT now(),
    CONSTRAINT pk_pase_abordar PRIMARY KEY (id),
    CONSTRAINT uq_pase_abordar_checkin UNIQUE (checkin_id),
    CONSTRAINT uq_pase_abordar_codigo_barras UNIQUE (codigo_barras),
    CONSTRAINT fk_pase_abordar_checkin FOREIGN KEY (checkin_id) REFERENCES checkin (id) ON DELETE RESTRICT,
    CONSTRAINT ck_pase_abordar_codigo_barras CHECK (btrim(codigo_barras) <> '')
);


-- =============================================================================
-- 11. WEBHOOKS Y EVENTOS
-- =============================================================================

CREATE TABLE webhook_cabecera (
    id              uuid         NOT NULL DEFAULT gen_random_uuid(),
    id_propietario  text         NOT NULL,
    url             text         NOT NULL,
    secreto         text         NOT NULL,
    activo          boolean      NOT NULL DEFAULT true,
    fecha_creacion  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_webhook_cabecera PRIMARY KEY (id),
    CONSTRAINT ck_webhook_cabecera_propietario CHECK (btrim(id_propietario) <> ''),
    CONSTRAINT ck_webhook_cabecera_url CHECK (url ~ '^https?://[^[:space:]]+$'),
    CONSTRAINT ck_webhook_cabecera_secreto CHECK (btrim(secreto) <> '')
);

CREATE TABLE webhook_detalle (
    id              bigint  GENERATED ALWAYS AS IDENTITY,
    webhook_id      uuid    NOT NULL,
    tipo_evento_id  bigint  NOT NULL,
    CONSTRAINT pk_webhook_detalle PRIMARY KEY (id),
    CONSTRAINT uq_webhook_detalle_evento UNIQUE (webhook_id, tipo_evento_id),
    CONSTRAINT fk_webhook_detalle_cabecera FOREIGN KEY (webhook_id) REFERENCES webhook_cabecera (id) ON DELETE CASCADE,
    CONSTRAINT fk_webhook_detalle_tipo_evento FOREIGN KEY (tipo_evento_id) REFERENCES tipo_evento (id) ON DELETE RESTRICT
);

CREATE TABLE evento (
    id              uuid         NOT NULL DEFAULT gen_random_uuid(),
    tipo_evento_id  bigint       NOT NULL,
    reserva_id      uuid,
    retencion_id    uuid,
    estado_reserva  estado_reserva,
    fecha_evento    timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_evento PRIMARY KEY (id),
    CONSTRAINT fk_evento_tipo_evento FOREIGN KEY (tipo_evento_id) REFERENCES tipo_evento (id) ON DELETE RESTRICT,
    CONSTRAINT fk_evento_reserva FOREIGN KEY (reserva_id) REFERENCES reserva_cabecera (id) ON DELETE RESTRICT,
    CONSTRAINT fk_evento_retencion FOREIGN KEY (retencion_id) REFERENCES retencion_cabecera (id) ON DELETE CASCADE,
    CONSTRAINT ck_evento_origen CHECK (num_nonnulls(reserva_id, retencion_id) = 1),
    CONSTRAINT ck_evento_estado_reserva CHECK (estado_reserva IS NULL OR reserva_id IS NOT NULL)
);

CREATE TABLE evento_entrega (
    id              bigint       GENERATED ALWAYS AS IDENTITY,
    evento_id       uuid         NOT NULL,
    webhook_id      uuid         NOT NULL,
    numero_intento  smallint     NOT NULL DEFAULT 1,
    codigo_http     smallint,
    entregado       boolean      NOT NULL DEFAULT false,
    fecha_intento   timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_evento_entrega PRIMARY KEY (id),
    CONSTRAINT uq_evento_entrega_intento UNIQUE (evento_id, webhook_id, numero_intento),
    CONSTRAINT fk_evento_entrega_evento FOREIGN KEY (evento_id) REFERENCES evento (id) ON DELETE CASCADE,
    CONSTRAINT fk_evento_entrega_webhook FOREIGN KEY (webhook_id) REFERENCES webhook_cabecera (id) ON DELETE CASCADE,
    CONSTRAINT ck_evento_entrega_intento CHECK (numero_intento >= 1),
    CONSTRAINT ck_evento_entrega_codigo_http CHECK (codigo_http BETWEEN 100 AND 599),
    CONSTRAINT ck_evento_entrega_entregado CHECK (NOT entregado OR COALESCE(codigo_http BETWEEN 200 AND 299, false))
);


-- =============================================================================
-- 12. IDEMPOTENCIA
-- =============================================================================

CREATE TABLE clave_idempotencia (
    id                bigint                 GENERATED ALWAYS AS IDENTITY,
    id_propietario    text                   NOT NULL,
    operacion         operacion_idempotente  NOT NULL,
    clave             uuid                   NOT NULL,
    huella_solicitud  varchar(64)            NOT NULL,
    codigo_http       smallint,
    respuesta         jsonb,
    fecha_creacion    timestamptz            NOT NULL DEFAULT now(),
    fecha_expiracion  timestamptz            NOT NULL,
    CONSTRAINT pk_clave_idempotencia PRIMARY KEY (id),
    CONSTRAINT uq_clave_idempotencia UNIQUE (id_propietario, operacion, clave),
    CONSTRAINT ck_clave_idempotencia_propietario CHECK (btrim(id_propietario) <> ''),
    CONSTRAINT ck_clave_idempotencia_huella CHECK (huella_solicitud ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_clave_idempotencia_codigo_http CHECK (codigo_http BETWEEN 100 AND 599),
    CONSTRAINT ck_clave_idempotencia_respuesta CHECK (respuesta IS NULL OR codigo_http IS NOT NULL),
    CONSTRAINT ck_clave_idempotencia_vigencia CHECK (fecha_expiracion > fecha_creacion)
);


-- =============================================================================
-- 13. AUDITORÍA (log de cambios)
--     Un disparador genérico escribe en "auditoria" cada alta, cambio y baja de
--     las tablas de negocio. La API no inserta aquí: solo dice quién actúa,
--     dentro de la misma transacción que el cambio:
--
--         SELECT set_config('app.id_usuario',   '<sub del JWT>', true);
--         SELECT set_config('app.direccion_ip', '<IP del cliente>', true);
--
--     El tercer parámetro en true limita el valor a la transacción en curso,
--     que es lo correcto cuando las conexiones se comparten en un pool.
--     Para cargas masivas (semilla) se apaga con: SET LOCAL app.auditoria = 'off';
--
--     No se auditan las tablas efímeras o de alto volumen (ofertas, itinerarios,
--     inventario, eventos, entregas, idempotencia) ni el historial de la reserva,
--     que ya es una bitácora.
-- =============================================================================

CREATE TABLE auditoria (
    id                bigint               GENERATED ALWAYS AS IDENTITY,
    fecha_evento      timestamptz          NOT NULL DEFAULT now(),
    nombre_tabla      text                 NOT NULL,
    operacion         operacion_auditoria  NOT NULL,
    id_registro       text                 NOT NULL,
    id_usuario        text,
    usuario_bd        text                 NOT NULL DEFAULT session_user,
    direccion_ip      inet,
    datos_anteriores  jsonb,
    datos_nuevos      jsonb,
    CONSTRAINT pk_auditoria PRIMARY KEY (id),
    CONSTRAINT ck_auditoria_nombre_tabla CHECK (nombre_tabla ~ '^[a-z_]+$'),
    CONSTRAINT ck_auditoria_id_registro CHECK (btrim(id_registro) <> ''),
    CONSTRAINT ck_auditoria_datos CHECK (
           (operacion = 'INSERCION'     AND datos_anteriores IS NULL     AND datos_nuevos IS NOT NULL)
        OR (operacion = 'ACTUALIZACION' AND datos_anteriores IS NOT NULL AND datos_nuevos IS NOT NULL)
        OR (operacion = 'ELIMINACION'   AND datos_anteriores IS NOT NULL AND datos_nuevos IS NULL)
    )
);

CREATE INDEX ix_auditoria_registro ON auditoria (nombre_tabla, id_registro, fecha_evento);
CREATE INDEX ix_auditoria_fecha_evento ON auditoria (fecha_evento);
CREATE INDEX ix_auditoria_usuario ON auditoria (id_usuario, fecha_evento) WHERE id_usuario IS NOT NULL;

CREATE FUNCTION fn_auditar() RETURNS trigger
LANGUAGE plpgsql
SET search_path = vuelos, pg_temp
AS $$
DECLARE
    v_operacion  operacion_auditoria;
    v_anterior   jsonb;
    v_nuevo      jsonb;
    v_id         text;
    v_ip_texto   text := NULLIF(current_setting('app.direccion_ip', true), '');
    v_ip         inet;
BEGIN
    IF current_setting('app.auditoria', true) = 'off' THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'INSERT' THEN
        v_operacion := 'INSERCION';
        v_nuevo     := to_jsonb(NEW);
        v_id        := v_nuevo ->> 'id';
    ELSIF TG_OP = 'DELETE' THEN
        v_operacion := 'ELIMINACION';
        v_anterior  := to_jsonb(OLD);
        v_id        := v_anterior ->> 'id';
    ELSE
        v_operacion := 'ACTUALIZACION';
        v_id        := to_jsonb(NEW) ->> 'id';
        -- solo las columnas que cambiaron: el valor de antes y el de después
        SELECT jsonb_object_agg(n.key, a.value), jsonb_object_agg(n.key, n.value)
          INTO v_anterior, v_nuevo
        FROM jsonb_each(to_jsonb(NEW)) AS n
        JOIN jsonb_each(to_jsonb(OLD)) AS a USING (key)
        WHERE n.value IS DISTINCT FROM a.value;

        IF v_nuevo IS NULL THEN
            RETURN NULL;   -- UPDATE que no cambió ningún valor
        END IF;
    END IF;

    -- el secreto de un webhook nunca se copia al log
    IF v_anterior ? 'secreto' THEN v_anterior := v_anterior || '{"secreto": "***"}'; END IF;
    IF v_nuevo    ? 'secreto' THEN v_nuevo    := v_nuevo    || '{"secreto": "***"}'; END IF;

    -- una IP mal formada no debe tumbar la operación de negocio
    IF v_ip_texto IS NOT NULL THEN
        BEGIN
            v_ip := v_ip_texto::inet;
        EXCEPTION WHEN OTHERS THEN
            v_ip := NULL;
        END;
    END IF;

    INSERT INTO auditoria (nombre_tabla, operacion, id_registro, id_usuario, direccion_ip, datos_anteriores, datos_nuevos)
    VALUES (TG_TABLE_NAME, v_operacion, v_id,
            NULLIF(current_setting('app.id_usuario', true), ''), v_ip, v_anterior, v_nuevo);

    RETURN NULL;
END;
$$;

DO $$
DECLARE
    v_tabla text;
BEGIN
    FOREACH v_tabla IN ARRAY ARRAY[
        'pais', 'ciudad', 'aeropuerto', 'aerolinea', 'modelo_aeronave', 'moneda', 'familia_tarifa', 'tipo_evento',
        'mapa_asientos_cabecera', 'vuelo', 'vuelo_programado', 'tarifa_cabecera', 'tarifa_detalle',
        'retencion_cabecera',
        'reserva_cabecera', 'reserva_detalle_itinerario', 'reserva_detalle_pasajero', 'reserva_detalle_asiento',
        'reserva_detalle_pago', 'reserva_detalle_equipaje',
        'boleto_cabecera', 'boleto_detalle', 'cambio_cabecera', 'cotizacion_cancelacion',
        'checkin', 'pase_abordar', 'webhook_cabecera', 'webhook_detalle'
    ] LOOP
        EXECUTE format(
            'CREATE TRIGGER tg_%s_auditoria AFTER INSERT OR UPDATE OR DELETE ON vuelos.%I '
            'FOR EACH ROW EXECUTE FUNCTION vuelos.fn_auditar()', v_tabla, v_tabla);
    END LOOP;
END;
$$;

-- El log solo crece: nadie edita ni borra filas de auditoría.
CREATE FUNCTION fn_auditoria_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'La tabla auditoria es de solo inserción'
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER tg_auditoria_inmutable
    BEFORE UPDATE OR DELETE ON auditoria
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria_inmutable();

CREATE TRIGGER tg_auditoria_sin_truncate
    BEFORE TRUNCATE ON auditoria
    FOR EACH STATEMENT EXECUTE FUNCTION fn_auditoria_inmutable();


-- =============================================================================
-- 14. ÍNDICES
--     Las FK que ya son la primera columna de una PK o UNIQUE no se repiten.
--     Tampoco se indexan las FK hacia catálogos diminutos (moneda, país) porque
--     no filtran nada y sus filas no se borran.
-- =============================================================================

-- Unicidad condicionada (reglas de negocio que una UNIQUE normal no expresa)
CREATE UNIQUE INDEX uq_reserva_detalle_itinerario_orden_vigente
    ON reserva_detalle_itinerario (reserva_id, orden) WHERE vigente;
CREATE UNIQUE INDEX uq_reserva_detalle_pasajero_infante_por_adulto
    ON reserva_detalle_pasajero (adulto_responsable_id) WHERE tipo_pasajero = 'INFANTE';
CREATE UNIQUE INDEX uq_reserva_detalle_asiento_ocupado
    ON reserva_detalle_asiento (vuelo_programado_id, asiento_id) WHERE fecha_liberacion IS NULL;
CREATE UNIQUE INDEX uq_reserva_detalle_asiento_pasajero_vuelo
    ON reserva_detalle_asiento (pasajero_id, vuelo_programado_id) WHERE fecha_liberacion IS NULL;
CREATE UNIQUE INDEX uq_reserva_detalle_pago_emision
    ON reserva_detalle_pago (reserva_id) WHERE concepto = 'EMISION';
CREATE UNIQUE INDEX uq_boleto_cabecera_activo_por_pasajero
    ON boleto_cabecera (pasajero_id) WHERE estado IN ('PENDIENTE', 'EMITIENDO', 'EMITIDO');
CREATE UNIQUE INDEX uq_cotizacion_cancelacion_aceptada
    ON cotizacion_cancelacion (reserva_id) WHERE fecha_aceptacion IS NOT NULL;
CREATE UNIQUE INDEX uq_checkin_registrado
    ON checkin (pasajero_id, vuelo_programado_id) WHERE estado = 'REGISTRADO';
CREATE UNIQUE INDEX uq_webhook_cabecera_propietario_url
    ON webhook_cabecera (id_propietario, url) WHERE activo;

-- Catálogos y mapas de asientos
CREATE INDEX ix_aeropuerto_ciudad ON aeropuerto (ciudad_id);
CREATE INDEX ix_mapa_asientos_cabecera_modelo ON mapa_asientos_cabecera (modelo_aeronave_id);

-- Vuelos e inventario
CREATE INDEX ix_vuelo_ruta ON vuelo (aeropuerto_origen_id, aeropuerto_destino_id) WHERE activo;
CREATE INDEX ix_vuelo_aeropuerto_destino ON vuelo (aeropuerto_destino_id);
CREATE INDEX ix_vuelo_aerolinea_operadora ON vuelo (aerolinea_operadora_id);
CREATE INDEX ix_vuelo_programado_fecha_salida ON vuelo_programado (fecha_salida);
CREATE INDEX ix_vuelo_programado_salida_programada ON vuelo_programado (salida_programada);
CREATE INDEX ix_vuelo_programado_mapa_asientos ON vuelo_programado (mapa_asientos_id);
CREATE INDEX ix_tarifa_cabecera_familia_tarifa ON tarifa_cabecera (familia_tarifa_id);

-- Itinerarios y ofertas
CREATE INDEX ix_itinerario_detalle_vuelo_programado ON itinerario_detalle (vuelo_programado_id);
CREATE INDEX ix_oferta_cabecera_fecha_expiracion ON oferta_cabecera (fecha_expiracion);
CREATE INDEX ix_oferta_cabecera_aerolinea ON oferta_cabecera (aerolinea_id);
CREATE INDEX ix_oferta_detalle_itinerario ON oferta_detalle (itinerario_id);

-- Retenciones
CREATE INDEX ix_retencion_cabecera_oferta ON retencion_cabecera (oferta_id);
CREATE INDEX ix_retencion_cabecera_propietario ON retencion_cabecera (id_propietario, fecha_creacion DESC);
CREATE INDEX ix_retencion_cabecera_por_expirar ON retencion_cabecera (fecha_expiracion) WHERE estado = 'RETENIDA';
CREATE INDEX ix_retencion_detalle_itinerario ON retencion_detalle (itinerario_id);
CREATE INDEX ix_retencion_detalle_familia_tarifa ON retencion_detalle (familia_tarifa_id);

-- Reservas
CREATE INDEX ix_reserva_cabecera_listado ON reserva_cabecera (fecha_creacion DESC, id DESC);
CREATE INDEX ix_reserva_cabecera_en_proceso ON reserva_cabecera (estado, fecha_actualizacion)
    WHERE estado IN ('PENDIENTE', 'PENDIENTE_PAGO', 'EMITIENDO_BOLETOS', 'CAMBIO_PENDIENTE', 'CANCELACION_PENDIENTE');
CREATE INDEX ix_reserva_detalle_itinerario_itinerario ON reserva_detalle_itinerario (itinerario_id);
CREATE INDEX ix_reserva_detalle_itinerario_familia ON reserva_detalle_itinerario (familia_tarifa_id);
CREATE INDEX ix_reserva_detalle_pasajero_adulto ON reserva_detalle_pasajero (adulto_responsable_id) WHERE adulto_responsable_id IS NOT NULL;
CREATE INDEX ix_reserva_detalle_pasajero_documento ON reserva_detalle_pasajero (tipo_documento, numero_documento);
CREATE INDEX ix_reserva_detalle_asiento_asiento ON reserva_detalle_asiento (asiento_id);
CREATE INDEX ix_reserva_detalle_asiento_pasajero ON reserva_detalle_asiento (pasajero_id);
CREATE INDEX ix_reserva_detalle_pago_reserva ON reserva_detalle_pago (reserva_id);
CREATE INDEX ix_reserva_detalle_equipaje_pasajero ON reserva_detalle_equipaje (pasajero_id);
CREATE INDEX ix_reserva_detalle_equipaje_itinerario ON reserva_detalle_equipaje (reserva_itinerario_id);
CREATE INDEX ix_reserva_detalle_equipaje_pago ON reserva_detalle_equipaje (pago_id);
CREATE INDEX ix_reserva_detalle_historial_reserva ON reserva_detalle_historial (reserva_id, fecha_evento);

-- Boletos
CREATE INDEX ix_boleto_cabecera_pasajero ON boleto_cabecera (pasajero_id);
CREATE INDEX ix_boleto_detalle_vuelo_programado ON boleto_detalle (vuelo_programado_id);

-- Postventa
CREATE INDEX ix_cambio_cabecera_reserva ON cambio_cabecera (reserva_id);
CREATE INDEX ix_cambio_detalle_itinerario_original ON cambio_detalle (reserva_itinerario_id);
CREATE INDEX ix_cambio_detalle_itinerario_nuevo ON cambio_detalle (itinerario_nuevo_id);
CREATE INDEX ix_cotizacion_cancelacion_reserva ON cotizacion_cancelacion (reserva_id);

-- Check-in
CREATE INDEX ix_checkin_pasajero ON checkin (pasajero_id);
CREATE INDEX ix_checkin_vuelo_programado ON checkin (vuelo_programado_id);

-- Webhooks, eventos e idempotencia
CREATE INDEX ix_webhook_detalle_tipo_evento ON webhook_detalle (tipo_evento_id);
CREATE INDEX ix_evento_reserva ON evento (reserva_id) WHERE reserva_id IS NOT NULL;
CREATE INDEX ix_evento_retencion ON evento (retencion_id) WHERE retencion_id IS NOT NULL;
CREATE INDEX ix_evento_tipo_fecha ON evento (tipo_evento_id, fecha_evento);
CREATE INDEX ix_evento_entrega_webhook ON evento_entrega (webhook_id);
CREATE INDEX ix_evento_entrega_pendiente ON evento_entrega (fecha_intento) WHERE NOT entregado;
CREATE INDEX ix_clave_idempotencia_fecha_expiracion ON clave_idempotencia (fecha_expiracion);


-- =============================================================================
-- 15. INTEGRIDAD ENTRE ENTIDADES (reglas que una FK o un CHECK no alcanzan)
--     Todas lanzan check_violation (SQLSTATE 23514) con nombre de restricción.
-- =============================================================================

CREATE FUNCTION fn_marcar_actualizacion() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.fecha_actualizacion := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_reserva_cabecera_actualizacion
    BEFORE UPDATE ON reserva_cabecera
    FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizacion();

-- El asiento debe pertenecer al mapa de la aeronave del vuelo y un infante no ocupa asiento.
CREATE FUNCTION fn_validar_asiento_reserva() RETURNS trigger
LANGUAGE plpgsql
SET search_path = vuelos, pg_temp
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM reserva_detalle_pasajero p
        WHERE p.id = NEW.pasajero_id
          AND p.tipo_pasajero = 'INFANTE'
    ) THEN
        RAISE EXCEPTION 'Un infante no ocupa asiento (pasajero %)', NEW.pasajero_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_reserva_detalle_asiento_infante';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM vuelo_programado vp
        JOIN mapa_asientos_detalle f ON f.mapa_asientos_id = vp.mapa_asientos_id
        JOIN asiento a ON a.mapa_asientos_detalle_id = f.id
        WHERE vp.id = NEW.vuelo_programado_id
          AND a.id = NEW.asiento_id
    ) THEN
        RAISE EXCEPTION 'El asiento % no pertenece al mapa de asientos del vuelo %', NEW.asiento_id, NEW.vuelo_programado_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_reserva_detalle_asiento_mapa';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_reserva_detalle_asiento_validar
    BEFORE INSERT OR UPDATE OF pasajero_id, vuelo_programado_id, asiento_id ON reserva_detalle_asiento
    FOR EACH ROW EXECUTE FUNCTION fn_validar_asiento_reserva();

-- El adulto responsable debe ser un ADULTO de la misma reserva.
CREATE FUNCTION fn_validar_adulto_responsable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = vuelos, pg_temp
AS $$
BEGIN
    IF NEW.adulto_responsable_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM reserva_detalle_pasajero a
        WHERE a.id = NEW.adulto_responsable_id
          AND a.reserva_id = NEW.reserva_id
          AND a.tipo_pasajero = 'ADULTO'
    ) THEN
        RAISE EXCEPTION 'El adulto responsable % no es un adulto de la reserva %', NEW.adulto_responsable_id, NEW.reserva_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_reserva_detalle_pasajero_adulto';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_reserva_detalle_pasajero_validar
    BEFORE INSERT OR UPDATE OF reserva_id, adulto_responsable_id ON reserva_detalle_pasajero
    FOR EACH ROW EXECUTE FUNCTION fn_validar_adulto_responsable();

-- El pasajero, el itinerario y el pago de una maleta adicional deben ser de la misma reserva.
CREATE FUNCTION fn_validar_equipaje_reserva() RETURNS trigger
LANGUAGE plpgsql
SET search_path = vuelos, pg_temp
AS $$
DECLARE
    v_reserva_id uuid;
BEGIN
    SELECT p.reserva_id INTO v_reserva_id
    FROM reserva_detalle_pasajero p
    WHERE p.id = NEW.pasajero_id;

    IF NOT EXISTS (
        SELECT 1 FROM reserva_detalle_itinerario i
        WHERE i.id = NEW.reserva_itinerario_id AND i.reserva_id = v_reserva_id
    ) OR NOT EXISTS (
        SELECT 1 FROM reserva_detalle_pago g
        WHERE g.id = NEW.pago_id AND g.reserva_id = v_reserva_id
    ) THEN
        RAISE EXCEPTION 'El pasajero, el itinerario y el pago del equipaje deben pertenecer a la misma reserva'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_reserva_detalle_equipaje_reserva';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_reserva_detalle_equipaje_validar
    BEFORE INSERT OR UPDATE OF pasajero_id, reserva_itinerario_id, pago_id ON reserva_detalle_equipaje
    FOR EACH ROW EXECUTE FUNCTION fn_validar_equipaje_reserva();


-- =============================================================================
-- 16. VISTAS DE VALORES DERIVADOS (lo que 3FN prohíbe guardar)
-- =============================================================================

CREATE VIEW vista_vuelo_programado AS
SELECT vp.id                         AS vuelo_programado_id,
       ac.codigo_iata || v.numero    AS codigo_vuelo,
       vp.fecha_salida,
       ac.codigo_iata                AS aerolinea_comercial,
       ao.codigo_iata                AS aerolinea_operadora,
       org.codigo_iata               AS origen,
       dst.codigo_iata               AS destino,
       ma.codigo_iata                AS aeronave,
       vp.salida_programada,
       vp.llegada_programada,
       (EXTRACT(EPOCH FROM (vp.llegada_programada - vp.salida_programada)) / 60)::integer AS duracion_minutos,
       vp.terminal_salida,
       vp.terminal_llegada,
       vp.estado
FROM vuelo_programado vp
JOIN vuelo v                    ON v.id   = vp.vuelo_id
JOIN aerolinea ac               ON ac.id  = v.aerolinea_id
JOIN aerolinea ao               ON ao.id  = v.aerolinea_operadora_id
JOIN aeropuerto org             ON org.id = v.aeropuerto_origen_id
JOIN aeropuerto dst             ON dst.id = v.aeropuerto_destino_id
JOIN mapa_asientos_cabecera mc  ON mc.id  = vp.mapa_asientos_id
JOIN modelo_aeronave ma         ON ma.id  = mc.modelo_aeronave_id;

CREATE VIEW vista_retencion_precio AS
SELECT r.id                                                                          AS retencion_id,
       m.codigo_iso                                                                  AS moneda,
       COALESCE(SUM(d.tarifa_base_congelada), 0)::numeric(12,2)                      AS tarifa_base,
       COALESCE(SUM(d.impuestos_congelados), 0)::numeric(12,2)                       AS impuestos,
       COALESCE(SUM(d.tarifa_base_congelada + d.impuestos_congelados), 0)::numeric(12,2) AS total
FROM retencion_cabecera r
JOIN moneda m                 ON m.id = r.moneda_id
LEFT JOIN retencion_detalle d ON d.retencion_id = r.id
GROUP BY r.id, m.codigo_iso;

CREATE VIEW vista_reserva_total AS
SELECT rc.id                                                AS reserva_id,
       rc.pnr,
       m.codigo_iso                                         AS moneda,
       COALESCE(i.tarifa_base, 0)::numeric(12,2)            AS tarifa_base,
       COALESCE(i.impuestos, 0)::numeric(12,2)              AS impuestos,
       COALESCE(e.equipaje, 0)::numeric(12,2)               AS equipaje_adicional,
       COALESCE(c.cargos, 0)::numeric(12,2)                 AS cargos_cambio,
       (COALESCE(i.tarifa_base, 0) + COALESCE(i.impuestos, 0)
        + COALESCE(e.equipaje, 0) + COALESCE(c.cargos, 0))::numeric(12,2) AS total
FROM reserva_cabecera rc
JOIN retencion_cabecera rt ON rt.id = rc.retencion_id
JOIN moneda m              ON m.id  = rt.moneda_id
LEFT JOIN (
    SELECT reserva_id, SUM(tarifa_base) AS tarifa_base, SUM(impuestos) AS impuestos
    FROM reserva_detalle_itinerario
    WHERE vigente
    GROUP BY reserva_id
) i ON i.reserva_id = rc.id
LEFT JOIN (
    SELECT p.reserva_id, SUM(q.cantidad * q.precio_unitario) AS equipaje
    FROM reserva_detalle_equipaje q
    JOIN reserva_detalle_pasajero p ON p.id = q.pasajero_id
    GROUP BY p.reserva_id
) e ON e.reserva_id = rc.id
LEFT JOIN (
    SELECT reserva_id, SUM(cargo_cambio) AS cargos
    FROM cambio_cabecera
    WHERE estado = 'CONFIRMADO'
    GROUP BY reserva_id
) c ON c.reserva_id = rc.id;


-- =============================================================================
-- 17. COMENTARIOS
-- =============================================================================

COMMENT ON TABLE pais                       IS 'Países ISO 3166-1. Se usa para la nacionalidad del pasajero y para ubicar ciudades.';
COMMENT ON TABLE ciudad                     IS 'Ciudades servidas. La zona horaria vive aquí porque depende de la ciudad, no del aeropuerto.';
COMMENT ON TABLE aeropuerto                 IS 'Aeropuertos identificados por código IATA.';
COMMENT ON TABLE aerolinea                  IS 'Aerolíneas comercializadoras u operadoras.';
COMMENT ON TABLE modelo_aeronave            IS 'Tipos de aeronave (campo aircraft del contrato).';
COMMENT ON TABLE moneda                     IS 'Monedas ISO 4217. La operación en Ecuador es en USD.';
COMMENT ON TABLE familia_tarifa             IS 'Marca tarifaria de una aerolínea en una cabina (fareBrand) con sus reglas y equipaje incluido.';
COMMENT ON TABLE tipo_evento                IS 'Catálogo de eventos que se pueden suscribir por webhook. Es tabla y no ENUM porque el contrato lo ha ido ampliando.';
COMMENT ON TABLE mapa_asientos_cabecera     IS 'Configuración de cabina de un modelo de aeronave para una aerolínea.';
COMMENT ON TABLE mapa_asientos_detalle      IS 'Una fila del mapa de asientos. La cabina y las características dependen de la fila, no de cada butaca.';
COMMENT ON TABLE asiento                    IS 'Butaca de una fila. El número de asiento del contrato es numero_fila concatenado con letra.';
COMMENT ON TABLE vuelo                      IS 'Vuelo comercial: aerolínea, número y ruta. No tiene fecha.';
COMMENT ON TABLE vuelo_programado           IS 'Salida concreta de un vuelo en una fecha. Es el segmento del contrato y la fuente de GET /flights/{flightNumber}/status.';
COMMENT ON TABLE inventario_cabina          IS 'Cupo de una cabina en un vuelo programado. Todas las familias tarifarias de esa cabina venden del mismo cupo, así no se sobrevende la cabina.';
COMMENT ON TABLE tarifa_cabecera            IS 'Producto vendible: un vuelo programado en una familia tarifaria. Su cupo es el de la cabina (inventario_cabina).';
COMMENT ON TABLE tarifa_detalle             IS 'Precio de la tarifa por tipo de pasajero (pricePerPassengerType).';
COMMENT ON TABLE itinerario_cabecera        IS 'Trayecto origen-destino armado con uno o más vuelos. Lo comparten ofertas, retenciones, reservas y cambios.';
COMMENT ON TABLE itinerario_detalle         IS 'Vuelos programados que componen un itinerario, en orden.';
COMMENT ON TABLE oferta_cabecera            IS 'Oferta devuelta por POST /search. Es efímera: se purga al expirar si ninguna retención la referencia.';
COMMENT ON TABLE oferta_detalle             IS 'Itinerarios que componen una oferta (uno por tramo solicitado en la búsqueda).';
COMMENT ON TABLE retencion_cabecera         IS 'Bloqueo temporal de cupos con precio congelado (hold).';
COMMENT ON TABLE retencion_detalle          IS 'Itinerario y familia tarifaria elegidos en la retención, con su precio congelado.';
COMMENT ON TABLE reserva_cabecera           IS 'Reserva con su localizador PNR. Nace al consumir una retención.';
COMMENT ON TABLE reserva_detalle_itinerario IS 'Itinerarios de la reserva con la tarifa vendida. Un cambio de fecha apaga la línea original y agrega otra.';
COMMENT ON TABLE reserva_detalle_pasajero   IS 'Pasajeros de la reserva con los datos del documento tal como se emitieron.';
COMMENT ON TABLE reserva_detalle_asiento    IS 'Asiento asignado a un pasajero en un vuelo programado.';
COMMENT ON TABLE reserva_detalle_pago       IS 'Referencias de pago emitidas por la Payment API. Aquí no se guardan montos ni datos de tarjeta.';
COMMENT ON TABLE reserva_detalle_equipaje   IS 'Maletas adicionales compradas por pasajero e itinerario.';
COMMENT ON TABLE reserva_detalle_historial  IS 'Bitácora de la reserva (campo changes del contrato) y de sus transiciones de estado.';
COMMENT ON TABLE boleto_cabecera            IS 'Boleto electrónico de un pasajero.';
COMMENT ON TABLE boleto_detalle             IS 'Cupones del boleto, uno por vuelo programado.';
COMMENT ON TABLE cambio_cabecera            IS 'Oferta de cambio de fecha y su resolución.';
COMMENT ON TABLE cambio_detalle             IS 'Itinerario de la reserva que se reemplaza y el itinerario nuevo propuesto.';
COMMENT ON TABLE cotizacion_cancelacion     IS 'Cotización de cancelación. Cuando se acepta pasa a ser la cancelación de la reserva.';
COMMENT ON TABLE checkin                    IS 'Intento de check-in de un pasajero en un vuelo programado.';
COMMENT ON TABLE pase_abordar               IS 'Pase de abordar emitido tras un check-in registrado.';
COMMENT ON TABLE webhook_cabecera           IS 'Suscripción de un integrador a notificaciones.';
COMMENT ON TABLE webhook_detalle            IS 'Tipos de evento a los que está suscrito un webhook.';
COMMENT ON TABLE evento                     IS 'Hecho de negocio ocurrido que debe notificarse (bandeja de salida).';
COMMENT ON TABLE evento_entrega             IS 'Intentos de entrega de un evento a un webhook.';
COMMENT ON TABLE clave_idempotencia         IS 'Registro de las cabeceras Idempotency-Key ya procesadas y su respuesta.';
COMMENT ON TABLE auditoria                  IS 'Log de cambios: una fila por cada alta, cambio o baja en las tablas de negocio. La escribe el disparador fn_auditar y es de solo inserción. No es el historial que ve el cliente: ese es reserva_detalle_historial.';

COMMENT ON COLUMN pais.codigo_iso3 IS 'Alfa-3, el formato que usan los pasaportes. El contrato no fija formato para nationality: la API puede aceptar alfa-2 o alfa-3.';
COMMENT ON COLUMN ciudad.zona_horaria IS 'Zona horaria IANA. America/Guayaquil para el continente y Pacific/Galapagos para Galápagos.';
COMMENT ON COLUMN aerolinea.prefijo_boleto IS 'Código numérico de 3 dígitos con el que empiezan los boletos electrónicos de la aerolínea.';
COMMENT ON COLUMN familia_tarifa.codigo IS 'fareBrand del contrato, en mayúsculas.';
COMMENT ON COLUMN familia_tarifa.porcentaje_penalidad_cancelacion IS 'Porcentaje que se retiene al cancelar. 100 significa no reembolsable: isRefundable del contrato es (porcentaje < 100).';
COMMENT ON COLUMN familia_tarifa.maximo_equipaje_adicional IS 'Tope de maletas adicionales por pasajero e itinerario (maxAllowed).';
COMMENT ON COLUMN mapa_asientos_detalle.espacio_extra IS 'Característica EXTRA_LEGROOM del contrato.';
COMMENT ON COLUMN mapa_asientos_detalle.salida_emergencia IS 'Característica EMERGENCY_EXIT del contrato.';
COMMENT ON COLUMN vuelo.aerolinea_id IS 'Aerolínea que comercializa el vuelo (marketingCarrier). Su código IATA más "numero" forma el flightNumber.';
COMMENT ON COLUMN vuelo.aerolinea_operadora_id IS 'Aerolínea que opera el vuelo (operatingCarrier). Difiere de aerolinea_id en código compartido.';
COMMENT ON COLUMN vuelo.numero IS 'Parte numérica del número de vuelo, sin ceros a la izquierda.';
COMMENT ON COLUMN vuelo_programado.id IS 'segmentId del contrato.';
COMMENT ON COLUMN vuelo_programado.fecha_salida IS 'Fecha local de salida en el aeropuerto de origen. Junto con vuelo_id identifica la salida y es el parámetro date del estado de vuelo.';
COMMENT ON COLUMN vuelo_programado.salida_programada IS 'Instante exacto de salida. La duración y las escalas se calculan, no se guardan.';
COMMENT ON COLUMN vuelo_programado.mapa_asientos_id IS 'Configuración de la aeronave asignada a esta salida. De aquí salen el tipo de aeronave y el mapa de asientos.';
COMMENT ON COLUMN inventario_cabina.cupos_totales IS 'Cupo que se vende. Puede ser menor que los asientos físicos de la cabina.';
COMMENT ON COLUMN inventario_cabina.cupos_disponibles IS 'Contador de inventario (availableSeats). Se descuenta al retener y se devuelve al liberar, expirar o cancelar, siempre con UPDATE condicionado en una transacción. Es la fila que se bloquea para que dos retenciones no vendan el mismo cupo.';
COMMENT ON COLUMN tarifa_cabecera.precio_equipaje_adicional IS 'Precio por maleta adicional (extraCheckedBaggagePrice).';
COMMENT ON COLUMN tarifa_cabecera.cargo_cambio IS 'Cargo por cambio de fecha (changeFee) en la moneda de la tarifa.';
COMMENT ON COLUMN tarifa_detalle.impuestos IS 'Impuestos y tasas por pasajero (IVA y tasas aeroportuarias). El total es tarifa_base + impuestos y no se guarda.';
COMMENT ON COLUMN oferta_cabecera.aerolinea_id IS 'Aerolínea que respalda la oferta (campo airline).';
COMMENT ON COLUMN oferta_cabecera.huella_dispositivo IS 'Valor de la cabecera X-Device-Fingerprint de la búsqueda.';
COMMENT ON COLUMN retencion_cabecera.id_propietario IS 'Claim sub del JWT. Es el dueño de la retención y de la reserva que nazca de ella. No tiene FK porque los clientes son de otro dominio.';
COMMENT ON COLUMN retencion_cabecera.infantes IS 'Infantes en brazos: no consumen cupo y no pueden superar a los adultos.';
COMMENT ON COLUMN retencion_cabecera.fecha_cierre IS 'Momento en que dejó de estar RETENIDA (liberada, expirada o consumida). El ttlMinutes del contrato se calcula con fecha_expiracion.';
COMMENT ON COLUMN retencion_detalle.tarifa_base_congelada IS 'Tarifa base del itinerario para todos los pasajeros de la retención, congelada al retener. La suma de las líneas es lockedPrice.';
COMMENT ON COLUMN reserva_cabecera.retencion_id IS 'Retención consumida. Es única: una retención produce a lo sumo una reserva. El dueño y la moneda se leen de ella.';
COMMENT ON COLUMN reserva_cabecera.pnr IS 'Localizador de 6 caracteres alfanuméricos en mayúsculas.';
COMMENT ON COLUMN reserva_detalle_itinerario.tarifa_base IS 'Tarifa base vendida del itinerario para todos los pasajeros. Tras un cambio de fecha incluye la diferencia cobrada.';
COMMENT ON COLUMN reserva_detalle_itinerario.vigente IS 'false cuando un cambio de fecha confirmado reemplazó esta línea.';
COMMENT ON COLUMN reserva_detalle_pasajero.codigo_pasajero IS 'passengerId que envía el cliente. Solo es único dentro de la reserva.';
COMMENT ON COLUMN reserva_detalle_pasajero.adulto_responsable_id IS 'associatedAdultId. Obligatorio para infantes: debe ser un adulto de la misma reserva y cada adulto lleva un solo infante.';
COMMENT ON COLUMN reserva_detalle_pasajero.numero_documento IS 'Sin espacios ni guiones, en mayúsculas. El dígito verificador de la cédula ecuatoriana se valida en la aplicación.';
COMMENT ON COLUMN reserva_detalle_pasajero.telefono IS 'Solo dígitos con + opcional. Formato recomendado E.164 (+593...).';
COMMENT ON COLUMN reserva_detalle_asiento.fecha_liberacion IS 'NULL mientras el asiento está ocupado. Se llena al cancelar o al cambiar de asiento o de fecha.';
COMMENT ON COLUMN reserva_detalle_pago.referencia_pago IS 'paymentReference. Es única en todo el sistema: un mismo pago no acredita dos operaciones.';
COMMENT ON COLUMN reserva_detalle_equipaje.precio_unitario IS 'Precio por maleta congelado al momento de la compra.';
COMMENT ON COLUMN boleto_cabecera.numero_boleto IS 'eTicketNumber de 13 dígitos. NULL hasta que se emite.';
COMMENT ON COLUMN boleto_detalle.numero_cupon IS 'couponNumber del contrato. NULL hasta que el cupón se emite.';
COMMENT ON COLUMN cambio_cabecera.pago_id IS 'Pago de la diferencia. Puede ser NULL si el cambio no tiene costo.';
COMMENT ON COLUMN cambio_detalle.diferencia_tarifa IS 'fareDifference. Puede ser negativa si la tarifa nueva es menor. El totalToPay se calcula sumando diferencias y cargo_cambio.';
COMMENT ON COLUMN cotizacion_cancelacion.fecha_aceptacion IS 'Momento en que POST /cancel aceptó la cotización. Debe caer dentro de su vigencia y solo una por reserva puede estar aceptada.';
COMMENT ON COLUMN cotizacion_cancelacion.fecha_completada IS 'NULL mientras la reserva sigue en CANCELACION_PENDIENTE.';
COMMENT ON COLUMN webhook_cabecera.secreto IS 'Secreto para firmar los envíos con HMAC. Se necesita en claro para firmar, así que debe cifrarse en la aplicación antes de guardarse.';
COMMENT ON COLUMN evento.estado_reserva IS 'Estado de la reserva en el momento del evento, para que un reintento envíe el mismo dato.';
COMMENT ON COLUMN clave_idempotencia.huella_solicitud IS 'SHA-256 en hexadecimal del cuerpo de la solicitud. Detecta la misma clave con un cuerpo distinto.';
COMMENT ON COLUMN clave_idempotencia.respuesta IS 'Cuerpo de la respuesta original para devolverlo tal cual en un reintento. Es jsonb porque su forma depende de la operación.';

COMMENT ON COLUMN auditoria.nombre_tabla IS 'Tabla del esquema vuelos donde ocurrió el cambio. No lleva FK: el log apunta a cualquier tabla.';
COMMENT ON COLUMN auditoria.id_registro IS 'Valor de la columna id de la fila afectada, como texto, porque unas tablas usan uuid y otras bigint.';
COMMENT ON COLUMN auditoria.id_usuario IS 'Claim sub del JWT de quien hizo el cambio. Lo fija la API con set_config(''app.id_usuario'', ...). NULL si el cambio vino de un proceso interno o de un script.';
COMMENT ON COLUMN auditoria.usuario_bd IS 'Rol de PostgreSQL con el que se abrió la conexión.';
COMMENT ON COLUMN auditoria.datos_anteriores IS 'En ACTUALIZACION, solo las columnas que cambiaron con su valor previo. En ELIMINACION, la fila completa. jsonb porque la forma depende de la tabla auditada.';
COMMENT ON COLUMN auditoria.datos_nuevos IS 'En ACTUALIZACION, las mismas columnas con su valor nuevo. En INSERCION, la fila completa. El secreto de los webhooks se guarda enmascarado.';

COMMENT ON VIEW vista_vuelo_programado IS 'Vuelo programado con sus códigos IATA y la duración calculada.';
COMMENT ON VIEW vista_retencion_precio IS 'lockedPrice de una retención.';
COMMENT ON VIEW vista_reserva_total    IS 'grandTotal de una reserva: itinerarios vigentes, equipaje adicional y cargos por cambios confirmados.';


-- =============================================================================
-- 18. DATOS DE REFERENCIA FIJADOS POR EL CONTRATO
-- =============================================================================

SET LOCAL app.auditoria = 'off';

INSERT INTO tipo_evento (codigo, descripcion) VALUES
    ('booking.confirmed',       'Reserva confirmada'),
    ('booking.failed',          'Reserva fallida'),
    ('booking.changed',         'Reserva modificada'),
    ('booking.cancelled',       'Reserva cancelada'),
    ('booking.baggage_added',   'Equipaje adicional agregado'),
    ('booking.ticket_issuing',  'Boletos en emisión'),
    ('booking.ticket_issued',   'Boletos emitidos'),
    ('booking.ticket_failed',   'Emisión de boletos fallida'),
    ('booking.checked_in',      'Check-in realizado'),
    ('hold.expired',            'Retención expirada'),
    ('flight.schedule_changed', 'Cambio de horario del vuelo'),
    ('flight.cancelled',        'Vuelo cancelado');

COMMIT;
