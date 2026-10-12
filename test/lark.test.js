import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lark, readRecords, normalizeRecords } from '../server/lark.js';

let directory;
const originalBinary = process.env.LARK_CLI_BIN;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sam-lark-test-'));
  const binary = join(directory, 'lark-fixture.mjs');
  await writeFile(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
const readArg = name => args[args.indexOf(name) + 1];
if (readArg('--as') !== 'user' || readArg('--format') !== 'json') process.exit(9);
const kind = args[0];
if (kind === 'echo') {
  console.log(JSON.stringify({ok:true,data:{args,notifier:process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER}}));
} else if (kind === 'missing' || kind === 'permission' || kind === 'ambiguous') {
  const code = kind === 'missing' ? 1254041 : kind === 'permission' ? 403 : 404;
  console.error(JSON.stringify({ok:false,error:{code,message:kind==='missing'?'TableIdNotFound':'Access unavailable'}}));
  process.exit(1);
} else if (kind === 'timeout') {
  setTimeout(() => console.log('{}'), 10000);
} else if (kind === 'invalid') {
  console.log('not a JSON response');
} else if (kind === 'base') {
  const offset = Number(readArg('--offset'));
  const count = offset === 0 ? 200 : 13;
  console.log(JSON.stringify({ok:true,data:{fields:['商品ID','在售'],data:Array.from({length:count},(_,i)=>['P-'+(offset+i),true]),record_id_list:Array.from({length:count},(_,i)=>'rec'+(offset+i)),has_more:offset===0}}));
}
`, { mode: 0o700 });
  await chmod(binary, 0o700);
  process.env.LARK_CLI_BIN = binary;
});
after(async () => {
  if (originalBinary) process.env.LARK_CLI_BIN = originalBinary;
  else delete process.env.LARK_CLI_BIN;
  await rm(directory, { recursive: true, force: true });
});

test('CLI uses user identity and preserves hostile-looking JSON as one argument', async () => {
  const literal = JSON.stringify({ name: 'literal $(touch BAD) `whoami` ; & name' });
  const result = await lark(['echo', '--json', literal]);
  assert.equal(result.args[result.args.indexOf('--json') + 1], literal);
  assert.equal(result.notifier, '1');
});

test('matrix output and multiple pages retain IDs and all 213 rows', async () => {
  const rows = await readRecords('base-test', 'table-test', ['商品ID', '在售'], { conditions: [['在售', '==', true]] });
  assert.equal(rows.length, 213);
  assert.deepEqual(rows[212], { record_id: 'rec212', fields: { 商品ID: 'P-212', 在售: true } });
  assert.deepEqual(normalizeRecords({ records: [{ record_id: 'a', fields: { value: 1 } }] }), [{ record_id: 'a', fields: { value: 1 } }]);
});

test('only explicit missing-table errors classify a batch as deleted', async () => {
  await assert.rejects(lark(['missing']), error => error.resourceMissing === true);
  await assert.rejects(lark(['permission']), error => error.resourceMissing === false);
  await assert.rejects(lark(['ambiguous']), error => error.resourceMissing === false);
});

test('a timed out write and malformed write response remain uncertain', async () => {
  await assert.rejects(lark(['timeout'], { write: true, timeout: 100 }), error => error.uncertain === true);
  await assert.rejects(lark(['invalid'], { write: true }), error => error.uncertain === true);
});
