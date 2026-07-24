/** A single outbound email — the one shape every Mailer implementation sends. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Abstraction over "send an email", so callers (better-auth's
 * emailVerification wiring, and anything else that needs to mail a user)
 * depend on this interface, not a specific provider. A Resend-backed
 * adapter is P2 — this phase ships only the console implementation used in
 * dev and tests.
 */
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** DI token for the app's shared Mailer — provided by MailerModule. */
export const MAILER = Symbol('MAILER');

/**
 * Dev/test Mailer: logs to stdout instead of delivering anything. Good
 * enough to eyeball a verification link locally, and gives tests a real
 * object to inject a recording double in place of (see
 * test/email-verification.test.ts, which spies on this instance's `send`).
 */
export class ConsoleMailer implements Mailer {
  async send(msg: MailMessage): Promise<void> {
    console.log(`[mail] to=${msg.to} subject=${msg.subject}`);
    console.log(msg.text);
  }
}
