import { defineEntity } from '../shared/entity';

export const sectionEntity = defineEntity({
  scope: 'sections',
  api: '/api/dash/sections',
  route: '/dash/sections',
  noun: 'القسم',
});
