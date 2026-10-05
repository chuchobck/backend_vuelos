import { Module } from '@nestjs/common';
import { AerolineaModule } from './aerolinea/aerolinea.module';
import { AeropuertoModule } from './aeropuerto/aeropuerto.module';
import { CiudadModule } from './ciudad/ciudad.module';
import { FamiliaTarifaModule } from './familia-tarifa/familia-tarifa.module';
import { MapaAsientosModule } from './mapa-asientos/mapa-asientos.module';
import { ModeloAeronaveModule } from './modelo-aeronave/modelo-aeronave.module';
import { PaisModule } from './pais/pais.module';

/**
 * CRUD de administración del catálogo (fuera del contrato, solo `flights:admin`). Junta un
 * módulo por entidad; sus rutas cuelgan de /flights/v1/admin (catalogo.routes.ts).
 */
@Module({
  imports: [
    PaisModule,
    CiudadModule,
    AeropuertoModule,
    AerolineaModule,
    ModeloAeronaveModule,
    FamiliaTarifaModule,
    MapaAsientosModule,
  ],
})
export class CatalogoModule {}
