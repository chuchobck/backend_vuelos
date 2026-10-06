import { CODIGO_SIN_EQUIVALENTE } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { fechaIsoAUtc } from '../../../../common/pipes/formatos';
import { tipo_pasajero } from '../../../../generated/prisma/client';
import { GENERO, TIPO_DOCUMENTO, TIPO_PASAJERO } from '../../compartido/enums';
import { cuerpoInvalido } from '../../compartido/errores';
import { PasajeroReservaDto } from './dto/solicitud-reserva.dto';
import { PasajeroNuevo } from './reserva.repository';

/**
 * Edades de cada tipo de pasajero, cumplidas el día de la primera salida (fecha local):
 * INFANT menos de 2, CHILD de 2 a 11, YOUTH de 12 a 17, ADULT 18 o más. Un infante además debe
 * seguir teniendo menos de 2 el día de la última salida (si no, necesitaría asiento).
 */
export const EDADES = { infanteHasta: 2, ninoHasta: 12, jovenHasta: 18 };

/** La primera fecha de nacimiento que acepta la base (ck_reserva_detalle_pasajero_nacimiento). */
const NACIMIENTO_MINIMO = new Date('1900-01-01T00:00:00.000Z');

/** Lo que se sabe del hold para validar a sus pasajeros. */
export interface ContextoPasajeros {
  /** Cuántos pasajeros de cada tipo retuvo el hold. */
  conteo: Record<tipo_pasajero, number>;
  /** Fechas locales (un `date`) de la primera y de la última salida. */
  primeraSalida: Date;
  ultimaSalida: Date;
  /** Países activos por código ISO alfa-2. */
  paises: Map<string, bigint>;
}

/** 422: el pasajero es válido por sí solo, pero no corresponde al hold o al catálogo. */
const noCorresponde = (campo: string, detalle: string) =>
  new ErrorNegocio(422, CODIGO_SIN_EQUIVALENTE, `${campo}: ${detalle}`, {
    invalidParams: [{ name: campo, reason: detalle }],
  });

/**
 * Valida los pasajeros contra sí mismos (400) y contra el hold y el catálogo (422), y los
 * devuelve listos para guardar. Los mensajes nombran el campo, nunca el dato: un nombre o un
 * documento no aparecen en el error ni en el log.
 */
export function validarPasajeros(
  pasajeros: PasajeroReservaDto[],
  contexto: ContextoPasajeros,
): PasajeroNuevo[] {
  const codigos = new Set<string>();
  const documentos = new Set<string>();
  pasajeros.forEach((p, i) => {
    if (codigos.has(p.passengerId)) {
      throw cuerpoInvalido(`passengers[${i}].passengerId`, 'is repeated');
    }
    codigos.add(p.passengerId);
    const documento = `${p.documentType}|${p.documentNumber}`;
    if (documentos.has(documento)) {
      throw cuerpoInvalido(`passengers[${i}].documentNumber`, 'is repeated in this booking');
    }
    documentos.add(documento);
  });

  validarConteo(pasajeros, contexto.conteo);
  validarInfantes(pasajeros);

  return pasajeros.map((p, i) => {
    const campo = `passengers[${i}]`;
    const tipo = TIPO_PASAJERO.aBase(p.passengerType);
    const nacimiento = fechaIsoAUtc(p.birthDate)!;
    if (nacimiento < NACIMIENTO_MINIMO) {
      throw cuerpoInvalido(`${campo}.birthDate`, 'must not be before 1900-01-01');
    }
    validarEdad(tipo, nacimiento, contexto, campo);

    const tipoDocumento = TIPO_DOCUMENTO.aBase(p.documentType);
    const vencimiento = p.documentExpiryDate ? fechaIsoAUtc(p.documentExpiryDate)! : null;
    if (tipoDocumento === 'PASAPORTE' && vencimiento === null) {
      throw cuerpoInvalido(`${campo}.documentExpiryDate`, 'is required for a PASSPORT');
    }
    if (vencimiento !== null && vencimiento <= contexto.ultimaSalida) {
      throw noCorresponde(
        `${campo}.documentExpiryDate`,
        'the document expires before the trip ends',
      );
    }
    if (tipoDocumento === 'CEDULA' && p.nationality === 'EC' && !esCedulaValida(p.documentNumber)) {
      throw cuerpoInvalido(`${campo}.documentNumber`, 'is not a valid Ecuadorian national ID');
    }
    const paisId = contexto.paises.get(p.nationality);
    if (paisId === undefined) {
      throw noCorresponde(`${campo}.nationality`, 'is not a country this API knows');
    }
    if ((p.extraBaggage ?? []).length > 0) {
      throw noCorresponde(
        `${campo}.extraBaggage`,
        'extra baggage is bought after booking, with POST /bookings/{bookingId}/baggage',
      );
    }

    return {
      codigo: p.passengerId,
      tipo,
      adultoResponsable: tipo === 'INFANTE' ? p.associatedAdultId! : null,
      nombres: p.firstName,
      apellidos: p.lastName,
      tipoDocumento,
      numeroDocumento: p.documentNumber,
      paisId,
      vencimientoDocumento: vencimiento,
      nacimiento,
      genero: GENERO.aBase(p.gender),
      correo: p.contact.email,
      telefono: p.contact.phone,
    };
  });
}

