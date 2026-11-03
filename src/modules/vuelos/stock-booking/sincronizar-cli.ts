import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { Reloj } from '../../../common/reloj';
import { StockBookingRepository } from './stock-booking.repository';
import { SincronizadorStock } from './sincronizador-stock';
import { ResultadoCorridaStock, StockBookingWorker } from './stock-booking.worker';

const USO = 'Uso: npm run stock:sincronizar -- [--dry-run]';

/**
 * `npm run stock:sincronizar`: la sincronización completa del stock a Booking (scripts/sincronizar-stock.cjs
 * apaga los procesos periódicos y el servidor antes de arrancar esto).
 *
 *   --dry-run   imprime, una línea JSON por registro, lo que mandaría; no escribe ni llama a nadie.
 *   (sin nada)  registra una orden por cada (salida, cabina) de los próximos BOOKING_STOCK_DIAS días
 *               y las manda con el mismo trabajador del servicio (concurrencia baja, cortacircuitos,
 *               reintentos) hasta que no quede ninguna lista. Lo que espere un reintento queda a cargo
 *               del servicio; un rechazo de Booking no se reintenta.
 *
 * Por pantalla salen conteos y, con --dry-run, los registros (item_id, fecha, hora, unidades:
 * ningún dato de pasajeros). Código de salida: 0 todo mandado, 1 hubo rechazos, fallos o espera.
 */
export async function main(argumentos: string[]): Promise<number> {
  const simulacro = argumentos.includes('--dry-run');
  if (argumentos.some((a) => a !== '--dry-run')) {
    console.error(USO);
    return 2;
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const sincronizador = app.get(SincronizadorStock, { strict: false });
    const { desde, hasta } = sincronizador.ventana();
    const ventana = `${desde.toISOString().slice(0, 10)} a ${hasta.toISOString().slice(0, 10)}`;

    if (simulacro) {
      const registros = await sincronizador.simular();
      for (const registro of registros) process.stdout.write(`${JSON.stringify(registro)}\n`);
      const sinCupo = registros.filter((r) => r.available_units === 0).length;
      console.error(
        `--dry-run: ${registros.length} registros (${sinCupo} con 0 unidades) para ${ventana}. ` +
          'No se escribió ni se llamó a nadie.',
      );
      return 0;
    }

    const claves = await sincronizador.registrar();
    console.error(`Registradas ${claves} claves para ${ventana}. Mandando a Booking...`);

    const worker = app.get(StockBookingWorker, { strict: false });
    const cola = app.get(StockBookingRepository, { strict: false });
    const reloj = app.get(Reloj, { strict: false });
    const total: ResultadoCorridaStock = {
      enviados: 0,
      reintentos: 0,
      rechazados: 0,
      fallidos: 0,
      bloqueados: 0,
    };
    for (;;) {
      const corrida = await worker.ejecutar();
      for (const campo of Object.keys(total) as Array<keyof ResultadoCorridaStock>) {
        total[campo] += corrida[campo];
      }
      console.error(
        `  enviados ${total.enviados}, reintentos ${total.reintentos}, ` +
          `rechazados ${total.rechazados}, fallidos ${total.fallidos}`,
      );
      const sinNovedad = Object.values(corrida).every((n) => n === 0);
      const { listas } = await cola.contar(reloj.ahora());
      if (sinNovedad || listas === 0 || corrida.bloqueados > 0) break;
    }
    const { listas, enEspera, fallidas } = await cola.contar(reloj.ahora());
    console.error(
      `Listo: ${total.enviados} enviados; ${fallidas} FALLIDAS, ${enEspera} esperando un reintento, ` +
        `${listas} sin mandar${total.bloqueados > 0 ? ' (el cortacircuitos de Booking está abierto)' : ''}.`,
    );
    return fallidas === 0 && enEspera === 0 && listas === 0 ? 0 : 1;
  } finally {
    await app.close();
  }
}
