import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig, validateMessage, classifyLocally, classifyWithAI, routeIntent, greetingXml, resultXml, transferResultXml } from '../core.mjs';

test('configuration rejects arbitrary dial targets and malformed content', () => {
  assert.throws(() => validateConfig({ ...defaultConfig, transferNumber: '<Number>123</Number>' }));
  assert.throws(() => validateConfig({ ...defaultConfig, name: '' }));
  assert.throws(() => validateConfig({ ...defaultConfig, bookingEnabled: 'true' }));
  assert.throws(() => validateMessage(' '));
  assert.throws(() => validateMessage('a'.repeat(2001)));
  assert.equal(validateConfig({ ...defaultConfig, transferNumber: '+4523456789' }).transferNumber, '+4523456789');
});
test('booking is a pending request and disabled booking becomes follow-up', () => {
  const intent = classifyLocally('Jeg vil gerne booke en tid på fredag');
  assert.equal(intent, 'booking');
  assert.equal(routeIntent(intent, defaultConfig).status, 'booking_requested');
  assert.match(routeIntent(intent, defaultConfig).reply, /først bekræftet/);
  assert.equal(routeIntent(intent, { ...defaultConfig, bookingEnabled: false }).status, 'follow_up');
});
test('transfer only uses the number configured by the business', () => {
  const intent = classifyLocally('Stil mig videre til en medarbejder på +4599999999');
  assert.equal(routeIntent(intent, defaultConfig).status, 'follow_up');
  const result = routeIntent(intent, { ...defaultConfig, transferNumber: '+4523456789' });
  assert.equal(result.number, '+4523456789');
  assert.doesNotMatch(resultXml(result, 'https://example.com/end'), /99999999/);
});
test('TwiML escapes company content and callback query parameters', () => {
  const value = greetingXml({ ...defaultConfig, greeting: '<Dial>evil</Dial> & hej' }, 'https://example.com?x=1&y=2');
  assert.match(value, /&lt;Dial&gt;evil&lt;\/Dial&gt; &amp; hej/);
  assert.match(value, /x=1&amp;y=2/);
  assert.match(value, /language="da-DK"/);
  assert.match(transferResultXml('busy'), /kunne ikke tage telefonen/);
  assert.doesNotMatch(transferResultXml('completed'), /kunne ikke tage telefonen/);
});
test('AI uses structured classification and does not accept unknown intents', async () => {
  let sent;
  const intent = await classifyWithAI('Book en tid', defaultConfig, { apiKey: 'test', model: 'configured-model', fetcher: async (url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: '{"intent":"booking"}' }] }] }) };
  } });
  assert.equal(intent, 'booking');
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  await assert.rejects(classifyWithAI('test', defaultConfig, { apiKey: 'test', model: 'configured-model', fetcher: async () => ({ ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: '{"intent":"dial_any_number"}' }] }] }) }) }));
});
