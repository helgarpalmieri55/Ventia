import { describe, expect, it, vi } from 'vitest';
import type { Resend } from 'resend';
import { ResendMailer } from '../src/mailer/resend-mailer';

// Unit-level coverage: a fake Resend client (just the `emails.send` shape
// this class actually calls) stands in for the real SDK — no network call,
// no real API key needed.
function fakeResendClient(sendImpl: (...args: unknown[]) => unknown) {
  return { emails: { send: vi.fn(sendImpl) } } as unknown as Resend;
}

describe('ResendMailer', () => {
  it('maps a MailMessage onto the Resend client emails.send call, including from/to/subject/text/html', async () => {
    const client = fakeResendClient(() => Promise.resolve({ data: { id: 'email_123' }, error: null }));
    const mailer = new ResendMailer(client, 'pedidos@ventia.localhost');

    await mailer.send({ to: 'shopper@example.com', subject: 'Hola', text: 'cuerpo plano', html: '<p>cuerpo</p>' });

    expect(client.emails.send).toHaveBeenCalledTimes(1);
    expect(client.emails.send).toHaveBeenCalledWith({
      from: 'pedidos@ventia.localhost',
      to: 'shopper@example.com',
      subject: 'Hola',
      text: 'cuerpo plano',
      html: '<p>cuerpo</p>',
    });
  });

  it('omits `html` from the call entirely when the MailMessage has none', async () => {
    const client = fakeResendClient(() => Promise.resolve({ data: { id: 'email_456' }, error: null }));
    const mailer = new ResendMailer(client, 'pedidos@ventia.localhost');

    await mailer.send({ to: 'shopper@example.com', subject: 'Solo texto', text: 'cuerpo plano' });

    expect(client.emails.send).toHaveBeenCalledWith({
      from: 'pedidos@ventia.localhost',
      to: 'shopper@example.com',
      subject: 'Solo texto',
      text: 'cuerpo plano',
    });
  });

  it('propagates an error thrown by the underlying client uncaught — this class does not swallow failures', async () => {
    const boom = new Error('resend is down');
    const client = fakeResendClient(() => Promise.reject(boom));
    const mailer = new ResendMailer(client, 'pedidos@ventia.localhost');

    await expect(mailer.send({ to: 'shopper@example.com', subject: 'x', text: 'y' })).rejects.toThrow('resend is down');
  });
});
