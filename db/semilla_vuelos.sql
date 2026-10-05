-- =============================================================================
--  SISTEMA DE VUELOS - BOOKING ECUADOR
--  Datos semilla del catálogo (red doméstica de Ecuador)
-- -----------------------------------------------------------------------------
--  Requiere esquema_vuelos.sql ya cargado. Se ejecuta UNA vez sobre la base
--  recién creada: una segunda ejecución falla por claves únicas. Para recargar,
--  recrear la base (db/reset.sh).
--
--  Alcance: el booking opera solo en Ecuador, así que la red es 100 % doméstica:
--  10 aeropuertos (8 continentales y 2 en Galápagos), 2 aerolíneas y escalas por
--  Guayaquil y Quito. Todos los INSERT son solo de Ecuador, incluida la
--  tabla pais (un único registro). Para aceptar pasajeros de otra nacionalidad
--  basta con agregar el país: INSERT INTO vuelos.pais (codigo_iso2, codigo_iso3, nombre) VALUES (...).
--
--  DATOS FICTICIOS: rutas, horarios, números de vuelo y precios están inventados
--  para pruebas. AV y LA son los códigos de las marcas Avianca y LATAM; en la
--  operación real los vuelos domésticos los operan filiales ecuatorianas con
--  otros códigos.
--
--  Las salidas se generan para los próximos 90 días a partir de HOY. Pasado ese
--  horizonte la búsqueda deja de devolver resultados: volver a sembrar sobre una
--  base nueva o ampliar el rango de fechas en la sección 5.
--
--  Galápagos (GPS, SCY) está en UTC-6 (Pacific/Galapagos); el resto de Ecuador en
--  UTC-5 (America/Guayaquil). Las horas de la tabla de rutas son locales del
--  aeropuerto de origen.
-- =============================================================================

BEGIN;

SET search_path TO vuelos;

-- La carga masiva no se registra en la auditoría (ver sección 13 del esquema).
SET LOCAL app.auditoria = 'off';


-- =============================================================================
-- 1. CATÁLOGOS BÁSICOS
-- =============================================================================

INSERT INTO pais (codigo_iso2, codigo_iso3, nombre) VALUES ('EC','ECU','Ecuador');

INSERT INTO moneda (codigo_iso, nombre, decimales) VALUES ('USD', 'Dólar estadounidense', 2);

INSERT INTO aerolinea (codigo_iata, nombre, prefijo_boleto) VALUES
    ('AV', 'Avianca',        '134'),
    ('LA', 'LATAM Airlines', '045');

CREATE TEMP TABLE _aeropuerto (
    codigo        text,
    nombre        text,
    ciudad        text,
    zona_horaria  text
) ON COMMIT DROP;

INSERT INTO _aeropuerto VALUES
    ('UIO', 'Aeropuerto Internacional Mariscal Sucre',         'Quito',         'America/Guayaquil'),
    ('GYE', 'Aeropuerto Internacional José Joaquín de Olmedo', 'Guayaquil',     'America/Guayaquil'),
    ('CUE', 'Aeropuerto Mariscal Lamar',                       'Cuenca',        'America/Guayaquil'),
    ('LOH', 'Aeropuerto Camilo Ponce Enríquez',                'Loja',          'America/Guayaquil'),
    ('MEC', 'Aeropuerto Internacional Eloy Alfaro',            'Manta',         'America/Guayaquil'),
    ('ESM', 'Aeropuerto Carlos Concha Torres',                 'Esmeraldas',    'America/Guayaquil'),
    ('LGQ', 'Aeropuerto Lago Agrio',                           'Nueva Loja',    'America/Guayaquil'),
    ('OCC', 'Aeropuerto Francisco de Orellana',                'Coca',          'America/Guayaquil'),
    ('GPS', 'Aeropuerto Seymour',                              'Baltra',        'Pacific/Galapagos'),
    ('SCY', 'Aeropuerto San Cristóbal',                        'San Cristóbal', 'Pacific/Galapagos');

INSERT INTO ciudad (pais_id, nombre, zona_horaria)
SELECT p.id, a.ciudad, a.zona_horaria
FROM _aeropuerto a
JOIN pais p ON p.codigo_iso2 = 'EC';

