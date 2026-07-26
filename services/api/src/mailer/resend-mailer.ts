import type { Resend } from 'resend';
import type { Mailer, MailMessage } from './mailer';

/**
 * Production Mailer backed by Resend (https://resend.com). Takes an already-
 * constructed `Resend` client (and the `from` address to send as) rather than
 * an API key, so tests can hand it a fake client with a `send` spy instead of
 * hitting the real network — same "depend on the interface, not the
 * construction" posture as `Mailer` itself.
 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly client: Resend,
    private readonly fromEmail: string,
  ) {}

  async send(msg: MailMessage): Promise<void> {
    await this.client.emails.send({
      from: this.fromEmail,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html !== undefined ? { html: msg.html } : {}),
    });
  }
}
