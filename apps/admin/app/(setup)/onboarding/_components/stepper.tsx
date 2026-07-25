'use client';

import { cn } from '@ventia/ui';
import { WIZARD_STEP_DEFS, type WizardStepKey } from './wizard-steps';

export interface StepperProps {
  currentKey: WizardStepKey;
  doneKeys: ReadonlySet<WizardStepKey>;
  onSelect: (key: WizardStepKey) => void;
}

/** Stepper header: es-CO labels for the 6 wizard stages (task-3 brief).
 * Only done or current steps are clickable — a merchant can revisit anything
 * already completed, but can't skip ahead to a step it hasn't reached yet. */
export function Stepper({ currentKey, doneKeys, onSelect }: StepperProps) {
  return (
    <ol className="mb-6 flex flex-wrap gap-2" aria-label="Progreso de configuración">
      {WIZARD_STEP_DEFS.map((step, index) => {
        const isDone = doneKeys.has(step.key);
        const isCurrent = step.key === currentKey;
        const clickable = isDone || isCurrent;

        return (
          <li key={step.key}>
            <button
              type="button"
              disabled={!clickable}
              aria-current={isCurrent ? 'step' : undefined}
              onClick={() => clickable && onSelect(step.key)}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed',
                isCurrent
                  ? 'border-primary bg-primary text-primary-foreground'
                  : isDone
                    ? 'border-border bg-muted text-foreground hover:bg-muted/80'
                    : 'border-border bg-background text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full text-[10px]',
                  isCurrent ? 'bg-primary-foreground text-primary' : 'bg-border text-foreground',
                )}
              >
                {isDone && !isCurrent ? '✓' : index + 1}
              </span>
              {step.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
