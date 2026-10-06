import { Routes } from '@nestjs/core';
import { WebhookModule } from './webhook.module';

export const webhookRoutes: Routes = [{ path: 'webhooks', module: WebhookModule }];
