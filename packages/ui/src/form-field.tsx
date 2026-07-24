import * as React from 'react';
import { cn } from './cn.js';
import { Label } from './label.js';

export interface FormFieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}

/** Label + control + error-slot wrapper, so form screens don't repeat the
 * layout/error markup per field. `children` is expected to be the control
 * (Input/Select/etc.) with a matching `id={htmlFor}`. */
export function FormField({ label, htmlFor, error, children, className }: FormFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
