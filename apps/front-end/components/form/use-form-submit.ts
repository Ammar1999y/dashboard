import type {
  FieldErrors,
  FieldValues,
  SubmitHandler,
  UseFormReturn,
} from 'react-hook-form';

import { useEffect, useMemo } from 'react';

import { toastError } from '@/utils/mutation';

import { flattenErrors, showFormErrors } from './form-errors';
import { clearFormErrors, setFormErrors } from './store';

function reportInvalidForm(errors: FieldErrors) {
  const flat = flattenErrors(errors);
  showFormErrors(flat);
  setFormErrors(flat);
}

/**
 * The submit handler every form needs, owning the error store's lifecycle:
 * cleared when a run starts, filled when validation fails, and cleared on
 * unmount — or the next form mounts showing this one's errors against any
 * field that shares a path.
 *
 * A rejected request is toasted here, so `onValid` is written as the success
 * path. Catch only an error you handle differently, and rethrow the rest.
 *
 * `onValid` receives the schema's output: give `useForm` its
 * `<Input, unknown, Output>` parameters and the type follows through.
 */
export function useFormSubmit<
  TInput extends FieldValues,
  TContext,
  TOutput extends FieldValues,
>(
  methods: UseFormReturn<TInput, TContext, TOutput>,
  onValid: SubmitHandler<TOutput>
) {
  const { handleSubmit } = methods;

  useEffect(() => clearFormErrors, []);

  return useMemo(
    () =>
      handleSubmit(async (data, event) => {
        clearFormErrors();
        try {
          await onValid(data, event);
        } catch (error) {
          toastError(error);
        }
      }, reportInvalidForm),
    [handleSubmit, onValid]
  );
}
