-- Prueba de humo del esquema: flujo completo + restricciones que deben fallar.
\set ON_ERROR_STOP on
SET search_path TO vuelos;
SET client_min_messages TO warning;

-- ---------- Catálogos
INSERT INTO pais (codigo_iso2, codigo_iso3, nombre) VALUES ('EC','ECU','Ecuador'), ('CO','COL','Colombia');
INSERT INTO ciudad (pais_id, nombre, zona_horaria) VALUES
  (1,'Quito','America/Guayaquil'), (1,'Guayaquil','America/Guayaquil'), (1,'Baltra','Pacific/Galapagos');
INSERT INTO aeropuerto (codigo_iata, nombre, ciudad_id) VALUES ('UIO','Mariscal Sucre',1), ('GYE','Olmedo',2), ('GPS','Seymour',3);
INSERT INTO aerolinea (codigo_iata, nombre, prefijo_boleto) VALUES ('ZZ','Aerolinea de Prueba','999'), ('Z9','Operadora de Prueba', NULL);
INSERT INTO modelo_aeronave (codigo_iata, nombre) VALUES ('320','Modelo A'), ('E90','Modelo B');
INSERT INTO moneda (codigo_iso, nombre) VALUES ('USD','Dolar estadounidense');
INSERT INTO familia_tarifa (aerolinea_id, clase_cabina, codigo, nombre, es_cambiable, porcentaje_penalidad_cancelacion, equipaje_mano_incluido, equipaje_bodega_incluido) VALUES
  (1,'ECONOMICA','LIGHT','Light',false,100,1,0), (1,'ECONOMICA','FULL','Full',true,20,1,1);
INSERT INTO mapa_asientos_cabecera (aerolinea_id, modelo_aeronave_id, nombre) VALUES (1,1,'A 174Y'), (1,2,'B 100Y');
INSERT INTO mapa_asientos_detalle (mapa_asientos_id, numero_fila, clase_cabina, espacio_extra, salida_emergencia) VALUES
  (1,1,'ECONOMICA',true,false), (1,2,'ECONOMICA',false,false), (2,1,'ECONOMICA',false,false);
INSERT INTO asiento (mapa_asientos_detalle_id, letra, posicion) VALUES
  (1,'A','VENTANA'), (1,'B','CENTRO'), (1,'C','PASILLO'), (2,'A','VENTANA'), (3,'A','VENTANA');
INSERT INTO vuelo (aerolinea_id, aerolinea_operadora_id, numero, aeropuerto_origen_id, aeropuerto_destino_id) VALUES
  (1,1,'1412',1,2), (1,2,'1413',2,1), (1,1,'200',1,3);

-- ---------- Vuelos programados e inventario
INSERT INTO vuelo_programado (id, vuelo_id, mapa_asientos_id, fecha_salida, salida_programada, llegada_programada, terminal_salida) VALUES
  ('00000000-0000-0000-0000-0000000000a1',1,1,'2026-12-01','2026-12-01 08:00-05','2026-12-01 08:55-05','Nacional'),
  ('00000000-0000-0000-0000-0000000000a2',2,1,'2026-12-10','2026-12-10 18:00-05','2026-12-10 18:55-05',NULL),
  ('00000000-0000-0000-0000-0000000000a3',1,1,'2026-12-05','2026-12-05 08:00-05','2026-12-05 08:55-05',NULL),
  ('00000000-0000-0000-0000-0000000000a4',3,2,'2026-12-01','2026-12-01 23:30-05','2026-12-02 01:40-06',NULL);
INSERT INTO inventario_cabina (vuelo_programado_id, clase_cabina, cupos_totales, cupos_disponibles) VALUES
  ('00000000-0000-0000-0000-0000000000a1','ECONOMICA',100,100),
  ('00000000-0000-0000-0000-0000000000a2','ECONOMICA',100,100),
  ('00000000-0000-0000-0000-0000000000a3','ECONOMICA',100,100),
  ('00000000-0000-0000-0000-0000000000a4','ECONOMICA',72,72);
INSERT INTO tarifa_cabecera (vuelo_programado_id, familia_tarifa_id, moneda_id, precio_equipaje_adicional, cargo_cambio) VALUES
  ('00000000-0000-0000-0000-0000000000a1',1,1,25,0),
  ('00000000-0000-0000-0000-0000000000a1',2,1,20,15),
  ('00000000-0000-0000-0000-0000000000a2',2,1,20,15),
  ('00000000-0000-0000-0000-0000000000a3',2,1,20,15);
