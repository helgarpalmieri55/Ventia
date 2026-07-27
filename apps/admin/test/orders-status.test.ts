import { describe, expect, it } from 'vitest';
import {
  ACTION_LABEL,
  ALLOWED_ACTIONS,
  STATUS_LABEL,
  type OrderAction,
  type OrderStatus,
} from '../lib/orders-api';

// Hardcoded expectations, NOT imported from `services/api/src/orders/
// transitions.ts` (this app can't depend on `services/api/src` regardless —
// see `orders-api.ts`'s doc comment on `ALLOWED_ACTIONS`) — the entire point
// of this test is to catch DRIFT between this client-side mirror and the
// server's real state machine over time, so it must encode the server's
// table as an independent, hand-typed expectation rather than re-import the
// very thing it's meant to check.
const EXPECTED_ALLOWED_ACTIONS: Record<OrderStatus, OrderAction[]> = {
  PENDING: ['confirm', 'cancel'],
  CONFIRMED: ['preparing', 'cancel'],
  PREPARING: ['shipped', 'cancel'],
  SHIPPED: ['delivered', 'cancel'],
  DELIVERED: [],
  CANCELLED: [],
};

const ALL_STATUSES: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const ALL_ACTIONS: OrderAction[] = ['confirm', 'preparing', 'shipped', 'delivered', 'cancel'];

describe('ALLOWED_ACTIONS (client-side button-gating mirror)', () => {
  for (const status of ALL_STATUSES) {
    it(`shows exactly the server-allowed actions from ${status}`, () => {
      expect(ALLOWED_ACTIONS[status]).toEqual(EXPECTED_ALLOWED_ACTIONS[status]);
    });
  }

  it('has an entry for every OrderStatus (no missing key silently rendering no buttons)', () => {
    expect(Object.keys(ALLOWED_ACTIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('DELIVERED and CANCELLED are terminal: no action is ever valid from either', () => {
    expect(ALLOWED_ACTIONS.DELIVERED).toEqual([]);
    expect(ALLOWED_ACTIONS.CANCELLED).toEqual([]);
  });

  it('cancel is reachable from every non-terminal status', () => {
    for (const status of ['PENDING', 'CONFIRMED', 'PREPARING', 'SHIPPED'] as const) {
      expect(ALLOWED_ACTIONS[status]).toContain('cancel');
    }
  });
});

describe('STATUS_LABEL', () => {
  it('has a non-empty es-CO label for every OrderStatus', () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_LABEL[status]).toBeTypeOf('string');
      expect(STATUS_LABEL[status].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys beyond the 6 real statuses', () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual([...ALL_STATUSES].sort());
  });
});

describe('ACTION_LABEL', () => {
  it('has a non-empty es-CO label for every OrderAction', () => {
    for (const action of ALL_ACTIONS) {
      expect(ACTION_LABEL[action]).toBeTypeOf('string');
      expect(ACTION_LABEL[action].length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys beyond the 5 real actions', () => {
    expect(Object.keys(ACTION_LABEL).sort()).toEqual([...ALL_ACTIONS].sort());
  });
});
