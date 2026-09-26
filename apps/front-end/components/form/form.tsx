import type { ComponentProps } from 'react';
import type {
  FieldValues,
  SubmitHandler,
  UseFormReturn,
} from 'react-hook-form';

import { FormProvider, useFormState } from 'react-hook-form';
import { cn } from '@/lib/utils';

import { useFormSubmit } from './use-form-submit';

// The submit lock is read here, not by the component that calls `useForm`:
// reading `isSubmitting` up there re-renders the whole field tree — tabs,
// tables, editors — on every submit. `inert` is what actually blocks input.
const FormElement = ({ className, ...rest }: ComponentProps<'form'>) => {
  const { isSubmitting } = useFormState();
  return (
    <form
      {...rest}
      inert={isSubmitting}
      className={cn(
        'transition-[max-width,opacity]',
        className,
        isSubmitting && 'disabled'
      )}
    />
  );
};

interface FormProps<
  TFieldValues extends FieldValues,
  TContext,
  TTransformedValues extends FieldValues,
> extends Omit<ComponentProps<'form'>, 'onSubmit'> {
  methods: UseFormReturn<TFieldValues, TContext, TTransformedValues>;
  onSubmit: SubmitHandler<TTransformedValues>;
}

export function Form<
  TFieldValues extends FieldValues,
  TContext,
  TTransformedValues extends FieldValues,
>({
  methods,
  onSubmit,
  ...rest
}: FormProps<TFieldValues, TContext, TTransformedValues>) {
  const submit = useFormSubmit(methods, onSubmit);
  return (
    <FormProvider {...methods}>
      <FormElement {...rest} onSubmit={submit} />
    </FormProvider>
  );
}