INSERT INTO tarifa_detalle (tarifa_id, tipo_pasajero, tarifa_base, impuestos) VALUES
  (2,'ADULTO',80,22.50), (2,'INFANTE',8,2.25), (3,'ADULTO',85,23), (3,'INFANTE',8.5,2.30), (4,'ADULTO',90,24);

-- ---------- Itinerarios, oferta, retención
INSERT INTO itinerario_cabecera (id) VALUES
  ('00000000-0000-0000-0000-0000000000b1'), ('00000000-0000-0000-0000-0000000000b2'), ('00000000-0000-0000-0000-0000000000b3');
INSERT INTO itinerario_detalle (itinerario_id, orden, vuelo_programado_id) VALUES
  ('00000000-0000-0000-0000-0000000000b1',1,'00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2',1,'00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000b3',1,'00000000-0000-0000-0000-0000000000a3');
INSERT INTO oferta_cabecera (id, aerolinea_id, huella_dispositivo, fecha_expiracion) VALUES
  ('00000000-0000-0000-0000-0000000000c1',1,'fp-123', now() + interval '30 minutes'),
  ('00000000-0000-0000-0000-0000000000c2',1,'fp-456', now() + interval '30 minutes');
INSERT INTO oferta_detalle (oferta_id, itinerario_id, orden) VALUES
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1',1),
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b2',2);
INSERT INTO retencion_cabecera (id, oferta_id, id_propietario, moneda_id, adultos, infantes, fecha_expiracion) VALUES
  ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1','usuario-1',1,2,1, now() + interval '15 minutes'),
  ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000c1','usuario-2',1,1,0, now() + interval '15 minutes');
INSERT INTO retencion_detalle (retencion_id, itinerario_id, familia_tarifa_id, tarifa_base_congelada, impuestos_congelados) VALUES
  ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',2,168.00,47.25),
  ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b2',2,178.50,48.30),
  ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000b1',2,80.00,22.50);
UPDATE inventario_cabina SET cupos_disponibles = cupos_disponibles - 2 WHERE id IN (1,2) AND cupos_disponibles >= 2;

-- ---------- Reserva
UPDATE retencion_cabecera SET estado = 'CONSUMIDA', fecha_cierre = now() WHERE id IN ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2');
INSERT INTO reserva_cabecera (id, retencion_id, pnr) VALUES
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000d1','AB12CD'),
  ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000d2','ZX98YW');
INSERT INTO reserva_detalle_itinerario (reserva_id, itinerario_id, familia_tarifa_id, orden, tarifa_base, impuestos) VALUES
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000b1',2,1,168.00,47.25),
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000b2',2,2,178.50,48.30),
  ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000b1',2,1,80.00,22.50);
INSERT INTO reserva_detalle_pasajero (reserva_id, codigo_pasajero, tipo_pasajero, nombres, apellidos, tipo_documento, numero_documento, pais_nacionalidad_id, fecha_vencimiento_documento, fecha_nacimiento, genero, correo, telefono) VALUES
  ('00000000-0000-0000-0000-0000000000e1','PAX1','ADULTO','Ana','Prueba','CEDULA','1710034065',1,NULL,'1990-05-10','F','ana@example.com','+593991234567'),
  ('00000000-0000-0000-0000-0000000000e1','PAX2','ADULTO','Luis','Prueba','PASAPORTE','AB123456',2,'2030-01-01','1988-03-02','M','luis@example.com','0991234567'),
  ('00000000-0000-0000-0000-0000000000e2','PAX1','ADULTO','Eva','Otra','CEDULA','1710034073',1,NULL,'1995-01-01','F','eva@example.com','+593987654321');
INSERT INTO reserva_detalle_pasajero (reserva_id, codigo_pasajero, tipo_pasajero, adulto_responsable_id, nombres, apellidos, tipo_documento, numero_documento, pais_nacionalidad_id, fecha_nacimiento, genero, correo, telefono) VALUES
  ('00000000-0000-0000-0000-0000000000e1','PAX3','INFANTE',1,'Bebe','Prueba','CEDULA','1750000001',1,'2026-02-01','X','ana@example.com','+593991234567');
INSERT INTO reserva_detalle_asiento (pasajero_id, vuelo_programado_id, asiento_id) VALUES
  (1,'00000000-0000-0000-0000-0000000000a1',1), (2,'00000000-0000-0000-0000-0000000000a1',2), (2,'00000000-0000-0000-0000-0000000000a2',1);
