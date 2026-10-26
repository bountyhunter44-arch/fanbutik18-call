const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const twilio = require('twilio');
const { createHash } = require('node:crypto');

initializeApp();
const db = getFirestore();
const token = defineSecret('LEXIVOICE_TWILIO_AUTH_TOKEN');
const apiKey = defineSecret('LEXIVOICE_OPENAI_API_KEY');
const publicBase = defineString('LEXIVOICE_VOICE_PUBLIC_URL');
const accountSid = defineString('LEXIVOICE_TWILIO_ACCOUNT_SID');
const model = defineString('LEXIVOICE_OPENAI_MODEL');
const core = import('./core.mjs');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const xml = (res, value) => res.status(200).type('text/xml').send(value);

const outboundHandler = import('./outbound-handler.mjs').then(({ makeOutboundHandler }) => makeOutboundHandler({
  db, verifyIdToken: (...args) => getAuth().verifyIdToken(...args), loadCore: () => core,
  settings: () => ({ base: publicBase.value() }),
  createCall: options => twilio(accountSid.value(), token.value(), { autoRetry: false, timeout: 10000 }).calls.create(options)
}));
exports.businessOutbound = onRequest({ region: 'europe-west1', maxInstances: 5, timeoutSeconds: 30, secrets: [token], cors: false }, async (req, res) => (await outboundHandler)(req, res));

// Management API: clients must send a Firebase ID token. Businesses are provisioned
// server-side with ownerUid; a client cannot assign itself membership or a number.
exports.businessApi = onRequest({ region: 'europe-west1', maxInstances: 5, cors: false }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end();
  const id = req.query.business;
  if (!validId(id)) return res.status(400).json({ error: 'Virksomheds-ID mangler.' });
  let identity;
  try { identity = await getAuth().verifyIdToken(String(req.headers.authorization || '').replace(/^Bearer /, ''), true); }
  catch { return res.status(401).json({ error: 'Log ind igen.' }); }
  const companyRef = db.doc(`businesses/${id}`);
  const company = await companyRef.get();
  if (!company.exists || company.data().ownerUid !== identity.uid) return res.status(403).json({ error: 'Ingen adgang til virksomheden.' });
  const { validateConfig } = await core;
  if (req.method === 'GET' && req.path === '/state') {
    const calls = await companyRef.collection('calls').orderBy('createdAt', 'desc').limit(100).get();
    const bookings = await companyRef.collection('bookings').orderBy('createdAt', 'desc').limit(100).get();
    return res.json({ config: company.data().config, calls: calls.docs.map(doc => ({ ...doc.data(), id: doc.id })), bookings: bookings.docs.map(doc => ({ ...doc.data(), id: doc.id })) });
  }
  if (req.method === 'POST' && req.path === '/config') {
    try { const config = validateConfig(req.body); await companyRef.update({ config }); return res.json({ config }); }
    catch { return res.status(400).json({ error: 'Ugyldig virksomhedsopsætning.' }); }
  }
  if (req.method === 'POST' && req.path === '/resolve' && /^CA[a-fA-F0-9]{32}$/.test(req.body?.id || '')) {
    const callRef = companyRef.collection('calls').doc(req.body.id);
    const call = await callRef.get();
    if (!call.exists) return res.status(404).json({ error: 'Opkald ikke fundet.' });
    await callRef.update({ resolved: true });
    return res.json({ ok: true });
  }
  return res.status(404).end();
});

