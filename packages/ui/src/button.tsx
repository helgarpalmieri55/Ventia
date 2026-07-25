import * as React from 'react';
import { cn } from './cn.js';

export type ButtonVariant = 'default' | 'secondary' | 'destructive' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** When set, renders a styled `<a href>` instead of a `<button>`, with the
   * identical variant/size classes — for call sites that navigate (e.g.
   * "Nuevo producto" -> `/productos/nuevo`) rather than submit/act in place.
   * Fixes call sites that used to wrap a `<Button>` in an `<a>`, which
   * produces an invalid nested-interactive-element DOM (`<a><button>...`) —
   * this prop lets the single element be the (only) interactive one. The
   * rest of the Button API is unchanged; `href` is simply mutually exclusive
   * with the handful of button-only attributes (`type`, `disabled`, `form`,
   * ...) that don't apply to an anchor. */
  href?: string;
}

const variantClasses: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-muted text-foreground hover:bg-muted/80',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  ghost: 'bg-transparent text-foreground hover:bg-muted',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', type = 'button', href, ...props }, ref) => {
    const classes = cn(
      'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
      variantClasses[variant],
      sizeClasses[size],
      className,
    );

    if (href !== undefined) {
      // `props` is typed for a <button> (ButtonHTMLAttributes); the handful
      // of fields that don't exist on <a> (type/disabled/form/...) are
      // simply never passed by an href call site, so this cast is safe in
      // practice — it exists only because TS has no shared HTML-attributes
      // supertype covering both elements.
      return (
        <a
          ref={ref as unknown as React.Ref<HTMLAnchorElement>}
          href={href}
          className={classes}
          {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
        />
      );
    }

    return (
      <button ref={ref} type={type} className={classes} {...props} />
    );
  },
);
Button.displayName = 'Button';
