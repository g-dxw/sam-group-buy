import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createSubmissionId } from '../client/submission-id.js';

test('LAN HTTP without randomUUID generates distinct valid v4 submission IDs', () => {
  const insecureContextCrypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) };
  const ids = Array.from({ length: 1000 }, () => createSubmissionId(insecureContextCrypto));
  assert(ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)));
  assert.equal(new Set(ids).size, ids.length);
});
