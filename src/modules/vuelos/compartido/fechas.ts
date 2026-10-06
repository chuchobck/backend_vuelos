/**
 * Fecha local de un instante en una zona horaria IANA, a medianoche UTC como un `date` de la
 * base. Es vuelo_programado.fecha_salida: la fecha en el aeropuerto de origen.
 */
export function fechaLocal(instante: Date, zonaHoraria: string): Date {
  const texto = new Intl.DateTimeFormat('en-CA', {
    timeZone: zonaHoraria,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instante);
  return new Date(`${texto}T00:00:00.000Z`);
}

/** Un `date` (medianoche UTC) más `dias` días. */
export function sumarDias(fecha: Date, dias: number): Date {
  return new Date(fecha.getTime() + dias * 24 * 60 * 60 * 1000);
}
