const $ = selector => document.querySelector(selector);
let state, filter = 'all', noticeTimer;
const labels = { answered: 'Information givet', booking_requested: 'Booking ønsket', transfer_requested: 'Omstilling ønsket', follow_up: 'Opfølgning', outbound_preview: 'WhatsApp · forhåndsvisning' };
async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Handlingen mislykkedes.');
  return result;
}
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 5000); }
function show(view) {
  document.querySelectorAll('.view').forEach(section => { section.hidden = section.id !== view; });
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('#breadcrumb').textContent = ({ overview: 'Overblik', receptionist: 'AI-receptionist', outbound: 'WhatsApp-opkald', calls: 'Opkald & anmodninger', connections: 'Forbindelser' })[view];
}
function renderCalls(target, calls, full = false) {
  target.replaceChildren();
  if (!calls.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Ingen henvendelser endnu. Afprøv receptionisten, så dukker den første op her.'; target.append(empty); return; }
  for (const call of calls) {
    const row = document.createElement('div'); row.className = 'call';
    const content = document.createElement('div');
    const text = document.createElement('p'); text.textContent = call.message;
    const date = document.createElement('small'); date.textContent = new Date(call.createdAt).toLocaleString('da-DK') + (call.direction === 'outbound' ? ` · WhatsApp-prøveopkald til ${call.to.replace(/^whatsapp:/, '')}` : ' · Prøveopkald');
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = call.resolved ? 'Behandlet' : labels[call.status];
    content.append(text, date, badge);
    if (full) { const reply = document.createElement('p'); reply.className = 'reply'; reply.textContent = call.reply; content.append(reply); }
    row.append(content);
    if (full && !call.resolved && call.status !== 'answered') {
      const button = document.createElement('button'); button.className = 'text-button'; button.textContent = 'Markér behandlet ✓';
      button.onclick = async () => { button.disabled = true; try { await api('/api/resolve', { id: call.id }); await refresh(); } catch (error) { notice(error.message); button.disabled = false; } };
      row.append(button);
    }
    target.append(row);
  }
}
function render() {
  $('#company-sidebar').textContent = state.config.name;
  $('#metric-calls').textContent = state.calls.length;
  $('#metric-bookings').textContent = state.calls.filter(call => call.intent === 'booking' && !call.resolved && call.status === 'booking_requested').length;
  $('#metric-followups').textContent = state.calls.filter(call => !call.resolved && call.status !== 'answered').length;
  renderCalls($('#recent-calls'), state.calls.slice(0, 3));
  renderCalls($('#all-calls'), state.calls.filter(call => filter === 'all' || (filter === 'booking' ? call.intent === 'booking' : !call.resolved && call.status !== 'answered')), true);
}
async function refresh() { state = await api('/api/state'); render(); }
function populateForm() {
  for (const [name, value] of Object.entries(state.config)) { const field = $('#config-form').elements.namedItem(name); if (field) { if (field.type === 'checkbox') field.checked = value; else field.value = value; } }
}
document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => show(button.dataset.view); });
$('#go-test').onclick = () => { show('receptionist'); $('#test-form').elements.message.focus(); };
$('#go-config').onclick = () => show('receptionist');
$('#go-calls').onclick = () => show('calls');
document.querySelectorAll('[data-filter]').forEach(button => { button.onclick = () => { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('selected', item === button)); render(); }; });
document.querySelectorAll('[data-message]').forEach(button => { button.onclick = () => { $('#test-form').elements.message.value = button.dataset.message; $('#test-form').elements.message.focus(); }; });
$('#config-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
  try { const values = Object.fromEntries(new FormData(form)); values.bookingEnabled = form.elements.bookingEnabled.checked; await api('/api/config', values); await refresh(); notice('Din virksomhedsopsætning er gemt lokalt.'); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('#test-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
  try {
    const values = await api('/api/simulate', { message: form.elements.message.value });
    const result = $('#test-result'); result.replaceChildren(); const title = document.createElement('strong'); title.textContent = labels[values.call.status] + ' · Simulering';
    result.append(title, document.createTextNode(values.call.reply)); result.hidden = false; await refresh();
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('#outbound-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
  try {
    const values = await api('/api/outbound-preview', { to: form.elements.to.value, purpose: form.elements.purpose.value, requestId: crypto.randomUUID() });
    $('#outbound-result').textContent = values.call.reply; $('#outbound-result').hidden = false; await refresh();
    notice('Forhåndsvisning gemt. Der er ikke foretaget et WhatsApp-opkald.');
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
};
try { await refresh(); populateForm(); } catch (error) { notice('Kunne ikke indlæse arbejdsrummet: ' + error.message); }