exports.businessVoice = onRequest({ region: 'europe-west1', maxInstances: 10, timeoutSeconds: 30, secrets: [token, apiKey], cors: false }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  if (!req.is('application/x-www-form-urlencoded')) return res.status(415).end();
  if (!['/inbound', '/respond', '/transfer-result', '/outbound-status', '/whatsapp-permission'].includes(req.path)) return res.status(404).end();
  const base = publicBase.value().replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) return res.status(503).end();
  // Fixed external function URL; never trust Host or forwarded headers for signing.
  const signedUrl = base + req.path + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  if (!twilio.validateRequest(token.value(), req.get('X-Twilio-Signature') || '', signedUrl, req.body)) return res.status(403).end();
  const business = req.query.business;
  if (!validId(business) || req.body.AccountSid !== accountSid.value()) return res.status(400).end();
  const companyRef = db.doc(`businesses/${business}`);
  const company = await companyRef.get();
  if (!company.exists) return res.status(404).end();
  if (req.path === '/whatsapp-permission') {
    if (company.data().whatsappSender !== req.body.To || !/^whatsapp:\+[1-9]\d{7,14}$/.test(req.body.From || '') ||
      req.body.Body !== 'VOICE_CALL_REQUEST' || !['ACCEPTED', 'REJECTED'].includes(req.body.ButtonPayload) || !/^SM[a-fA-F0-9]{32}$/.test(req.body.MessageSid || '')) return res.status(400).end();
    const eventRef = companyRef.collection('permissionEvents').doc(req.body.MessageSid);
    const permissionRef = companyRef.collection('whatsappPermissions').doc(req.body.From.slice('whatsapp:'.length));
    await db.runTransaction(async tx => {
      const prior = await tx.get(eventRef);
      if (prior.exists) return;
      const accepted = req.body.ButtonPayload === 'ACCEPTED';
      tx.create(eventRef, { status: req.body.ButtonPayload, receivedAt: new Date().toISOString() });
      tx.set(permissionRef, { status: accepted ? 'accepted' : 'rejected', sender: req.body.To,
        expiresAt: accepted ? Date.now() + 7 * 24 * 60 * 60 * 1000 : 0, eventId: req.body.MessageSid });
    });
    return xml(res, '<?xml version="1.0" encoding="UTF-8"?><Response/>');
  }
  if (!/^CA[a-fA-F0-9]{32}$/.test(req.body.CallSid || '')) return res.status(400).end();
  let outbound;
  if (req.query.outbound !== undefined) {
    if (typeof req.query.outbound !== 'string' || !/^[a-f0-9-]{36}$/i.test(req.query.outbound) || req.path === '/inbound') return res.status(400).end();
    const requestRef = companyRef.collection('outboundRequests').doc(req.query.outbound);
    const accepted = await db.runTransaction(async tx => {
      const request = await tx.get(requestRef);
      if (!request.exists) return null;
      const data = request.data();
      if (data.from !== req.body.From || data.to !== req.body.To || (data.callSid && data.callSid !== req.body.CallSid)) return null;
      if (!data.callSid) tx.update(requestRef, { callSid: req.body.CallSid });
      return data;
    });
    if (!accepted) return res.status(403).end();
    outbound = { ...accepted, ref: requestRef };
  } else if (company.data().phoneNumber !== req.body.To || req.path === '/outbound-status') return res.status(404).end();
  const { validateConfig, greetingXml, resultXml, transferResultXml, classifyWithAI, routeIntent, validateMessage } = await core;
  let config;
  try { config = validateConfig(company.data().config); } catch { return res.status(503).end(); }
  if (config.transferNumber && config.transferNumber === req.body.To) return res.status(503).end();
  const callback = suffix => `${base}/${suffix}?business=${encodeURIComponent(business)}${outbound ? `&outbound=${encodeURIComponent(req.query.outbound)}` : ''}`;
  const callRef = companyRef.collection('calls').doc(req.body.CallSid);
  const now = new Date().toISOString();
  if (outbound) {
    await db.runTransaction(async tx => {
      const existing = await tx.get(callRef);
      if (!existing.exists) tx.create(callRef, { createdAt: outbound.createdAt, from: outbound.from, to: outbound.to, purpose: outbound.purpose, requestId: req.query.outbound, direction: 'outbound', channel: 'whatsapp', status: 'outbound_requested', mode: 'phone', resolved: false });
    });
  }
  if (req.path === '/outbound-status') {
    const statuses = ['queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'failed', 'canceled'];
    const sequence = Number(req.body.SequenceNumber);
    if (!statuses.includes(req.body.CallStatus) || !Number.isSafeInteger(sequence) || sequence < 0) return res.status(400).end();
    await db.runTransaction(async tx => {
      const current = await tx.get(outbound.ref);
      if (sequence <= (current.data().lastSequence ?? -1)) return;
      tx.update(outbound.ref, { status: req.body.CallStatus, lastSequence: sequence });
      tx.update(callRef, { deliveryStatus: req.body.CallStatus });
    });
    return res.status(204).end();
  }
  if (req.path === '/inbound') {
    await db.runTransaction(async transaction => {
      const call = await transaction.get(callRef);
      if (!call.exists) transaction.create(callRef, { createdAt: now, from: req.body.From || '', status: 'received', mode: 'phone', resolved: false });
    });
    return xml(res, greetingXml(config, callback('respond')));
  }
  const call = await callRef.get();
  if (!call.exists) return res.status(409).end();
  if (req.path === '/transfer-result') {
    const status = req.body.DialCallStatus === 'completed' ? 'transferred' : 'follow_up';
    await callRef.update({ status, resolved: status === 'transferred' });
    return xml(res, transferResultXml(req.body.DialCallStatus));
  }
  let message;
  try { message = validateMessage(req.body.SpeechResult); }
  catch { return xml(res, resultXml({ reply: 'Jeg kunne ikke forstå din henvendelse. Ring gerne igen.' })); }
  const eventId = createHash('sha256').update(message).digest('hex');
  const prior = call.data().eventId === eventId ? call.data().responseXml : null;
  if (prior) return xml(res, prior);
  let result;
  try {
    const intent = await classifyWithAI(message, config, { apiKey: apiKey.value(), model: model.value() });
    // WhatsApp calls cannot be transferred to PSTN numbers.
    result = routeIntent(intent, outbound ? { ...config, transferNumber: '' } : config);
  } catch {
    // AI failure still creates a follow-up rather than losing the caller's message.
    result = { intent: 'message', status: 'follow_up', reply: 'Jeg kan ikke behandle henvendelsen lige nu. Din besked er gemt til virksomhedens opfølgning.' };
  }
  const responseXml = resultXml(result, callback('transfer-result'));
  const returnedXml = await db.runTransaction(async transaction => {
    const current = await transaction.get(callRef);
    if (current.data()?.eventId === eventId) return current.data().responseXml;
    transaction.update(callRef, { message, intent: result.intent, status: result.status, responseXml, eventId });
    if (result.status === 'booking_requested') transaction.set(companyRef.collection('bookings').doc(req.body.CallSid), { createdAt: now, callId: req.body.CallSid, from: req.body.From || '', request: message, status: 'pending' });
    return responseXml;
  });
  return xml(res, returnedXml);
});
