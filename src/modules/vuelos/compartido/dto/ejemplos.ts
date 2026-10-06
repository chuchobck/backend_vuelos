/**
 * Una fecha `YYYY-MM-DD` a `dias` días de hoy (UTC), para los ejemplos de Swagger. Se calcula al
 * arrancar la API: el ejemplo de la búsqueda cae siempre dentro de los 90 días que cubre la
 * semilla (si se cargó hace menos de 90 − `dias` días), en vez de una fecha fija que vence.
 */
export function fechaDeEjemplo(dias: number): string {
  const fecha = new Date();
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}
