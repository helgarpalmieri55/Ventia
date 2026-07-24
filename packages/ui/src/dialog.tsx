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
        'w-full max-w-md rounded-md border border-border bg-background p-6 text-foreground shadow-lg backdrop:bg-black/50',
        className,
      )}
    >
      <div onClick={(event) => event.stopPropagation()}>{children}</div>
    </dialog>
  );
}
