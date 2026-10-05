import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './filters/problem-details.filter';

@Module({
  imports: [],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
  exports: [],
})
export class CommonModule {}