INSERT INTO reserva_detalle_pago (reserva_id, referencia_pago, concepto) VALUES
  ('00000000-0000-0000-0000-0000000000e1','PAY-001','EMISION'),
  ('00000000-0000-0000-0000-0000000000e2','PAY-002','EMISION'),
  ('00000000-0000-0000-0000-0000000000e1','PAY-003','EQUIPAJE_ADICIONAL'),
  ('00000000-0000-0000-0000-0000000000e1','PAY-004','CAMBIO_FECHA');
INSERT INTO reserva_detalle_equipaje (pasajero_id, reserva_itinerario_id, pago_id, cantidad, precio_unitario) VALUES (1,1,3,2,20.00);
INSERT INTO reserva_detalle_historial (reserva_id, estado_anterior, estado_nuevo, descripcion) VALUES
  ('00000000-0000-0000-0000-0000000000e1','PENDIENTE','CONFIRMADA','Reserva confirmada'),
  ('00000000-0000-0000-0000-0000000000e1',NULL,NULL,'Maleta adicional agregada');

-- ---------- Boletos
INSERT INTO boleto_cabecera (id, pasajero_id, numero_boleto, estado, fecha_emision) VALUES
  ('00000000-0000-0000-0000-0000000000f1',1,'9991234567890','EMITIDO',now()),
  ('00000000-0000-0000-0000-0000000000f2',2,NULL,'EMITIENDO',NULL);
INSERT INTO boleto_detalle (boleto_id, vuelo_programado_id, numero_cupon, estado) VALUES
  ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a1',1,'EMITIDO'),
  ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a2',2,'EMITIDO'),
  ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a1',NULL,'PENDIENTE'),
  ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a2',NULL,'PENDIENTE');

-- ---------- Cambio de fecha confirmado (itinerario b1 -> b3)
INSERT INTO cambio_cabecera (id, reserva_id, estado, cargo_cambio, pago_id, fecha_expiracion, fecha_resolucion) VALUES
  ('00000000-0000-0000-0000-000000000a01','00000000-0000-0000-0000-0000000000e1','CONFIRMADO',15.00,4, now() + interval '20 minutes', now());
INSERT INTO cambio_detalle (cambio_id, reserva_itinerario_id, itinerario_nuevo_id, diferencia_tarifa, diferencia_impuestos) VALUES
  ('00000000-0000-0000-0000-000000000a01',1,'00000000-0000-0000-0000-0000000000b3',10.00,1.50);
UPDATE reserva_detalle_itinerario SET vigente = false WHERE id = 1;
INSERT INTO reserva_detalle_itinerario (reserva_id, itinerario_id, familia_tarifa_id, orden, tarifa_base, impuestos) VALUES
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000b3',2,1,178.00,48.75);

-- ---------- Cancelación, check-in, webhooks, idempotencia
INSERT INTO cotizacion_cancelacion (id, reserva_id, monto_reembolso, monto_penalidad, fecha_expiracion, fecha_aceptacion, motivo) VALUES
  ('00000000-0000-0000-0000-000000000b01','00000000-0000-0000-0000-0000000000e2',82.00,20.50, now() + interval '10 minutes', now(), 'Cambio de planes');
INSERT INTO checkin (pasajero_id, vuelo_programado_id, estado, motivo_fallo) VALUES
  (2,'00000000-0000-0000-0000-0000000000a2','FALLIDO','Fuera de ventana'),
  (2,'00000000-0000-0000-0000-0000000000a2','REGISTRADO',NULL);
INSERT INTO pase_abordar (checkin_id, grupo_abordaje, codigo_barras) VALUES (2,'B','M1PRUEBA/LUIS AB12CD GYEUIOZZ 1413');
INSERT INTO webhook_cabecera (id, id_propietario, url, secreto) VALUES
  ('00000000-0000-0000-0000-000000000c01','integrador-1','https://ejemplo.test/hook','s3cr3t0-de-prueba');
INSERT INTO webhook_detalle (webhook_id, tipo_evento_id) SELECT '00000000-0000-0000-0000-000000000c01', id FROM tipo_evento WHERE codigo LIKE 'booking.%';
INSERT INTO evento (id, tipo_evento_id, reserva_id, estado_reserva) VALUES
  ('00000000-0000-0000-0000-000000000d01',(SELECT id FROM tipo_evento WHERE codigo = 'booking.confirmed'),'00000000-0000-0000-0000-0000000000e1','CONFIRMADA');
