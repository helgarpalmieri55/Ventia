import { z } from 'zod';

/** `POST /v1/admin/staff/invites` body. */
export const staffInviteSchema = z.object({
  email: z.string().email(),
});

/** `POST /v1/staff/accept` body — the raw token is 48 hex characters
 * (crypto.randomBytes(24).toString('hex'), see staff.service.ts#createInvite). */
export const staffAcceptSchema = z.object({
  token: z.string().length(48),
});

export type StaffInviteInput = z.infer<typeof staffInviteSchema>;
export type StaffAcceptInput = z.infer<typeof staffAcceptSchema>;