INSERT INTO aeropuerto (codigo_iata, nombre, ciudad_id)
SELECT a.codigo, a.nombre, c.id
FROM _aeropuerto a
JOIN ciudad c ON c.nombre = a.ciudad;

INSERT INTO modelo_aeronave (codigo_iata, nombre) VALUES
    ('320', 'Airbus A320'),
    ('319', 'Airbus A319'),
    ('AT7', 'ATR 72-600');


-- =============================================================================
-- 2. MAPAS DE ASIENTOS
-- Un mapa por (aerolínea, modelo). El diseño de filas y letras depende del
-- modelo: se declara una vez en _diseno y se aplica a cada mapa.
-- =============================================================================

INSERT INTO mapa_asientos_cabecera (aerolinea_id, modelo_aeronave_id, nombre)
SELECT al.id, ma.id, v.nombre
FROM (VALUES
    ('LA', '320', 'LATAM A320 · Ejecutiva + Económica'),
    ('LA', '319', 'LATAM A319 · Ejecutiva + Económica'),
    ('AV', '320', 'Avianca A320 · Ejecutiva + Económica'),
    ('AV', '319', 'Avianca A319 · Ejecutiva + Económica'),
    ('AV', 'AT7', 'Avianca ATR 72-600 · Económica')
) AS v(aerolinea, modelo, nombre)
JOIN aerolinea al       ON al.codigo_iata = v.aerolinea
JOIN modelo_aeronave ma ON ma.codigo_iata = v.modelo;

CREATE TEMP TABLE _diseno (
    modelo           text,
    cabina           clase_cabina,
    fila_desde       int,
    fila_hasta       int,
    letras           text,   -- letras de asiento de izquierda a derecha
    letras_ventana   text,
    letras_pasillo   text,
    filas_salida     int[]   -- filas de salida de emergencia
) ON COMMIT DROP;

INSERT INTO _diseno VALUES
    ('320', 'EJECUTIVA',  1,  3, 'ACDF',   'AF', 'CD', '{}'),
    ('320', 'ECONOMICA', 10, 30, 'ABCDEF', 'AF', 'CD', '{12,13}'),
    ('319', 'EJECUTIVA',  1,  2, 'ACDF',   'AF', 'CD', '{}'),
    ('319', 'ECONOMICA',  7, 26, 'ABCDEF', 'AF', 'CD', '{12,13}'),
    ('AT7', 'ECONOMICA',  1, 18, 'ACDF',   'AF', 'CD', '{9,10}');

-- Filas: la primera fila de económica tiene espacio extra para las piernas.
INSERT INTO mapa_asientos_detalle (mapa_asientos_id, numero_fila, clase_cabina, espacio_extra, salida_emergencia)
SELECT mc.id, g, d.cabina,
       d.cabina = 'ECONOMICA' AND g = d.fila_desde,
       g = ANY (d.filas_salida)
FROM mapa_asientos_cabecera mc
JOIN modelo_aeronave ma ON ma.id = mc.modelo_aeronave_id
JOIN _diseno d          ON d.modelo = ma.codigo_iata
CROSS JOIN LATERAL generate_series(d.fila_desde, d.fila_hasta) AS g
ORDER BY mc.id, g;

INSERT INTO asiento (mapa_asientos_detalle_id, letra, posicion)
SELECT f.id, l.letra,
       CASE WHEN position(l.letra IN d.letras_ventana) > 0 THEN 'VENTANA'
            WHEN position(l.letra IN d.letras_pasillo) > 0 THEN 'PASILLO'
            ELSE 'CENTRO' END::posicion_asiento
FROM mapa_asientos_detalle f
JOIN mapa_asientos_cabecera mc ON mc.id = f.mapa_asientos_id
JOIN modelo_aeronave ma        ON ma.id = mc.modelo_aeronave_id
JOIN _diseno d                 ON d.modelo = ma.codigo_iata AND d.cabina = f.clase_cabina
CROSS JOIN LATERAL (SELECT substr(d.letras, i, 1) AS letra, i
                    FROM generate_series(1, length(d.letras)) AS i) AS l
ORDER BY f.id, l.i;


