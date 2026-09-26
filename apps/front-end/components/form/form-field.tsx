import type { ReactNode } from 'react';

import { ErrorMessage } from './error-message';
import { FieldLabel } from './field-label';

interface FormFieldProps {
  name: string;
  /** Absent when the control renders its own label. */
  label?: string;
  htmlFor?: string;
  required?: boolean;
  /** Help text under the field. Hidden while the field has an error. */
  tip?: string;
  /** Help icon next to the label; `\n` renders as a line break. */
  tooltip?: string;
  className?: string;
  classNameLabel?: string;
  children: ReactNode;
}

const FormField = ({
  name,
  label,
  htmlFor = name,
  required,
  tip,
  tooltip,
  className,
  classNameLabel,
  children,
}: FormFieldProps) => (
  <div className={className}>
    {label && (
      <FieldLabel
        title={label}
        required={required}
        htmlFor={htmlFor}
        tooltip={tooltip}
        className={classNameLabel}
      />
    )}
    {children}
    <ErrorMessage name={name} tip={tip} />
  </div>
);

export default FormField;