INSERT INTO evento_entrega (evento_id, webhook_id, numero_intento, codigo_http, entregado) VALUES
  ('00000000-0000-0000-0000-000000000d01','00000000-0000-0000-0000-000000000c01',1,500,false),
  ('00000000-0000-0000-0000-000000000d01','00000000-0000-0000-0000-000000000c01',2,200,true);
INSERT INTO clave_idempotencia (id_propietario, operacion, clave, huella_solicitud, codigo_http, respuesta, fecha_expiracion) VALUES
  ('usuario-1','CREAR_RESERVA','11111111-1111-4111-8111-111111111111', repeat('a',64), 201, '{"bookingId":"x"}', now() + interval '24 hours');

-- ---------- Trigger de fecha_actualizacion
SELECT pg_sleep(0.05);
UPDATE reserva_cabecera SET estado = 'CONFIRMADA' WHERE id = '00000000-0000-0000-0000-0000000000e1';

\echo
\echo === VISTAS ===
SELECT codigo_vuelo, fecha_salida, origen, destino, aerolinea_operadora, aeronave, duracion_minutos, estado FROM vista_vuelo_programado ORDER BY codigo_vuelo, fecha_salida;
SELECT right(retencion_id::text,2) AS ret, moneda, tarifa_base, impuestos, total FROM vista_retencion_precio ORDER BY 1;
SELECT pnr, moneda, tarifa_base, impuestos, equipaje_adicional, cargos_cambio, total FROM vista_reserva_total ORDER BY pnr;
SELECT pnr, estado, fecha_actualizacion > fecha_creacion AS actualizacion_marcada FROM reserva_cabecera ORDER BY pnr;