/** Los pasajeros de cada tipo son exactamente los del hold (422 si no). */
function validarConteo(pasajeros: PasajeroReservaDto[], conteo: Record<tipo_pasajero, number>) {
  for (const tipo of ['ADULTO', 'JOVEN', 'NINO', 'INFANTE'] as const) {
    const enviados = pasajeros.filter((p) => TIPO_PASAJERO.aBase(p.passengerType) === tipo).length;
    if (enviados !== conteo[tipo]) {
      throw noCorresponde(
        'passengers',
        `the hold is for ${conteo[tipo]} ${TIPO_PASAJERO.aContrato(tipo)} passenger(s), ` +
          `not ${enviados}`,
      );
    }
  }
}

/**
 * Cada infante lleva el passengerId de un ADULT de la reserva (associatedAdultId) y cada
 * adulto lleva a lo sumo un infante; los demás no llevan associatedAdultId. 400 si no.
 */
function validarInfantes(pasajeros: PasajeroReservaDto[]) {
  const adultos = new Set(
    pasajeros.filter((p) => p.passengerType === 'ADULT').map((p) => p.passengerId),
  );
  const conInfante = new Set<string>();
  pasajeros.forEach((p, i) => {
    const campo = `passengers[${i}].associatedAdultId`;
    if (p.passengerType !== 'INFANT') {
      if (p.associatedAdultId !== undefined) throw cuerpoInvalido(campo, 'is only for INFANT');
      return;
    }
    if (p.associatedAdultId === undefined) throw cuerpoInvalido(campo, 'is required for INFANT');
    if (!adultos.has(p.associatedAdultId)) {
      throw cuerpoInvalido(campo, 'must be the passengerId of an ADULT of this booking');
    }
    if (conInfante.has(p.associatedAdultId)) {
      throw cuerpoInvalido(campo, 'each adult can travel with only one infant');
    }
    conInfante.add(p.associatedAdultId);
  });
}

/** La edad el día de la primera salida debe ser la del tipo de pasajero (EDADES). */
function validarEdad(
  tipo: tipo_pasajero,
  nacimiento: Date,
  contexto: ContextoPasajeros,
  campo: string,
) {
  const edad = edadEn(nacimiento, contexto.primeraSalida);
  if (edad < 0) throw noCorresponde(`${campo}.birthDate`, 'is after the first departure');
  if (tipoPorEdad(edad) !== tipo) {
    throw noCorresponde(
      `${campo}.birthDate`,
      `does not match passengerType ${TIPO_PASAJERO.aContrato(tipo)} ` +
        `(INFANT under ${EDADES.infanteHasta}, CHILD under ${EDADES.ninoHasta}, ` +
        `YOUTH under ${EDADES.jovenHasta}, ADULT from ${EDADES.jovenHasta}, at the first departure)`,
    );
  }
  if (tipo === 'INFANTE' && edadEn(nacimiento, contexto.ultimaSalida) >= EDADES.infanteHasta) {
    throw noCorresponde(
      `${campo}.birthDate`,
      `an INFANT must be under ${EDADES.infanteHasta} on every flight; book a seat instead`,
    );
  }
}

function tipoPorEdad(edad: number): tipo_pasajero {
  if (edad < EDADES.infanteHasta) return 'INFANTE';
  if (edad < EDADES.ninoHasta) return 'NINO';
  if (edad < EDADES.jovenHasta) return 'JOVEN';
  return 'ADULTO';
}

/** Años cumplidos en `fecha` (las dos a medianoche UTC). */
export function edadEn(nacimiento: Date, fecha: Date): number {
  const anios = fecha.getUTCFullYear() - nacimiento.getUTCFullYear();
  const mes = fecha.getUTCMonth() - nacimiento.getUTCMonth();
  const antesDelCumple = mes < 0 || (mes === 0 && fecha.getUTCDate() < nacimiento.getUTCDate());
  return antesDelCumple ? anios - 1 : anios;
}

/**
 * Cédula ecuatoriana de persona natural: 10 dígitos, provincia 01 a 24 (o 30, nacidos en el
 * exterior), tercer dígito menor que 6 y dígito verificador por módulo 10 (coeficientes
 * 2,1,2,1,...; un producto mayor que 9 resta 9).
 */
export function esCedulaValida(numero: string): boolean {
  if (!/^[0-9]{10}$/.test(numero)) return false;
  const provincia = Number(numero.slice(0, 2));
  if (!((provincia >= 1 && provincia <= 24) || provincia === 30)) return false;
  if (Number(numero[2]) >= 6) return false;
  let suma = 0;
  for (let i = 0; i < 9; i++) {
    let producto = Number(numero[i]) * (i % 2 === 0 ? 2 : 1);
    if (producto > 9) producto -= 9;
    suma += producto;
  }
  return (10 - (suma % 10)) % 10 === Number(numero[9]);
}
