import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, tenantDb } from '@ventia/db';
import type { CheckoutAddressInput } from '@ventia/core';

/**
 * A shopper's saved addresses, at one store.
 *
 * ## Every query filters by `accountId`, and that is load-bearing
 *
 * RLS isolates by TENANT. Two shoppers of the same store are the same tenant,
 * so the database will happily hand one of them the other's address if the
 * query does not say otherwise. The `accountId` in every `where` below is
 * therefore not defensive duplication of something RLS already does — it is
 * the ONLY thing standing between one shopper and another's home address,
 * which is a more sensitive field than most of what this platform stores.
 *
 * The id always comes from a resolved session (`ShopperSessionGuard`), never
 * from the request body.
 */

/** How many a shopper may keep. Not a technical limit — a bound so a bug or a
 * bored script cannot turn one account into unbounded storage, set far above
 * what a person plausibly needs (home, work, a relative, a couple of others). */
export const MAX_SAVED_ADDRESSES = 20;

export interface SavedAddress {
  id: string;
  label: string | null;
  address: CheckoutAddressInput;
  isDefault: boolean;
  createdAt: Date;
}

@Injectable()
export class ShopperAddressesService {
  async list(tenantId: string, accountId: string): Promise<SavedAddress[]> {
    const rows = await tenantDb(tenantId).shopperAddress.findMany({
      where: { tenantId, accountId },
      // Default first, then newest: the one checkout will pre-fill should be
      // the one a shopper sees at the top of their own list, or the list
      // disagrees with the behaviour.
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toSaved);
  }

  /**
   * Saves one.
   *
   * The FIRST address a shopper saves becomes the default whatever they asked
   * for. Someone with exactly one saved address and no default has a checkout
   * that pre-fills nothing while showing them an address they already gave us,
   * which reads as the feature being broken.
   */
  async create(
    tenantId: string,
    accountId: string,
    input: { label?: string; address: CheckoutAddressInput; isDefault?: boolean },
  ): Promise<SavedAddress> {
    const db = tenantDb(tenantId);
    const existing = await db.shopperAddress.count({ where: { tenantId, accountId } });
    if (existing >= MAX_SAVED_ADDRESSES) {
      throw new HttpException({ error: 'TOO_MANY_ADDRESSES' }, 409);
    }

    const shouldDefault = input.isDefault === true || existing === 0;
    if (shouldDefault) await this.clearDefault(tenantId, accountId);

    const row = await db.shopperAddress.create({
      data: {
        tenantId,
        accountId,
        label: input.label ?? null,
        address: input.address as unknown as Prisma.InputJsonValue,
        isDefault: shouldDefault,
      },
    });
    return toSaved(row);
  }

  async update(
    tenantId: string,
    accountId: string,
    id: string,
    input: { label?: string | null; address?: CheckoutAddressInput },
  ): Promise<SavedAddress> {
    const db = tenantDb(tenantId);
    // `updateMany` with the account in its WHERE rather than `update` by id:
    // `update` would touch a row belonging to another shopper of the same
    // store, since RLS only checks the tenant. A count of 0 is a 404 — the
    // same answer a genuinely missing id gets, so a probe cannot tell "not
    // yours" from "not there".
    const result = await db.shopperAddress.updateMany({
      where: { id, tenantId, accountId },
      data: {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.address === undefined ? {} : { address: input.address as unknown as Prisma.InputJsonValue }),
      },
    });
    if (result.count === 0) throw new HttpException({ error: 'ADDRESS_NOT_FOUND' }, 404);

    const row = await db.shopperAddress.findFirstOrThrow({ where: { id, tenantId, accountId } });
    return toSaved(row);
  }

  /**
   * Promotes one to default.
   *
   * Clear-then-set, in that order and never the reverse: the partial unique
   * index (`WHERE "isDefault"`) permits exactly one default row per account,
   * so setting before clearing violates it and fails. The index is what makes
   * "which address does checkout pre-fill" un-ambiguous even when two browser
   * tabs race, which an application-only rule cannot do.
   */
  async setDefault(tenantId: string, accountId: string, id: string): Promise<SavedAddress> {
    const db = tenantDb(tenantId);
    const target = await db.shopperAddress.findFirst({ where: { id, tenantId, accountId } });
    if (!target) throw new HttpException({ error: 'ADDRESS_NOT_FOUND' }, 404);

    await this.clearDefault(tenantId, accountId);
    const row = await db.shopperAddress.update({ where: { id }, data: { isDefault: true } });
    return toSaved(row);
  }

  /**
   * Removes one.
   *
   * Deleting the default does NOT promote another. A shopper who deleted their
   * default deliberately chose to stop having one, and silently anointing
   * whichever address happens to be next would pre-fill checkout with an
   * address they did not pick — the failure being a parcel sent to the wrong
   * place, which is worse than an empty form.
   */
  async remove(tenantId: string, accountId: string, id: string): Promise<void> {
    const result = await tenantDb(tenantId).shopperAddress.deleteMany({ where: { id, tenantId, accountId } });
    if (result.count === 0) throw new HttpException({ error: 'ADDRESS_NOT_FOUND' }, 404);
  }

  /** The address checkout should pre-fill, or `null`. */
  async defaultFor(tenantId: string, accountId: string): Promise<SavedAddress | null> {
    const row = await tenantDb(tenantId).shopperAddress.findFirst({
      where: { tenantId, accountId, isDefault: true },
    });
    return row ? toSaved(row) : null;
  }

  private async clearDefault(tenantId: string, accountId: string): Promise<void> {
    await tenantDb(tenantId).shopperAddress.updateMany({
      where: { tenantId, accountId, isDefault: true },
      data: { isDefault: false },
    });
  }
}

function toSaved(row: {
  id: string;
  label: string | null;
  address: unknown;
  isDefault: boolean;
  createdAt: Date;
}): SavedAddress {
  return {
    id: row.id,
    label: row.label,
    // Stored as JSON and written only through `checkoutAddressSchema`, so the
    // cast is safe for every row this application wrote. A row edited by hand
    // in the database is the caller's problem, and the storefront renders
    // fields it recognises rather than trusting the shape blindly.
    address: row.address as CheckoutAddressInput,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
  };
}