-- ---------- Restricciones que DEBEN fallar
CREATE FUNCTION pg_temp.debe_fallar(p_nombre text, p_sqlstate text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_restriccion text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_restriccion = CONSTRAINT_NAME;
    IF SQLSTATE = ANY (string_to_array(p_sqlstate, '|')) THEN
      RETURN format('OK  %-46s %s %s', p_nombre, SQLSTATE, COALESCE(NULLIF(v_restriccion,''), '-'));
    END IF;
    RAISE EXCEPTION 'INESPERADO [%]: % %', p_nombre, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'NO FALLO: %', p_nombre;
END $$;

\echo
\echo === RESTRICCIONES (cada linea debe decir OK) ===
\pset tuples_only on
SELECT pg_temp.debe_fallar('asiento ya ocupado en el vuelo', '23505', $q$INSERT INTO reserva_detalle_asiento (pasajero_id, vuelo_programado_id, asiento_id) VALUES (1,'00000000-0000-0000-0000-0000000000a2',1)$q$);
SELECT pg_temp.debe_fallar('dos asientos al mismo pasajero y vuelo', '23505', $q$INSERT INTO reserva_detalle_asiento (pasajero_id, vuelo_programado_id, asiento_id) VALUES (1,'00000000-0000-0000-0000-0000000000a1',3)$q$);
SELECT pg_temp.debe_fallar('infante con asiento', '23514', $q$INSERT INTO reserva_detalle_asiento (pasajero_id, vuelo_programado_id, asiento_id) VALUES (4,'00000000-0000-0000-0000-0000000000a2',2)$q$);
SELECT pg_temp.debe_fallar('asiento de otro mapa de aeronave', '23514', $q$INSERT INTO reserva_detalle_asiento (pasajero_id, vuelo_programado_id, asiento_id) VALUES (1,'00000000-0000-0000-0000-0000000000a3',5)$q$);
SELECT pg_temp.debe_fallar('mas infantes que adultos', '23514', $q$INSERT INTO retencion_cabecera (oferta_id, id_propietario, moneda_id, adultos, infantes, fecha_expiracion) VALUES ('00000000-0000-0000-0000-0000000000c1','u',1,1,2, now() + interval '5 min')$q$);
SELECT pg_temp.debe_fallar('mas de 9 pasajeros con asiento', '23514', $q$INSERT INTO retencion_cabecera (oferta_id, id_propietario, moneda_id, adultos, ninos, fecha_expiracion) VALUES ('00000000-0000-0000-0000-0000000000c1','u',1,6,4, now() + interval '5 min')$q$);
SELECT pg_temp.debe_fallar('retenida con fecha de cierre', '23514', $q$INSERT INTO retencion_cabecera (oferta_id, id_propietario, moneda_id, fecha_expiracion, fecha_cierre) VALUES ('00000000-0000-0000-0000-0000000000c1','u',1, now() + interval '5 min', now())$q$);
SELECT pg_temp.debe_fallar('cupos disponibles negativos', '23514', $q$UPDATE inventario_cabina SET cupos_disponibles = cupos_disponibles - 1000 WHERE id = 1$q$);
SELECT pg_temp.debe_fallar('cupos disponibles sobre el total', '23514', $q$UPDATE inventario_cabina SET cupos_disponibles = cupos_totales + 1 WHERE id = 1$q$);
SELECT pg_temp.debe_fallar('ruta con origen igual a destino', '23514', $q$INSERT INTO vuelo (aerolinea_id, aerolinea_operadora_id, numero, aeropuerto_origen_id, aeropuerto_destino_id) VALUES (1,1,'77',1,1)$q$);
SELECT pg_temp.debe_fallar('numero de vuelo repetido', '23505', $q$INSERT INTO vuelo (aerolinea_id, aerolinea_operadora_id, numero, aeropuerto_origen_id, aeropuerto_destino_id) VALUES (1,1,'1412',2,3)$q$);
SELECT pg_temp.debe_fallar('misma salida del vuelo dos veces', '23505', $q$INSERT INTO vuelo_programado (vuelo_id, mapa_asientos_id, fecha_salida, salida_programada, llegada_programada) VALUES (1,1,'2026-12-01','2026-12-01 15:00-05','2026-12-01 16:00-05')$q$);
SELECT pg_temp.debe_fallar('llegada antes que salida', '23514', $q$INSERT INTO vuelo_programado (vuelo_id, mapa_asientos_id, fecha_salida, salida_programada, llegada_programada) VALUES (1,1,'2026-12-20','2026-12-20 15:00-05','2026-12-20 14:00-05')$q$);
SELECT pg_temp.debe_fallar('fecha_salida incoherente', '23514', $q$INSERT INTO vuelo_programado (vuelo_id, mapa_asientos_id, fecha_salida, salida_programada, llegada_programada) VALUES (1,1,'2026-12-25','2026-12-20 15:00-05','2026-12-20 16:00-05')$q$);
SELECT pg_temp.debe_fallar('codigo IATA en minusculas', '23514', $q$INSERT INTO aeropuerto (codigo_iata, nombre, ciudad_id) VALUES ('cue','Cuenca',1)$q$);
SELECT pg_temp.debe_fallar('segunda reserva de la misma retencion', '23505', $q$INSERT INTO reserva_cabecera (retencion_id, pnr) VALUES ('00000000-0000-0000-0000-0000000000d1','QQ11QQ')$q$);
SELECT pg_temp.debe_fallar('PNR repetido', '23505', $q$INSERT INTO retencion_cabecera (id, oferta_id, id_propietario, moneda_id, estado, fecha_expiracion, fecha_cierre) VALUES ('00000000-0000-0000-0000-0000000000d9','00000000-0000-0000-0000-0000000000c1','u',1,'CONSUMIDA', now() + interval '5 min', now()); INSERT INTO reserva_cabecera (retencion_id, pnr) VALUES ('00000000-0000-0000-0000-0000000000d9','AB12CD')$q$);
SELECT pg_temp.debe_fallar('PNR con formato invalido', '23514', $q$UPDATE reserva_cabecera SET pnr = 'ab-12' WHERE pnr = 'AB12CD'$q$);
SELECT pg_temp.debe_fallar('referencia de pago reutilizada', '23505', $q$INSERT INTO reserva_detalle_pago (reserva_id, referencia_pago, concepto) VALUES ('00000000-0000-0000-0000-0000000000e2','PAY-001','EQUIPAJE_ADICIONAL')$q$);
SELECT pg_temp.debe_fallar('dos pagos de emision en una reserva', '23505', $q$INSERT INTO reserva_detalle_pago (reserva_id, referencia_pago, concepto) VALUES ('00000000-0000-0000-0000-0000000000e1','PAY-099','EMISION')$q$);
SELECT pg_temp.debe_fallar('infante sin adulto responsable', '23514', $q$INSERT INTO reserva_detalle_pasajero (reserva_id, codigo_pasajero, tipo_pasajero, nombres, apellidos, tipo_documento, numero_documento, pais_nacionalidad_id, fecha_nacimiento, genero, correo, telefono) VALUES ('00000000-0000-0000-0000-0000000000e1','PAX9','INFANTE','B','P','CEDULA','1750000009',1,'2026-01-01','X','a@b.co','+593991234567')$q$);
SELECT pg_temp.debe_fallar('adulto responsable de otra reserva', '23514', $q$INSERT INTO reserva_detalle_pasajero (reserva_id, codigo_pasajero, tipo_pasajero, adulto_responsable_id, nombres, apellidos, tipo_documento, numero_documento, pais_nacionalidad_id, fecha_nacimiento, genero, correo, telefono) VALUES ('00000000-0000-0000-0000-0000000000e1','PAX9','INFANTE',3,'B','P','CEDULA','1750000009',1,'2026-01-01','X','a@b.co','+593991234567')$q$);
SELECT pg_temp.debe_fallar('segundo infante para el mismo adulto', '23505', $q$INSERT INTO reserva_detalle_pasajero (reserva_id, codigo_pasajero, tipo_pasajero, adulto_responsable_id, nombres, apellidos, tipo_documento, numero_documento, pais_nacionalidad_id, fecha_nacimiento, genero, correo, telefono) VALUES ('00000000-0000-0000-0000-0000000000e1','PAX9','INFANTE',1,'B','P','CEDULA','1750000009',1,'2026-01-01','X','a@b.co','+593991234567')$q$);
SELECT pg_temp.debe_fallar('passengerId repetido en la reserva', '23505', $q$INSERT INTO reserva_detalle_pasajero (reserva_id, codigo_pasajero, tipo_pasajero, nombres, apellidos, tipo_documento, numero_documento, pais_nacionalidad_id, fecha_nacimiento, genero, correo, telefono) VALUES ('00000000-0000-0000-0000-0000000000e1','PAX1','ADULTO','B','P','CEDULA','1750000009',1,'1990-01-01','X','a@b.co','+593991234567')$q$);
SELECT pg_temp.debe_fallar('pasaporte sin fecha de vencimiento', '23514', $q$INSERT INTO reserva_detalle_pasajero (reserva_id, codigo_pasajero, tipo_pasajero, nombres, apellidos, tipo_documento, numero_documento, pais_nacionalidad_id, fecha_nacimiento, genero, correo, telefono) VALUES ('00000000-0000-0000-0000-0000000000e1','PAX9','ADULTO','B','P','PASAPORTE','XY99887',2,'1990-01-01','X','a@b.co','+593991234567')$q$);
SELECT pg_temp.debe_fallar('correo invalido', '23514', $q$UPDATE reserva_detalle_pasajero SET correo = 'sin-arroba' WHERE id = 1$q$);
SELECT pg_temp.debe_fallar('telefono invalido', '23514', $q$UPDATE reserva_detalle_pasajero SET telefono = '099-123' WHERE id = 1$q$);
SELECT pg_temp.debe_fallar('equipaje con pago de otra reserva', '23514', $q$INSERT INTO reserva_detalle_equipaje (pasajero_id, reserva_itinerario_id, pago_id, cantidad, precio_unitario) VALUES (1,2,2,1,20)$q$);
SELECT pg_temp.debe_fallar('equipaje con itinerario de otra reserva', '23514', $q$INSERT INTO reserva_detalle_equipaje (pasajero_id, reserva_itinerario_id, pago_id, cantidad, precio_unitario) VALUES (1,3,3,1,20)$q$);
SELECT pg_temp.debe_fallar('equipaje con cantidad cero', '23514', $q$INSERT INTO reserva_detalle_equipaje (pasajero_id, reserva_itinerario_id, pago_id, cantidad, precio_unitario) VALUES (1,2,3,0,20)$q$);
SELECT pg_temp.debe_fallar('dos lineas vigentes con el mismo orden', '23505', $q$UPDATE reserva_detalle_itinerario SET vigente = true WHERE id = 1$q$);
SELECT pg_temp.debe_fallar('boleto emitido sin numero', '23514', $q$UPDATE boleto_cabecera SET estado = 'EMITIDO' WHERE id = '00000000-0000-0000-0000-0000000000f2'$q$);
SELECT pg_temp.debe_fallar('numero de boleto repetido', '23505', $q$UPDATE boleto_cabecera SET numero_boleto = '9991234567890' WHERE id = '00000000-0000-0000-0000-0000000000f2'$q$);
SELECT pg_temp.debe_fallar('segundo boleto activo del pasajero', '23505', $q$INSERT INTO boleto_cabecera (pasajero_id) VALUES (1)$q$);
SELECT pg_temp.debe_fallar('cupon emitido sin numero', '23514', $q$UPDATE boleto_detalle SET estado = 'EMITIDO' WHERE boleto_id = '00000000-0000-0000-0000-0000000000f2'$q$);
SELECT pg_temp.debe_fallar('segunda cancelacion aceptada', '23505', $q$INSERT INTO cotizacion_cancelacion (reserva_id, monto_reembolso, monto_penalidad, fecha_expiracion, fecha_aceptacion) VALUES ('00000000-0000-0000-0000-0000000000e2',1,1, now() + interval '5 min', now())$q$);
SELECT pg_temp.debe_fallar('cotizacion aceptada ya vencida', '23514', $q$INSERT INTO cotizacion_cancelacion (reserva_id, monto_reembolso, monto_penalidad, fecha_expiracion, fecha_aceptacion) VALUES ('00000000-0000-0000-0000-0000000000e1',1,1, now() + interval '5 min', now() + interval '6 min')$q$);
SELECT pg_temp.debe_fallar('cambio resuelto sin fecha', '23514', $q$INSERT INTO cambio_cabecera (reserva_id, estado, fecha_expiracion) VALUES ('00000000-0000-0000-0000-0000000000e1','CONFIRMADO', now() + interval '5 min')$q$);
SELECT pg_temp.debe_fallar('check-in registrado dos veces', '23505', $q$INSERT INTO checkin (pasajero_id, vuelo_programado_id, estado) VALUES (2,'00000000-0000-0000-0000-0000000000a2','REGISTRADO')$q$);
SELECT pg_temp.debe_fallar('webhook activo repetido', '23505', $q$INSERT INTO webhook_cabecera (id_propietario, url, secreto) VALUES ('integrador-1','https://ejemplo.test/hook','otro')$q$);
SELECT pg_temp.debe_fallar('url de webhook invalida', '23514', $q$INSERT INTO webhook_cabecera (id_propietario, url, secreto) VALUES ('integrador-1','ftp://x','otro')$q$);
SELECT pg_temp.debe_fallar('evento sin reserva ni retencion', '23514', $q$INSERT INTO evento (tipo_evento_id) VALUES (1)$q$);
SELECT pg_temp.debe_fallar('entrega marcada sin codigo HTTP', '23514', $q$INSERT INTO evento_entrega (evento_id, webhook_id, numero_intento, entregado) VALUES ('00000000-0000-0000-0000-000000000d01','00000000-0000-0000-0000-000000000c01',3,true)$q$);
SELECT pg_temp.debe_fallar('clave de idempotencia repetida', '23505', $q$INSERT INTO clave_idempotencia (id_propietario, operacion, clave, huella_solicitud, fecha_expiracion) VALUES ('usuario-1','CREAR_RESERVA','11111111-1111-4111-8111-111111111111', repeat('b',64), now() + interval '1 hour')$q$);
SELECT pg_temp.debe_fallar('cupo de cabina repetido en el vuelo', '23505', $q$INSERT INTO inventario_cabina (vuelo_programado_id, clase_cabina, cupos_totales, cupos_disponibles) VALUES ('00000000-0000-0000-0000-0000000000a1','ECONOMICA',10,10)$q$);
SELECT pg_temp.debe_fallar('codigo ISO-3 de pais invalido', '23514', $q$INSERT INTO pais (codigo_iso2, codigo_iso3, nombre) VALUES ('PE','pe','Peru')$q$);
SELECT pg_temp.debe_fallar('editar una fila de auditoria', '42501', $q$UPDATE auditoria SET id_usuario = 'otro' WHERE id = 1$q$);
SELECT pg_temp.debe_fallar('borrar una fila de auditoria', '42501', $q$DELETE FROM auditoria WHERE id = 1$q$);
SELECT pg_temp.debe_fallar('vaciar la auditoria con TRUNCATE', '42501', $q$TRUNCATE auditoria$q$);
SELECT pg_temp.debe_fallar('estado fuera del ENUM', '22P02', $q$UPDATE reserva_cabecera SET estado = 'INVENTADO' WHERE pnr = 'AB12CD'$q$);
SELECT pg_temp.debe_fallar('borrar aeropuerto en uso', '23503|23001', $q$DELETE FROM aeropuerto WHERE codigo_iata = 'UIO'$q$);
SELECT pg_temp.debe_fallar('borrar una reserva', '23503|23001', $q$DELETE FROM reserva_cabecera WHERE pnr = 'AB12CD'$q$);
SELECT pg_temp.debe_fallar('borrar oferta con retenciones', '23503|23001', $q$DELETE FROM oferta_cabecera WHERE id = '00000000-0000-0000-0000-0000000000c1'$q$);
\pset tuples_only off

\echo
\echo === PURGA DE OFERTA SIN RETENCIONES (cascada a detalle) ===
INSERT INTO oferta_detalle (oferta_id, itinerario_id, orden) VALUES ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000b1',1);
DELETE FROM oferta_cabecera WHERE id = '00000000-0000-0000-0000-0000000000c2';
SELECT count(*) AS detalle_huerfano FROM oferta_detalle WHERE oferta_id = '00000000-0000-0000-0000-0000000000c2';

\echo
\echo === AUDITORIA ===
-- 1) quien actua: la API lo fija dentro de la transaccion
BEGIN;
SELECT set_config('app.id_usuario', 'usuario-1', true) AS usuario, set_config('app.direccion_ip', '190.15.130.7', true) AS ip;
UPDATE aerolinea SET activo = false WHERE codigo_iata = 'Z9';
COMMIT;
-- 2) fuera de esa transaccion el valor ya no existe; ademas una IP mal formada no rompe el cambio
BEGIN;
SELECT set_config('app.direccion_ip', 'no-es-una-ip', true) AS ip_mala;
UPDATE aerolinea SET activo = true WHERE codigo_iata = 'Z9';
COMMIT;
-- 3) un UPDATE que no cambia nada no deja rastro
UPDATE aerolinea SET nombre = nombre WHERE codigo_iata = 'Z9';
-- 4) con la auditoria apagada no se registra
BEGIN; SET LOCAL app.auditoria = 'off'; UPDATE aerolinea SET nombre = 'Sin rastro' WHERE codigo_iata = 'Z9'; COMMIT;
-- 5) baja fisica
INSERT INTO modelo_aeronave (codigo_iata, nombre) VALUES ('XXX', 'Temporal');
DELETE FROM modelo_aeronave WHERE codigo_iata = 'XXX';

