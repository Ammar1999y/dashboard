import type { Entity } from './entity';
import type { EntityID } from '@app/shared/types';
import type { ComponentType } from 'react';

import { useRouter } from 'next/router';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { validID } from '@app/shared/utils';
import { MSG_INVALID_LINK } from '@/constants/messages';
import { useQueryData } from '@/lib/api/query';

import { ErrorState } from '@/components/ui/error-state';
import { LoadingState } from '@/components/ui/loading-state';

const INVALID_LINK = new CustomError(MSG_INVALID_LINK, HTTP_STATUS.NOT_FOUND);

interface EditRecordProps<TRow> {
  entity: Entity;
  /** A module-level component, remounted per record. */
  Form: ComponentType<{ record: TRow }>;
}

/**
 * Loads the record named by the route's `[id]` and mounts `Form` only once it
 * is in hand, so `defaultValues` seeds the form synchronously. Seeding it
 * afterwards — through `values` or a `reset` effect — lands one commit too late
 * for the parts that read the form once on mount, such as the rich-text editor
 * and the permission matrix.
 */
export function EditRecord<TRow extends { id: EntityID }>({
  entity,
  Form,
}: EditRecordProps<TRow>) {
  const { query, isReady } = useRouter();
  const id = validID(query.id);

  const { data, isPending, error, refetch } = useQueryData<TRow>({
    queryKey: entity.keys.detail(id),
    href: entity.itemHref(id),
    enabled: !!id,
  });

  // The query is empty until the router has parsed the URL: still loading.
  if (!isReady || (id && isPending)) return <LoadingState />;
  if (!id) return <ErrorState error={INVALID_LINK} />;
  if (!data?.id) return <ErrorState error={error} refetch={refetch} />;

  return <Form key={data.id} record={data} />;
}