-- =============================================================================
-- 3. FAMILIAS TARIFARIAS
-- Las mismas para las dos aerolíneas. La flota doméstica solo tiene cabinas
-- ECONOMICA y EJECUTIVA, por eso no se siembra ninguna familia de
-- ECONOMICA_PREMIUM ni de PRIMERA (el esquema las admite si se agregan después).
--   penalidad  = % que se retiene al cancelar (100 = no reembolsable)
--   pct_cambio = cargo por cambio de fecha como % de la tarifa base de un adulto
--                (NULL = la familia no admite cambios)
--   factor     = multiplicador sobre la tarifa BASIC
-- =============================================================================

CREATE TEMP TABLE _familia (
    cabina      clase_cabina,
    codigo      text,
    nombre      text,
    personal    boolean,
    mano        smallint,
    bodega      smallint,
    max_extra   smallint,
    penalidad   numeric(5,2),
    pct_cambio  numeric(5,2),
    factor      numeric(5,2)
) ON COMMIT DROP;

INSERT INTO _familia VALUES
    ('ECONOMICA', 'BASIC',         'Basic',         true, 0, 0, 2, 100.00, NULL,  1.00),
    ('ECONOMICA', 'CLASSIC',       'Classic',       true, 1, 1, 2,  35.00, 20.00, 1.20),
    ('ECONOMICA', 'FLEX',          'Flex',          true, 1, 2, 3,  10.00,  0.00, 1.55),
    ('EJECUTIVA', 'BUSINESS_FLEX', 'Business Flex', true, 2, 2, 4,   0.00,  0.00, 2.60);

INSERT INTO familia_tarifa (aerolinea_id, clase_cabina, codigo, nombre, es_cambiable,
                            porcentaje_penalidad_cancelacion, incluye_articulo_personal,
                            equipaje_mano_incluido, equipaje_bodega_incluido, maximo_equipaje_adicional)
SELECT al.id, f.cabina, f.codigo, f.nombre, f.pct_cambio IS NOT NULL,
       f.penalidad, f.personal, f.mano, f.bodega, f.max_extra
FROM aerolinea al
CROSS JOIN _familia f
ORDER BY al.id, f.factor;


-- =============================================================================
-- 4. RUTAS Y HORARIOS
-- Una fila por vuelo comercial (ambos sentidos). Horas locales del aeropuerto de
-- origen. dias = días ISO de operación (1 = lunes ... 7 = domingo).
-- base_usd = tarifa BASIC económica de un adulto; maleta_usd = maleta adicional.
-- Los horarios están armados para que existan conexiones de 45 min a 8 h:
--   · UIO / CUE / LOH / MEC ... -> GYE -> Galápagos
--   · Galápagos -> GYE -> Quito, Cuenca, etc.
-- =============================================================================

CREATE TEMP TABLE _ruta (
    aerolinea     text,
    numero        text,
    origen        text,
    destino       text,
    hora_salida   time,
    duracion_min  int,
    modelo        text,
    dias          int[],
    base_usd      numeric(8,2),
    maleta_usd    numeric(8,2)
) ON COMMIT DROP;

