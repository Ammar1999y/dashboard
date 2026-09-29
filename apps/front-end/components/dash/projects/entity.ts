import { defineEntity } from '../shared/entity';

export const projectEntity = defineEntity({
  scope: 'projects',
  api: '/api/dash/projects',
  route: '/dash/projects',
  noun: 'المشروع',
});
