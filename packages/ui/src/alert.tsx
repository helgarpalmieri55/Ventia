import * as React from 'react';
import { cn } from './cn.js';

export type AlertVariant = 'info' | 'error' | 'success';

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
}

const variantClasses: Record<AlertVariant, string> = {
  info: 'border-primary/30 bg-primary/10 text-foreground',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  success: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700',
};

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = 'info', role, ...props }, ref) => (
    <div
      ref={ref}
      role={role ?? (variant === 'error' ? 'alert' : 'status')}
      className={cn('w-full rounded-md border p-4 text-sm', variantClasses[variant], className)}
      {...props}
    />
  ),
);
Alert.displayName = 'Alert';
