import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FormField, Input } from '@ventia/ui';

describe('FormField aria wiring', () => {
  it('sets aria-invalid and aria-describedby on the child control when an error is present', () => {
    const html = renderToStaticMarkup(
      React.createElement(FormField, {
        label: 'Correo',
        htmlFor: 'email',
        error: 'Correo inválido',
        children: React.createElement(Input, { type: 'email' }),
      }),
    );

    expect(html).toContain('id="email"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="email-error"');
    expect(html).toContain('id="email-error"');
    expect(html).toContain('Correo inválido');
  });

  it('does not set aria-invalid/aria-describedby when there is no error', () => {
    const html = renderToStaticMarkup(
      React.createElement(FormField, {
        label: 'Correo',
        htmlFor: 'email',
        children: React.createElement(Input, { type: 'email' }),
      }),
    );

    expect(html).toContain('id="email"');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('aria-describedby');
  });
});
