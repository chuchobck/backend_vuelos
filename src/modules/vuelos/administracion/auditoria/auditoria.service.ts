import { Injectable } from '@nestjs/common';
import { fechaIsoAUtc } from '../../../../common/pipes/formatos';
import { cursorInvalido, cuerpoInvalido } from '../../catalogo/base/errores-catalogo';
import { codificarCursor, decodificarCursor } from '../../catalogo/base/paginacion';
import { operacionABase } from './auditoria.mapper';
import { AuditoriaRepository, FilaAuditoria } from './auditoria.repository';
import { ConsultaAuditoriaDto, LIMITE_AUDITORIA_POR_DEFECTO } from './dto/auditoria.dto';

const DIA_MS = 86_400_000;

@Injectable()
export class AuditoriaService {
  constructor(private readonly repositorio: AuditoriaRepository) {}

  /**
   * Una página de eventos, del más reciente al más viejo. El cursor es la fecha y el id del
   * último evento de la página (`fecha|id`, en base64url). `from` y `to` son días UTC
   * completos, los dos incluidos.
   */
  async listar(
    consulta: ConsultaAuditoriaDto,
  ): Promise<{ filas: FilaAuditoria[]; nextCursor?: string }> {
    const limite = consulta.limit ?? LIMITE_AUDITORIA_POR_DEFECTO;
    const desde = consulta.from ? fechaIsoAUtc(consulta.from) : undefined;
    const hasta = consulta.to ? new Date(fechaIsoAUtc(consulta.to)!.getTime() + DIA_MS) : undefined;
    if (desde && hasta && desde >= hasta) throw cuerpoInvalido('to', 'must not be before from');

    const filas = await this.repositorio.listar({
      tabla: consulta.table,
      operacion: consulta.operation ? operacionABase(consulta.operation) : undefined,
      idRegistro: consulta.recordId,
      idUsuario: consulta.userId,
      desde,
      hasta,
      despuesDe: consulta.cursor ? leerCursor(consulta.cursor) : undefined,
      limite,
    });
    if (filas.length <= limite) return { filas };
    const ultima = filas[limite - 1];
    return {
      filas: filas.slice(0, limite),
      nextCursor: codificarCursor(`${ultima.fecha.toISOString()}|${ultima.id}`),
    };
  }
}

/** El cursor de la auditoría: `fecha|id`. Cualquier otro texto es 400. */
export function leerCursor(cursor: string): { fecha: Date; id: bigint } {
  const [fecha, id, ...resto] = (decodificarCursor(cursor) ?? '').split('|');
  const instante = new Date(fecha);
  if (resto.length > 0 || Number.isNaN(instante.getTime()) || !/^[0-9]{1,18}$/.test(id ?? '')) {
    throw cursorInvalido();
  }
  return { fecha: instante, id: BigInt(id) };
}
