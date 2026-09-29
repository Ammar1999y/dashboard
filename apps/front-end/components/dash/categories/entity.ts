import { defineEntity } from '../shared/entity';

export const categoryEntity = defineEntity({
  scope: 'projects-categories',
  api: '/api/dash/projects/categories',
  route: '/dash/projects/categories',
  noun: 'التصنيف',
});
