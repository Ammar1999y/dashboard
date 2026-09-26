import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';

type FormErrors = Readonly<Record<string, string>>;

const NO_ERRORS: FormErrors = {};

// Mirrors the last validation run so each field subscribes to its own message
// alone: reading react-hook-form's `formState.errors` instead re-renders every
// field on each re-validation. One store for the whole app, so only one form may
// be mounted at a time — written only by `useFormSubmit`.
const useFormErrorsStore = create<{ errors: FormErrors }>(() => ({
  errors: NO_ERRORS,
}));

export const setFormErrors = (errors: Record<string, string>) =>
  useFormErrorsStore.setState({ errors });

export const clearFormErrors = () =>
  useFormErrorsStore.setState({ errors: NO_ERRORS });

export const useFieldError = (name: string): string | undefined =>
  useFormErrorsStore((s) => s.errors[name]);

/** Changes only when the set of messages does, not on every failed run. */
export const useFormErrors = (): FormErrors =>
  useFormErrorsStore(useShallow((s) => s.errors));
