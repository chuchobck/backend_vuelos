import { tipo_pasajero } from '../../../generated/prisma/client';
import { MAXIMO_PASAJEROS_CON_ASIENTO, PasajerosDto } from './dto/pasajeros.dto';
import { cuerpoInvalido } from './errores';

/** Cuántos pasajeros de cada tipo se pidieron (solo los que son más de 0), en el orden del contrato. */
export type ConteoPasajeros = ReadonlyArray<{ tipo: tipo_pasajero; cantidad: number }>;

/**
 * PassengerBreakdown con sus valores por defecto y las reglas de la base que el DTO no ve: a lo
 * sumo 9 pasajeros con asiento (ck_retencion_cabecera_maximo) y no más infantes que adultos
 * (ck_retencion_cabecera_infantes). Las comparten la búsqueda y el hold. 400 si no se cumplen.
 */
export function validarPasajeros(p: PasajerosDto, campo: string): ConteoPasajeros {
  const adultos = p.adults ?? 1;
  const jovenes = p.youths ?? 0;
  const ninos = p.children ?? 0;
  const infantes = p.infants ?? 0;
  if (adultos + jovenes + ninos > MAXIMO_PASAJEROS_CON_ASIENTO) {
    throw cuerpoInvalido(
      campo,
      `at most ${MAXIMO_PASAJEROS_CON_ASIENTO} passengers with a seat (adults, youths and children)`,
    );
  }
  if (infantes > adultos) {
    throw cuerpoInvalido(
      `${campo}.infants`,
      'cannot exceed adults (each infant travels with an adult)',
    );
  }
  const conteo: Array<{ tipo: tipo_pasajero; cantidad: number }> = [
    { tipo: 'ADULTO', cantidad: adultos },
    { tipo: 'JOVEN', cantidad: jovenes },
    { tipo: 'NINO', cantidad: ninos },
    { tipo: 'INFANTE', cantidad: infantes },
  ];
  return conteo.filter((c) => c.cantidad > 0);
}

/** Los infantes viajan en brazos: no ocupan asiento ni cupo. */
export function asientosOcupados(pasajeros: ConteoPasajeros): number {
  return pasajeros.filter((p) => p.tipo !== 'INFANTE').reduce((suma, p) => suma + p.cantidad, 0);
}
