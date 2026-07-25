import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges class name fragments, letting later Tailwind utility classes
 * override earlier conflicting ones (e.g. `cn('px-2', condition && 'px-4')`). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
