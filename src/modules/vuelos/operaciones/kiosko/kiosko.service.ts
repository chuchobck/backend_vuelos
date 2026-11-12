import { Injectable } from '@nestjs/common';
import { fijarUsuario } from '../../../../common/contexto/contexto-peticion';
import { noExiste } from '../../compartido/errores';
import { ResultadoCheckin } from '../checkin/checkin.modelo';
import { CheckinService } from '../checkin/checkin.service';
import { PaseAbordar } from '../pase-abordar/pase-abordar.modelo';
import { PaseAbordarService } from '../pase-abordar/pase-abordar.service';
import { ReservaService } from '../reserva/reserva.service';
import { ComparadorApellidos } from './apellido';
import { ReservaEnKiosko } from './kiosko.modelo';
import { KioskoRepository } from './kiosko.repository';
import { SesionKiosko } from './sesion-kiosko';

/** Quién queda en la auditoría de un check-in hecho en un kiosko (no hay `sub`). */
export const ACTOR_KIOSKO = 'kiosko';

/**
 * El mismo 404 para un PNR que no existe, un apellido que no coincide y una sesión de otra
 * reserva: quien pregunta no aprende cuál de las tres cosas pasó. Sin PNR ni apellido.
 */
const noEncontrada = () => noExiste('Booking not found');

/**
 * Kiosko de check-in sin cuenta (fase F1, fuera del contrato; docs/F1-DISENO.md, sección 4).
 *
 * `buscar` encuentra una reserva por PNR y apellido y abre una sesión de 10 minutos limitada a
 * ella (`SesionKiosko`). Con esa sesión, `hacerCheckin` y `pases` llaman a los services de
 * siempre con el dueño real de la reserva: ninguna regla del check-in ni de los pases se repite
 * aquí. Ni el PNR ni el apellido van al log, a una traza ni a un error.
 */
@Injectable()
export class KioskoService {
  constructor(
    private readonly repositorio: KioskoRepository,
    private readonly comparador: ComparadorApellidos,
    private readonly sesiones: SesionKiosko,
    private readonly reservas: ReservaService,
    private readonly checkin: CheckinService,
    private readonly pasesDeAbordar: PaseAbordarService,
  ) {}

  /**
   * La reserva de ese PNR si el apellido es el de alguno de sus pasajeros (sin importar
   * mayúsculas, tildes ni espacios). La comparación se hace siempre, exista o no el PNR.
   */
  async buscar(pnr: string, apellido: string): Promise<ReservaEnKiosko> {
    const encontrada = await this.repositorio.porPnr(pnr.toUpperCase());
    const coincide = this.comparador.coincide(apellido, encontrada?.apellidos ?? []);
    if (!encontrada || !coincide) throw noEncontrada();

    const reserva = await this.reservas.detalle(encontrada.reservaId, encontrada.idPropietario);
    return {
      ...this.sesiones.emitir(reserva.id),
      reserva,
      checkin: await this.checkin.estadoDe(reserva),
    };
  }

  /** El check-in de la reserva de la sesión: el de POST /bookings/{bookingId}/check-in. */
  async hacerCheckin(
    autorizacion: string | undefined,
    reservaId: string,
  ): Promise<ResultadoCheckin> {
    const propietario = await this.autorizar(autorizacion, reservaId);
    // Sin cuenta no hay `sub`: la auditoría del check-in dice que lo hizo un kiosko
    fijarUsuario(ACTOR_KIOSKO);
    return this.checkin.hacer(reservaId, propietario);
  }

  /** Los pases de la reserva de la sesión: los de GET /bookings/{bookingId}/boarding-passes. */
  async pases(autorizacion: string | undefined, reservaId: string): Promise<PaseAbordar[]> {
    const propietario = await this.autorizar(autorizacion, reservaId);
    return this.pasesDeAbordar.consultar(reservaId, propietario);
  }

  /**
   * La sesión vale (401 si no) y es de ESA reserva (404 si es de otra, como una reserva ajena:
   * no se revela que existe). Devuelve el dueño de la reserva.
   */
  private async autorizar(autorizacion: string | undefined, reservaId: string): Promise<string> {
    const deLaSesion = this.sesiones.verificar(autorizacion);
    if (deLaSesion.toLowerCase() !== reservaId.toLowerCase()) throw noEncontrada();
    const propietario = await this.repositorio.propietario(deLaSesion);
    if (propietario === null) throw noEncontrada();
    return propietario;
  }
}