SELECT nombre_tabla, operacion, id_usuario, direccion_ip, datos_anteriores::text AS antes, datos_nuevos::text AS despues
FROM auditoria WHERE nombre_tabla = 'aerolinea' AND operacion = 'ACTUALIZACION' ORDER BY id;
SELECT operacion, datos_anteriores ->> 'codigo_iata' AS antes, datos_nuevos ->> 'codigo_iata' AS despues
FROM auditoria WHERE nombre_tabla = 'modelo_aeronave' AND COALESCE(datos_anteriores, datos_nuevos) ->> 'codigo_iata' = 'XXX' ORDER BY id;
SELECT operacion, datos_anteriores::text AS antes, (datos_nuevos - 'fecha_actualizacion')::text AS despues_sin_fecha
FROM auditoria WHERE nombre_tabla = 'reserva_cabecera' AND operacion = 'ACTUALIZACION' ORDER BY id;
SELECT datos_nuevos ->> 'secreto' AS secreto_en_el_log, datos_nuevos ->> 'url' AS url FROM auditoria WHERE nombre_tabla = 'webhook_cabecera';
SELECT count(*) AS filas, count(DISTINCT nombre_tabla) AS tablas_con_rastro,
       count(*) FILTER (WHERE nombre_tabla IN ('inventario_cabina','oferta_cabecera','itinerario_cabecera','evento','clave_idempotencia','auditoria')) AS de_tablas_excluidas
