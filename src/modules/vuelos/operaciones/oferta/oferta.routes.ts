import { Routes } from '@nestjs/core';
import { OfertaModule } from './oferta.module';

export const ofertaRoutes: Routes = [{ path: 'offers', module: OfertaModule }];
