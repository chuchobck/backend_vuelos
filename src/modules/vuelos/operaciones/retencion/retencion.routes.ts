import { Routes } from '@nestjs/core';
import { RetencionModule } from './retencion.module';

/**
 * Va antes que las de oferta: /offers/hold/{holdId} y /offers/{offerId}/seatmap comparten el
 * prefijo /offers, y así hold nunca se lee como un offerId.
 */
export const retencionRoutes: Routes = [{ path: 'offers/hold', module: RetencionModule }];