FROM auditoria;

\echo
\echo === INVENTARIO DEL ESQUEMA ===
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema='vuelos' AND table_type='BASE TABLE') AS tablas,
       (SELECT count(*) FROM information_schema.views WHERE table_schema='vuelos') AS vistas,
       (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='vuelos' AND t.typtype='e') AS enums,
       (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='vuelos' AND c.contype='f') AS fks,
       (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='vuelos' AND c.contype='c') AS checks,
       (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='vuelos' AND c.contype='u') AS uniques,
       (SELECT count(*) FROM pg_indexes WHERE schemaname='vuelos') AS indices,
       (SELECT count(*) FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='vuelos' AND NOT tg.tgisinternal) AS triggers,
       (SELECT count(*) FROM tipo_evento) AS tipos_evento;

\echo === Tablas sin comentario / columnas FK sin indice que las cubra ===
SELECT c.relname AS tabla_sin_comentario FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='vuelos' AND c.relkind='r' AND obj_description(c.oid,'pg_class') IS NULL;
SELECT con.conrelid::regclass AS tabla, con.conname AS fk_sin_indice
FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
WHERE n.nspname = 'vuelos' AND con.contype = 'f'
  AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = con.conrelid AND (i.indkey::int2[])[0:cardinality(con.conkey)-1] = con.conkey)
ORDER BY 1, 2;