INSERT INTO _ruta VALUES
 -- Quito <-> Guayaquil (troncal, siete frecuencias por sentido)
 ('LA','1400','UIO','GYE','06:00',55,'320','{1,2,3,4,5,6,7}',55,15),
 ('LA','1402','UIO','GYE','10:30',55,'320','{1,2,3,4,5,6,7}',55,15),
 ('LA','1404','UIO','GYE','16:00',55,'320','{1,2,3,4,5,6,7}',55,15),
 ('LA','1406','UIO','GYE','20:00',55,'320','{1,2,3,4,5,6,7}',55,15),
 ('AV','1500','UIO','GYE','07:30',55,'320','{1,2,3,4,5,6,7}',58,15),
 ('AV','1502','UIO','GYE','13:00',55,'320','{1,2,3,4,5,6,7}',58,15),
 ('AV','1504','UIO','GYE','18:30',55,'320','{1,2,3,4,5,6,7}',58,15),
 ('LA','1401','GYE','UIO','07:30',55,'320','{1,2,3,4,5,6,7}',55,15),
 ('LA','1403','GYE','UIO','12:00',55,'320','{1,2,3,4,5,6,7}',55,15),
 ('LA','1405','GYE','UIO','17:30',55,'320','{1,2,3,4,5,6,7}',55,15),
 ('LA','1407','GYE','UIO','21:00',55,'320','{1,2,3,4,5,6,7}',55,15),
 ('AV','1501','GYE','UIO','09:00',55,'320','{1,2,3,4,5,6,7}',58,15),
 ('AV','1503','GYE','UIO','14:30',55,'320','{1,2,3,4,5,6,7}',58,15),
 ('AV','1505','GYE','UIO','19:30',55,'320','{1,2,3,4,5,6,7}',58,15),
 -- Quito <-> Cuenca
 ('LA','1430','UIO','CUE','07:00',55,'319','{1,2,3,4,5,6,7}',60,15),
 ('LA','1431','CUE','UIO','08:30',55,'319','{1,2,3,4,5,6,7}',60,15),
 ('AV','1530','UIO','CUE','14:00',55,'319','{1,2,3,4,5,6,7}',62,15),
 ('AV','1531','CUE','UIO','15:30',55,'319','{1,2,3,4,5,6,7}',62,15),
 ('LA','1432','UIO','CUE','18:30',55,'319','{1,2,3,4,5,7}',  60,15),
 ('LA','1433','CUE','UIO','20:00',55,'319','{1,2,3,4,5,7}',  60,15),
 -- Guayaquil <-> Cuenca
 ('AV','1542','GYE','CUE','09:30',35,'319','{1,2,3,4,5,6,7}',40,15),
 ('AV','1540','GYE','CUE','15:00',35,'319','{1,2,3,4,5,6,7}',40,15),
 ('AV','1541','CUE','GYE','06:30',35,'319','{1,2,3,4,5,6,7}',40,15),
 ('AV','1543','CUE','GYE','16:00',35,'319','{1,2,3,4,5,6,7}',40,15),
 -- Quito <-> Loja (turbohélice)
 ('AV','1550','UIO','LOH','09:00',65,'AT7','{1,2,3,4,5,7}',  65,15),
 ('AV','1551','LOH','UIO','10:45',65,'AT7','{1,2,3,4,5,7}',  65,15),
 ('AV','1552','UIO','LOH','16:00',65,'AT7','{1,3,5}',         65,15),
 ('AV','1553','LOH','UIO','17:45',65,'AT7','{1,3,5}',         65,15),
 -- Quito <-> Manta
 ('LA','1440','UIO','MEC','07:30',45,'319','{1,2,3,4,5,6,7}',50,15),
 ('LA','1441','MEC','UIO','09:00',45,'319','{1,2,3,4,5,6,7}',50,15),
 ('AV','1560','UIO','MEC','15:00',45,'319','{1,2,3,4,5,6,7}',52,15),
 ('AV','1561','MEC','UIO','16:30',45,'319','{1,2,3,4,5,6,7}',52,15),
 -- Quito <-> Esmeraldas
 ('AV','1570','UIO','ESM','06:45',40,'AT7','{1,2,3,4,5,7}',  45,15),
 ('AV','1571','ESM','UIO','08:15',40,'AT7','{1,2,3,4,5,7}',  45,15),
 ('AV','1572','UIO','ESM','17:00',40,'AT7','{1,5,7}',         45,15),
 ('AV','1573','ESM','UIO','18:30',40,'AT7','{1,5,7}',         45,15),
 -- Quito <-> Lago Agrio y Coca (Amazonía)
 ('AV','1580','UIO','LGQ','07:00',40,'AT7','{1,2,3,4,5,6}',   50,15),
 ('AV','1581','LGQ','UIO','08:30',40,'AT7','{1,2,3,4,5,6}',   50,15),
 ('AV','1590','UIO','OCC','12:00',40,'AT7','{1,3,5,7}',       55,15),
 ('AV','1591','OCC','UIO','13:30',40,'AT7','{1,3,5,7}',       55,15),
 -- Guayaquil <-> Galápagos (Baltra)
 ('LA','2410','GYE','GPS','08:00',115,'320','{1,2,3,4,5,6,7}',190,25),
 ('AV','2510','GYE','GPS','09:30',115,'320','{1,2,3,4,5,6,7}',195,25),
 ('LA','2412','GYE','GPS','12:30',115,'320','{1,2,3,4,5,6,7}',190,25),
 ('LA','2411','GPS','GYE','10:30',115,'320','{1,2,3,4,5,6,7}',190,25),
 ('AV','2511','GPS','GYE','12:00',115,'320','{1,2,3,4,5,6,7}',195,25),
 ('LA','2413','GPS','GYE','13:30',115,'320','{1,2,3,4,5,6,7}',190,25),
 -- Guayaquil <-> Galápagos (San Cristóbal)
 ('LA','2420','GYE','SCY','08:30',110,'320','{1,2,3,4,5,6,7}',195,25),
 ('AV','2520','GYE','SCY','10:00',110,'319','{2,4,6}',        200,25),
 ('LA','2421','SCY','GYE','11:00',110,'320','{1,2,3,4,5,6,7}',195,25),
 ('AV','2521','SCY','GYE','12:30',110,'319','{2,4,6}',        200,25);

