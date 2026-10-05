import { Module } from '@nestjs/common';
import { AerolineaModule } from './aerolinea/aerolinea.module';
import { AeropuertoModule } from './aeropuerto/aeropuerto.module';
import { CiudadModule } from './ciudad/ciudad.module';
import { ModeloAeronaveModule } from './modelo-aeronave/modelo-aeronave.module';
import { PaisModule } from './pais/pais.module';

/**
 * CRUD de administración del catálogo (fuera del contrato, solo `flights:admin`). Junta un
 * módulo por entidad; sus rutas cuelgan de /flights/v1/admin (catalogo.routes.ts).
 */
@Module({
  imports: [PaisModule, CiudadModule, AeropuertoModule, AerolineaModule, ModeloAeronaveModule],
})
export class CatalogoModule {}
