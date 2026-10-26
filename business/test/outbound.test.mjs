import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as core from '../core.mjs';
import { makeOutboundHandler } from '../cloud/outbound-handler.mjs';

const sid = 'CA' + '1'.repeat(32);
const time = new Date('2026-10-08T12:00:00Z');
function fixture({ owner = 'owner', enabled = true, permission = 'accepted', expiresAt = time.getTime() + 60000, createCall, attempts = [] } = {}) {
  const data = new Map([
    ['businesses/ewcp', { ownerUid: owner, whatsappSender: 'whatsapp:+4523456789', whatsappCallingEnabled: enabled, config: core.defaultConfig }],
    ['businesses/ewcp/whatsappPermissions/+4534567890', { status: permission, sender: 'whatsapp:+4523456789', expiresAt }],
    ['businesses/ewcp/whatsappCallLimits/+4534567890', { attempts }]
  ]);
  const ref = key => ({ key, collection: name => ({ doc: id => ref(`${key}/${name}/${id}`) }), update: async value => data.set(key, { ...data.get(key), ...value }) });
  let queue = Promise.resolve(), dialCount = 0, sent;
  const db = { doc: ref, runTransaction(fn) {
    const result = queue.then(async () => {
      let written = false; const changes = [];
      const value = await fn({
        get: async r => { assert(!written, 'Firestore prohibits reads after writes'); return { exists: data.has(r.key), data: () => data.get(r.key) }; },
        set: (r, v) => { written = true; changes.push(() => data.set(r.key, v)); },
        create: (r, v) => { written = true; changes.push(() => { assert(!data.has(r.key)); data.set(r.key, v); }); },
        update: (r, v) => { written = true; changes.push(() => { assert(data.has(r.key)); data.set(r.key, { ...data.get(r.key), ...v }); }); }
      });
      changes.forEach(apply => apply()); return value;
    }); queue = result.catch(() => {}); return result;
  } };
  const handler = makeOutboundHandler({ db, verifyIdToken: async token => { if (token !== 'valid') throw new Error('auth'); return { uid: 'owner' }; },
    createCall: async options => { dialCount++; sent = options; return createCall ? createCall(options) : { sid, status: 'queued' }; },
    settings: () => ({ base: 'https://example.com/businessVoice' }), loadCore: async () => core, now: () => time });
  const input = { to: '+4534567890', purpose: 'Jeg ringer om din forespørgsel.', requestId: randomUUID() };
  async function invoke(body = input, authorization = 'Bearer valid') {
    const res = { code: 200, body: null, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } };
    await handler({ method: 'POST', is: value => value === 'application/json', query: { business: 'ewcp' }, headers: { authorization }, body }, res);
    return res;
  }
  return { invoke, input, data, dialCount: () => dialCount, sent: () => sent };
}

test('WhatsApp outbound presents AI and company before purpose and never sends PSTN addresses', async () => {
  const f = fixture(); const res = await f.invoke();
  assert.equal(res.code, 201); assert.equal(f.dialCount(), 1);
  assert.equal(f.sent().from, 'whatsapp:+4523456789'); assert.equal(f.sent().to, 'whatsapp:+4534567890');
  assert.match(f.sent().twiml, /LexiVoice, en AI-assistent.*EWCP Virksomhedsplatform.*forespørgsel/);
  assert.equal(f.sent().record, false); assert.match(f.sent().statusCallback, /outbound-status/);
});
test('anonymous, wrong owner, disabled sender and missing or expired permission cannot ring', async () => {
  const anonymous = fixture(); assert.equal((await anonymous.invoke(undefined, '')).code, 401); assert.equal(anonymous.dialCount(), 0);
  for (const [options, code] of [[{ owner: 'other' }, 403], [{ enabled: false }, 503], [{ permission: 'rejected' }, 409], [{ expiresAt: time.getTime() - 1 }, 409]]) {
    const f = fixture(options); assert.equal((await f.invoke()).code, code); assert.equal(f.dialCount(), 0);
  }
});
test('simultaneous retries with the same requestId create exactly one call', async () => {
  const f = fixture(); const results = await Promise.all([f.invoke(), f.invoke()]);
  assert.equal(f.dialCount(), 1); assert(results.some(r => r.code === 201));
  const repeated = await f.invoke(); assert.equal(repeated.code, 200); assert.equal(repeated.body.reused, true);
  assert.equal((await f.invoke({ ...f.input, purpose: 'Et andet opkald.' })).code, 409);
});
test('provider timeout keeps the dispatch claim and never automatically redials', async () => {
  const f = fixture({ createCall: () => { throw new Error('timeout'); } });
  assert.equal((await f.invoke()).body.status, 'dispatch_unknown');
  assert.equal((await f.invoke()).code, 202); assert.equal(f.dialCount(), 1);
});
test('rolling WhatsApp destination limit and company cooldown prevent extra calls', async () => {
  const capped = fixture({ attempts: Array(5).fill(time.getTime() - 1000) });
  assert.equal((await capped.invoke()).code, 429); assert.equal(capped.dialCount(), 0);
  const f = fixture(); await f.invoke();
  assert.equal((await f.invoke({ ...f.input, requestId: randomUUID() })).code, 429); assert.equal(f.dialCount(), 1);
});
test('WhatsApp addresses reject SIP URLs, XML payloads and arbitrary call IDs', () => {
  for (const to of ['sip:user@example.com', '+45<Number>', '123']) assert.throws(() => core.validateOutbound({ to, purpose: 'Test', requestId: randomUUID() }));
  assert.throws(() => core.validateOutbound({ to: '+4534567890', purpose: 'Test', requestId: '../other' }));
  const value = core.outboundGreetingXml(core.defaultConfig, '<Dial>123</Dial>', 'https://example.com?a=1&b=2');
  assert.match(value, /&lt;Dial&gt;123&lt;\/Dial&gt;/); assert.doesNotMatch(value, /<Dial>/);
});