INSERT INTO vuelo (aerolinea_id, aerolinea_operadora_id, numero, aeropuerto_origen_id, aeropuerto_destino_id)
SELECT al.id, al.id, r.numero, o.id, d.id
FROM _ruta r
JOIN aerolinea al  ON al.codigo_iata = r.aerolinea
JOIN aeropuerto o  ON o.codigo_iata  = r.origen
JOIN aeropuerto d  ON d.codigo_iata  = r.destino
ORDER BY r.aerolinea, r.numero;

-- Vista de trabajo: cada ruta ya resuelta a sus ids.
CREATE TEMP TABLE _vuelo_ruta ON COMMIT DROP AS
SELECT v.id AS vuelo_id, al.id AS aerolinea_id, mc.id AS mapa_asientos_id, c.zona_horaria,
       r.hora_salida, r.duracion_min, r.dias, r.base_usd, r.maleta_usd
FROM _ruta r
JOIN aerolinea al              ON al.codigo_iata = r.aerolinea
JOIN vuelo v                   ON v.aerolinea_id = al.id AND v.numero = r.numero
JOIN aeropuerto o              ON o.id = v.aeropuerto_origen_id
JOIN ciudad c                  ON c.id = o.ciudad_id
JOIN modelo_aeronave ma        ON ma.codigo_iata = r.modelo
JOIN mapa_asientos_cabecera mc ON mc.aerolinea_id = al.id AND mc.modelo_aeronave_id = ma.id;


-- =============================================================================
-- 5. SALIDAS DE LOS PRÓXIMOS 90 DÍAS
-- fecha_salida es la fecha local en el origen; la hora local se convierte a
-- instante absoluto con la zona horaria de la ciudad de origen.
-- =============================================================================

INSERT INTO vuelo_programado (vuelo_id, mapa_asientos_id, fecha_salida, salida_programada, llegada_programada)
SELECT vr.vuelo_id, vr.mapa_asientos_id, d.fecha, t.salida, t.salida + make_interval(mins => vr.duracion_min)
FROM _vuelo_ruta vr
CROSS JOIN LATERAL (SELECT g::date AS fecha
                    FROM generate_series(current_date + 1, current_date + 90, interval '1 day') AS g) AS d
CROSS JOIN LATERAL (SELECT (d.fecha + vr.hora_salida) AT TIME ZONE vr.zona_horaria AS salida) AS t
WHERE extract(isodow FROM d.fecha)::int = ANY (vr.dias);


-- =============================================================================
-- 6. CUPO POR CABINA, TARIFAS Y PRECIOS
-- El cupo vendible es el 100 % de los asientos de cada cabina.
-- Precio = base de la ruta x factor de familia x factor de demanda x factor de
-- pasajero. Demanda: +30 % si faltan 7 días o menos, +12 % hasta 21 días, y
-- +10 % los viernes y domingos. Impuestos = 20 % de la tarifa base (valor de
-- prueba, no es la tasa real).
-- =============================================================================

