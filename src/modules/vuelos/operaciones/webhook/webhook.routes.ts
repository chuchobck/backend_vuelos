import { Routes } from '@nestjs/core';
import { WebhookApiModule } from './webhook-api.module';

export const webhookRoutes: Routes = [{ path: 'webhooks', module: WebhookApiModule }];
