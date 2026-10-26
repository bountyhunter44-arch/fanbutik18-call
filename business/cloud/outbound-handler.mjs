// Injected dependencies let tests verify dispatch and retries without making calls.
export function makeOutboundHandler({ db, verifyIdToken, createCall, settings, loadCore, now = () => new Date() }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).end();
    if (!req.is('application/json')) return res.status(415).end();
    if (typeof req.query.business !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(req.query.business)) return res.status(400).json({ error: 'Virksomheds-ID mangler.' });
    let identity;
    try { identity = await verifyIdToken(String(req.headers.authorization || '').replace(/^Bearer /, ''), true); }
    catch { return res.status(401).json({ error: 'Log ind igen.' }); }
    const companyRef = db.doc(`businesses/${req.query.business}`);
    const { validateConfig, validateOutbound, outboundGreetingXml } = await loadCore();
    let input;
    try { input = validateOutbound(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const base = settings().base.replace(/\/$/, '');
    if (!/^https:\/\//.test(base)) return res.status(503).json({ error: 'Telefoni er ikke tilsluttet.' });
    const requestRef = companyRef.collection('outboundRequests').doc(input.requestId);
    const limitRef = companyRef.collection('internal').doc('outboundLimits');
    const permissionRef = companyRef.collection('whatsappPermissions').doc(input.to.slice('whatsapp:'.length));
    const recipientLimitRef = companyRef.collection('whatsappCallLimits').doc(input.to.slice('whatsapp:'.length));
    const timestamp = now();
    let claim;
    try {
      claim = await db.runTransaction(async tx => {
        const [company, prior, limits, permission, recipientLimits] = await Promise.all([tx.get(companyRef), tx.get(requestRef), tx.get(limitRef), tx.get(permissionRef), tx.get(recipientLimitRef)]);
        if (!company.exists || company.data().ownerUid !== identity.uid) return { error: 'Ingen adgang til virksomheden.', code: 403 };
        if (prior.exists) {
          if (prior.data().to !== input.to || prior.data().purpose !== input.purpose) return { error: 'requestId er allerede brugt til et andet opkald.', code: 409 };
          return { prior: prior.data() };
        }
        const config = validateConfig(company.data().config);
        const from = company.data().whatsappSender;
        if (company.data().whatsappCallingEnabled !== true || !/^whatsapp:\+[1-9]\d{7,14}$/.test(from || '')) return { error: 'WhatsApp Calling er ikke aktiveret.', code: 503 };
        const approval = permission.data();
        if (!approval || approval.status !== 'accepted' || approval.sender !== from || approval.expiresAt <= timestamp.getTime()) return { error: 'Modtageren skal først godkende et WhatsApp-opkald.', code: 409 };
        if (input.to === from) return { error: 'Modtagernummer må ikke være virksomhedens eget indgangsnummer.', code: 400 };
        const day = timestamp.toISOString().slice(0, 10);
        const previous = limits.data() || {};
        const count = previous.day === day ? previous.count : 0;
        if (count >= 20 || timestamp.getTime() - (previous.lastAt || 0) < 30000) return { error: 'Opkaldsgrænsen er nået. Vent før næste opkald.', code: 429 };
        const attempts = (recipientLimits.data()?.attempts || []).filter(t => timestamp.getTime() - t < 24 * 60 * 60 * 1000);
        if (attempts.length >= 5) return { error: 'Der er allerede fem WhatsApp-opkaldsforsøg til modtageren inden for 24 timer.', code: 429 };
        tx.set(limitRef, { day, count: count + 1, lastAt: timestamp.getTime() });
        tx.set(recipientLimitRef, { attempts: [...attempts, timestamp.getTime()] });
        tx.create(requestRef, { ...input, from, ownerUid: identity.uid, createdAt: timestamp.toISOString(), status: 'dispatching' });
        return { config, from };
      });
    } catch { return res.status(503).json({ error: 'Opkaldet kunne ikke klargøres.' }); }
    if (claim.error) return res.status(claim.code).json({ error: claim.error });
    if (claim.prior) return res.status(claim.prior.callSid ? 200 : 202).json({ requestId: input.requestId, callSid: claim.prior.callSid || null, status: claim.prior.status, reused: true });
    const query = `business=${encodeURIComponent(req.query.business)}&outbound=${encodeURIComponent(input.requestId)}`;
    let created;
    try {
      created = await createCall({
        from: claim.from, to: input.to,
        twiml: outboundGreetingXml(claim.config, input.purpose, `${base}/respond?${query}`),
        statusCallback: `${base}/outbound-status?${query}`, statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'], timeout: 25,
        timeLimit: 180, record: false
      });
    } catch (error) {
      // A timeout may still have created a call. Never retry a dispatch automatically.
      const status = Number(error.status) >= 400 && Number(error.status) < 500 ? 'failed' : 'dispatch_unknown';
      try { await requestRef.update({ status }); } catch { /* Keep the original dispatch claim. */ }
      return res.status(502).json({ requestId: input.requestId, status, error: 'Opkaldet kunne ikke bekræftes. Kontrollér opkaldsloggen før et nyt forsøg.' });
    }
    try {
      await db.runTransaction(async tx => {
        const current = await tx.get(requestRef);
        const callRef = companyRef.collection('calls').doc(created.sid);
        const call = await tx.get(callRef);
        tx.update(requestRef, { callSid: created.sid, ...(current.data().status === 'dispatching' ? { status: created.status || 'queued' } : {}) });
        if (!call.exists) tx.create(callRef, { createdAt: timestamp.toISOString(), from: claim.from, to: input.to, purpose: input.purpose, requestId: input.requestId, direction: 'outbound', channel: 'whatsapp', status: 'outbound_requested', deliveryStatus: created.status || 'queued', mode: 'phone', resolved: false });
      });
    } catch { return res.status(202).json({ requestId: input.requestId, callSid: created.sid, status: 'tracking_pending' }); }
    return res.status(201).json({ requestId: input.requestId, callSid: created.sid, status: created.status || 'queued' });
  };
}
