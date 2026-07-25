import * as React from 'react';
import { cn } from './cn.js';
import { Label } from './label.js';

export interface FormFieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactElement;
  className?: string;
}

/** Label + control + error-slot wrapper, so form screens don't repeat the
 * layout/error markup per field. `children` is expected to be a single
 * control element (Input/Select/etc.); it is cloned with `id={htmlFor}`
 * (so the Label always associates correctly) and, whenever `error` is
 * present, `aria-invalid="true"` plus `aria-describedby` pointing at the
 * error message's id — screen readers then announce the error text when
 * the control receives focus. Those two aria props are left untouched
 * (not cleared) when there's no error, so a caller-provided
 * aria-describedby (e.g. a hint) survives. */
export function FormField({ label, htmlFor, error, children, className }: FormFieldProps) {
  const errorId = `${htmlFor}-error`;
  const control = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        id: htmlFor,
        ...(error ? { 'aria-invalid': true, 'aria-describedby': errorId } : {}),
      })
    : children;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {control}
      {error ? (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
