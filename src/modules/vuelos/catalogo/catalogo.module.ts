import { Module } from '@nestjs/common';

/**
 * CRUD de administración del catálogo (fuera del contrato, solo `flights:admin`). Junta un
 * módulo por entidad; sus rutas cuelgan de /flights/v1/admin (catalogo.routes.ts).
 */
@Module({
  imports: [],
})
export class CatalogoModule {}
