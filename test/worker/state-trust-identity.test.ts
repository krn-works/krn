import { test } from 'node:test';
import {
  FORGERIES,
  refusesForgedIdentity,
} from './state-trust-identity-case.ts';

test('stop refuses forged process and scope identities without signalling a foreign process', {
  concurrency: 5,
}, async (t) => {
  for (const forgery of [...FORGERIES, 'driver-pid'] as const)
    t.test(forgery, (t) => refusesForgedIdentity(t, 'stop', forgery));
});
