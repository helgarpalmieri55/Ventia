import * as React from 'react';
import { cn } from './cn.js';

export type SpinnerProps = React.HTMLAttributes<HTMLSpanElement>;

export const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      role="status"
      aria-label="Cargando"
      className={cn(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent text-primary',
        className,
      )}
      {...props}
    />
  ),
);
Spinner.displayName = 'Spinner';