INSERT INTO inventario_cabina (vuelo_programado_id, clase_cabina, cupos_totales, cupos_disponibles)
SELECT vp.id, cc.clase_cabina, cc.asientos, cc.asientos
FROM vuelo_programado vp
JOIN (SELECT f.mapa_asientos_id, f.clase_cabina, count(*)::smallint AS asientos
      FROM asiento a
      JOIN mapa_asientos_detalle f ON f.id = a.mapa_asientos_detalle_id
      GROUP BY 1, 2) AS cc ON cc.mapa_asientos_id = vp.mapa_asientos_id;

INSERT INTO tarifa_cabecera (vuelo_programado_id, familia_tarifa_id, moneda_id, precio_equipaje_adicional)
SELECT vp.id, ft.id, m.id, vr.maleta_usd
FROM vuelo_programado vp
JOIN _vuelo_ruta vr       ON vr.vuelo_id = vp.vuelo_id
JOIN familia_tarifa ft    ON ft.aerolinea_id = vr.aerolinea_id
JOIN inventario_cabina ic ON ic.vuelo_programado_id = vp.id AND ic.clase_cabina = ft.clase_cabina
JOIN moneda m             ON m.codigo_iso = 'USD';

INSERT INTO tarifa_detalle (tarifa_id, tipo_pasajero, tarifa_base, impuestos)
SELECT p.tarifa_id, p.tipo_pasajero, p.base, round(p.base * 0.20, 2)
FROM (
    SELECT tc.id AS tarifa_id, tp.tipo_pasajero,
           round( vr.base_usd * f.factor * tp.factor
                  * CASE WHEN vp.fecha_salida - current_date <= 7  THEN 1.30
                         WHEN vp.fecha_salida - current_date <= 21 THEN 1.12 ELSE 1.00 END
                  * CASE WHEN extract(isodow FROM vp.fecha_salida) IN (5, 7) THEN 1.10 ELSE 1.00 END
                , 2) AS base
    FROM tarifa_cabecera tc
    JOIN vuelo_programado vp ON vp.id = tc.vuelo_programado_id
    JOIN _vuelo_ruta vr      ON vr.vuelo_id = vp.vuelo_id
    JOIN familia_tarifa ft   ON ft.id = tc.familia_tarifa_id
    JOIN _familia f          ON f.cabina = ft.clase_cabina AND f.codigo = ft.codigo
    CROSS JOIN (VALUES ('ADULTO'::tipo_pasajero, 1.00), ('JOVEN', 0.90),
                       ('NINO', 0.75), ('INFANTE', 0.10)) AS tp(tipo_pasajero, factor)
) AS p;

-- Cargo por cambio de fecha: porcentaje de la familia sobre la tarifa base del adulto.
UPDATE tarifa_cabecera tc
SET cargo_cambio = round(td.tarifa_base * f.pct_cambio / 100, 2)
FROM tarifa_detalle td, familia_tarifa ft, _familia f
WHERE td.tarifa_id = tc.id
  AND td.tipo_pasajero = 'ADULTO'
  AND ft.id = tc.familia_tarifa_id
  AND f.cabina = ft.clase_cabina AND f.codigo = ft.codigo
  AND f.pct_cambio IS NOT NULL;

COMMIT;

-- =============================================================================
-- RESUMEN
-- =============================================================================
SELECT 'aeropuertos' AS tabla, count(*) AS filas FROM vuelos.aeropuerto
UNION ALL SELECT 'aerolíneas',           count(*) FROM vuelos.aerolinea
UNION ALL SELECT 'mapas de asientos',    count(*) FROM vuelos.mapa_asientos_cabecera
UNION ALL SELECT 'asientos físicos',     count(*) FROM vuelos.asiento
UNION ALL SELECT 'familias tarifarias',  count(*) FROM vuelos.familia_tarifa
UNION ALL SELECT 'vuelos (rutas)',       count(*) FROM vuelos.vuelo
UNION ALL SELECT 'salidas (90 días)',    count(*) FROM vuelos.vuelo_programado
UNION ALL SELECT 'cupos por cabina',     count(*) FROM vuelos.inventario_cabina
UNION ALL SELECT 'tarifas en venta',     count(*) FROM vuelos.tarifa_cabecera
UNION ALL SELECT 'precios por pasajero', count(*) FROM vuelos.tarifa_detalle
UNION ALL SELECT 'filas de auditoría',   count(*) FROM vuelos.auditoria;
