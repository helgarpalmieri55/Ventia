'use client';

import * as React from 'react';
import { cn } from './cn.js';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}

/** Accessible modal built on the native `<dialog>` element: `showModal()`
 * gives us focus trapping, Escape-to-close and a `::backdrop` for free,
 * with no extra dependency. `onClose` fires on Escape, backdrop click, and
 * the native `close` event, so callers just flip `open` to false. */
export function Dialog({ open, onClose, children, className }: DialogProps) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const handleClose = () => onClose();
    node.addEventListener('close', handleClose);
    return () => node.removeEventListener('close', handleClose);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        // `m-auto` is not styling — it restores centering that Tailwind
        // removes. The UA stylesheet centres a modal with `dialog:modal {
        // position: fixed; inset: 0; margin: auto }`, and Tailwind v4's
        // preflight resets `margin: 0` on `*, ::before, ::after, ::backdrop`,
        // which silently wins. Without this every modal in both apps renders
        // flush to the top-left corner of the viewport instead of centred.
        // Measured in Chromium at 1200x800 with a 448px dialog: (0, 0)
        // without it, (367, 376) with it — and (1200-448)/2 = 376.
        'm-auto w-full max-w-md rounded-md border border-border bg-background p-6 text-foreground shadow-lg backdrop:bg-black/50',
        className,
      )}
    >
      <div onClick={(event) => event.stopPropagation()}>{children}</div>
    </dialog>
  );
}
