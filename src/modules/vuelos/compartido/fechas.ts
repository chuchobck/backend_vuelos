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

/**
 * Un instante como hora local de una zona horaria IANA, con su desplazamiento:
 * `2026-11-12T06:30:00-05:00`. Sigue siendo un instante sin ambigüedad, pero se lee como el reloj
 * del aeropuerto. Solo lo usa la pantalla pública de salidas; el resto de la API responde en UTC.
 */
export function aHoraLocal(instante: Date, zonaHoraria: string): string {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zonaHoraria,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(instante)
      .map((parte) => [parte.type, parte.value]),
  );
  // `GMT-05:00`; en UTC, solo `GMT`
  const desplazamiento = partes.timeZoneName.replace('GMT', '') || '+00:00';
  return `${partes.year}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}:${partes.second}${desplazamiento}`;
}
