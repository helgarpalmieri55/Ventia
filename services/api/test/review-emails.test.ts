import { describe, expect, it, vi } from 'vitest';
import type { Mailer, MailMessage } from '../src/mailer/mailer';
import { ratingStars, sendNewReviewEmail, type NewReviewEmailContext } from '../src/mailer/review-emails';

/** A recording Mailer double, same as `order-emails.test.ts`: never touches a
 * real Mailer implementation, so this exercises only the template's own
 * decisions. */
function recordingMailer(): { mailer: Mailer; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    send: vi.fn(async (msg: MailMessage) => {
      sent.push(msg);
    }),
  };
  return { mailer, sent };
}

const BASE_CTX: NewReviewEmailContext = {
  merchantContactEmail: 'dueño@tienda.co',
  tenantName: 'Tienda Demo',
  productName: 'Camiseta de lino',
  rating: 4,
  title: 'Muy buena tela',
  bodyMd: 'Me quedó perfecta.\nLlegó en dos días.',
  authorLabel: 'Ana P.',
};

describe('ratingStars', () => {
  it('draws the rating as five glyphs so the number is legible at a glance', () => {
    expect(ratingStars(5)).toBe('★★★★★');
    expect(ratingStars(4)).toBe('★★★★☆');
    expect(ratingStars(1)).toBe('★☆☆☆☆');
  });

  it('always draws exactly five', () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(ratingStars(rating)).toHaveLength(5);
    }
  });

  it('clamps a value outside 1..5 instead of throwing inside a fire-and-forget send', () => {
    // Unreachable through `reviewCreateSchema`. It is clamped anyway because
    // the caller does not await this send: a RangeError from a negative
    // `String.repeat` would be swallowed by the `.catch` and the merchant
    // would simply never hear about the review.
    expect(ratingStars(0)).toBe('☆☆☆☆☆');
    expect(ratingStars(-3)).toBe('☆☆☆☆☆');
    expect(ratingStars(9)).toBe('★★★★★');
  });
});

describe('sendNewReviewEmail', () => {
  it('goes to the merchant contact address and names the rating and the product in the subject', async () => {
    const { mailer, sent } = recordingMailer();

    await sendNewReviewEmail(mailer, BASE_CTX);

    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe('dueño@tienda.co');
    expect(sent[0].subject).toContain('4 estrellas');
    expect(sent[0].subject).toContain('Camiseta de lino');
    expect(sent[0].subject).toContain('Tienda Demo');
  });

  it('carries the stars, the title and the shopper words', async () => {
    const { mailer, sent } = recordingMailer();

    await sendNewReviewEmail(mailer, BASE_CTX);

    expect(sent[0].text).toContain('★★★★☆');
    expect(sent[0].text).toContain('(4 de 5)');
    expect(sent[0].text).toContain('Muy buena tela');
    expect(sent[0].text).toContain('Me quedó perfecta.');
    expect(sent[0].text).toContain('Llegó en dos días.');
    expect(sent[0].text).toContain('Ana P.');
  });

  it('says the review is ALREADY published — there is no approval step to describe', async () => {
    // The whole feature rests on the purchase requirement replacing a
    // moderation queue (see the `Review` model). An email implying the
    // merchant has to approve something would leave a 1-star review live for
    // a week while they waited for a button that does not exist.
    const { mailer, sent } = recordingMailer();

    await sendNewReviewEmail(mailer, BASE_CTX);

    expect(sent[0].text).toContain('YA está publicada');
    expect(sent[0].text).toContain('no hay nada que aprobar');
    expect(sent[0].text).not.toMatch(/esperando (tu )?aprobación/i);
  });

  it('links to the admin screen where the merchant can actually reply or hide it', async () => {
    const { mailer, sent } = recordingMailer();
    const previous = process.env.ADMIN_URL;
    process.env.ADMIN_URL = 'https://admin.ventia.co/';
    try {
      await sendNewReviewEmail(mailer, BASE_CTX);
    } finally {
      if (previous === undefined) delete process.env.ADMIN_URL;
      else process.env.ADMIN_URL = previous;
    }

    // The trailing slash on ADMIN_URL must not become a double slash in the
    // link — some mail clients stop linkifying at that point.
    expect(sent[0].text).toContain('https://admin.ventia.co/resenas');
    expect(sent[0].text).not.toContain('.co//resenas');
  });

  it('falls back to the same ADMIN_URL default the rest of this codebase uses', async () => {
    const { mailer, sent } = recordingMailer();
    const previous = process.env.ADMIN_URL;
    delete process.env.ADMIN_URL;
    try {
      await sendNewReviewEmail(mailer, BASE_CTX);
    } finally {
      if (previous !== undefined) process.env.ADMIN_URL = previous;
    }
    expect(sent[0].text).toContain('http://admin.ventia.localhost/resenas');
  });

  it('omits the title line entirely when the shopper did not write one', async () => {
    const { mailer, sent } = recordingMailer();

    await sendNewReviewEmail(mailer, { ...BASE_CTX, title: null });

    expect(sent[0].text).not.toContain('Título:');
    // The body is still there — a missing title is not a missing review.
    expect(sent[0].text).toContain('Me quedó perfecta.');
  });

  it('says so when a review is a rating and nothing else, rather than leaving a blank gap', async () => {
    // `bodyMd` is optional on the form. A merchant staring at an empty space
    // reads it as a delivery failure and goes looking for the missing text.
    const { mailer, sent } = recordingMailer();

    await sendNewReviewEmail(mailer, { ...BASE_CTX, title: null, bodyMd: '   ' });

    expect(sent[0].text).toContain('solo la calificación');
    expect(sent[0].text).toContain('★★★★☆');
  });
});
