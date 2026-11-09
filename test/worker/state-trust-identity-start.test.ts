import { test } from 'node:test';
import {
  FORGERIES,
  refusesForgedIdentity,
} from './state-trust-identity-case.ts';

test('stale start refuses forged process and scope identities without signalling a foreign process', {
  concurrency: 5,
}, async (t) => {
  for (const forgery of [...FORGERIES] as const)
    t.test(forgery, (t) => refusesForgedIdentity(t, 'start', forgery));
});
