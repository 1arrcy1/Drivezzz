// The admin panel, without a framework. Everything people typed goes through esc().
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (c) => (c == null ? '–' : `€${(c / 100).toFixed(2)}`);
const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '–');
const ago = (t) => {
  if (!t) return '–';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${Math.max(0, s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

async function api(method, path, body) {
  const r = await fetch(`/admin/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('Please log in.'); }
  if (r.status === 403 && json.code === 'change_password') { showChange(true); throw new Error(json.error); }
  if (!r.ok) throw new Error(json.error || 'That didn’t work.');
  return json;
}
const act = (fn) => async (...args) => { try { await fn(...args); } catch (e) { alert(e.message); } };

function show(screen) { for (const id of ['login', 'change', 'app']) $(id).hidden = id !== screen; }
function showLogin() { show('login'); }
function showApp() { show('app'); }

let mustChange = false;
function showChange(must) {
  mustChange = must;
  $('changeForm').reset();
  $('changeError').textContent = '';
  $('changeTitle').textContent = must ? 'Choose a new password' : 'Change your password';
  $('changeNote').textContent = must ? 'The first password is only to get in. Choose your own to continue.' : 'Other browsers are logged out when you change it.';
  $('changeBack').textContent = must ? 'Log out' : 'Cancel';
  show('change');
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    const { mustChangePassword } = await api('POST', '/login', { email: $('email').value, password: $('password').value });
    $('password').value = '';
    if (mustChangePassword) { showChange(true); return; }
    showApp();
    go('online');
  } catch (err) { $('loginError').textContent = err.message; }
});
$('logout').addEventListener('click', async () => { await api('POST', '/logout'); showLogin(); });
$('changePassword').addEventListener('click', () => showChange(false));
$('changeBack').addEventListener('click', async () => {
  if (!mustChange) { showApp(); return; }
  await api('POST', '/logout');
  showLogin();
});
$('changeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('changeError').textContent = '';
  if ($('newPassword').value !== $('newPasswordAgain').value) { $('changeError').textContent = 'Those two new passwords aren’t the same.'; return; }
  try {
    await api('POST', '/password', { current: $('currentPassword').value, password: $('newPassword').value });
    $('changeForm').reset();
    showApp();
    go('online');
  } catch (err) { $('changeError').textContent = err.message; }
});

const TABS = [['online', 'Online'], ['users', 'Users'], ['checks', 'Driver checks'], ['reports', 'Reports'], ['appeals', 'Ban appeals'], ['disputes', 'Ride appeals'], ['rides', 'Rides'], ['escrow', 'Money'], ['walletChanges', 'Wallet changes'], ['support', 'Support'], ['links', 'Links'], ['log', 'Log']];
let tab = 'online', overview = {};

function drawTabs() {
  $('tabs').innerHTML = TABS.map(([id, name]) => {
    const n = { reports: overview.reportsOpen, appeals: overview.appealsOpen, disputes: overview.disputesOpen, escrow: overview.escrowErrors, walletChanges: overview.walletChangesOpen, checks: overview.checksOpen, support: overview.supportOpen }[id] ?? 0;
    return `<button data-tab="${id}" class="${tab === id ? 'on' : ''}">${name}${n ? `<span class="badge">${n}</span>` : ''}</button>`;
  }).join('');
  for (const b of $('tabs').children) b.onclick = () => go(b.dataset.tab);
}
async function refreshStats() {
  overview = await api('GET', '/overview');
  $('testNote').hidden = overview.network === 'mainnet';
  if (overview.pretendChain) $('testNote').textContent = 'This is the live panel, with no contract yet: the chain is pretend and no real money moves.';
  $('stats').innerHTML = [
    [overview.online, 'online now'], [overview.driving, 'driving'], [overview.ridesLive, 'rides under way'], [overview.ordersOpen, 'orders waiting'], [overview.users, 'users'],
    [overview.pretendChain ? 'Pretend' : overview.network === 'mainnet' ? 'Mainnet' : 'Devnet', 'network'],
  ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
  drawTabs();
}
async function go(next) {
  tab = next;
  await refreshStats();
  await VIEWS[tab]();
}
const seg = (options, current, on) => {
  const box = document.createElement('div');
  box.className = 'seg';
  for (const [id, name] of options) {
    const b = document.createElement('button');
    b.textContent = name;
    if (id === current) b.className = 'on';
    b.onclick = () => on(id);
    box.append(b);
  }
  return box;
};
function openDialog(html) {
  $('dialogBody').innerHTML = `<button class="close ghost" onclick="document.getElementById('dialog').close()">Close</button>${html}`;
  if (!$('dialog').open) $('dialog').showModal();
}

// ---------- users ----------

function userTable(users) {
  if (!users.length) return '<div class="empty">Nobody here.</div>';
  return `<table><tr><th>User ID</th><th>Name</th><th>Status</th><th>Last seen</th><th>Strikes</th><th>Location</th><th></th></tr>${users.map((u) => `
    <tr class="click" data-user="${esc(u.id)}">
      <td class="mono">${esc(u.id)}</td>
      <td>${esc(u.name)}${u.email ? `<div class="muted">${esc(u.email)}</div>` : ''}</td>
      <td>${u.demo ? '<span class="pill warn">App Review demo</span>' : ''}${u.ban ? `<span class="pill bad">${u.ban.viaPerson ? 'same person ' : u.ban.viaPhone ? 'phone ' : ''}${u.ban.kind === 'week' ? `banned until ${when(u.ban.endsAt)}` : 'banned for good'}</span>` : ''}${u.driving ? '<span class="pill ok">driving</span>' : u.isDriver ? '<span class="pill">driver</span>' : '<span class="pill">rider</span>'}${u.ride ? `<span class="pill warn">${esc(u.ride.status)}</span>` : ''}</td>
      <td>${ago(u.lastSeenAt)}</td>
      <td>${u.strikes} / ${overview.maxStrikes}</td>
      <td>${u.lat != null ? `<a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${u.lat}&mlon=${u.lng}#map=15/${u.lat}/${u.lng}">${u.lat.toFixed(4)}, ${u.lng.toFixed(4)}</a> <span class="muted">${ago(u.locAt)}</span>` : '–'}</td>
      <td><button data-ban="${esc(u.id)}" class="danger">Ban</button></td>
    </tr>`).join('')}</table>`;
}
function wireUsers(root) {
  root.querySelectorAll('[data-ban]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); banDialog(b.dataset.ban); }; });
  root.querySelectorAll('[data-user]').forEach((r) => { r.onclick = (e) => { if (e.target.tagName !== 'A') userDialog(r.dataset.user); }; });
}

async function usersView(filter, q = '') {
  const view = $('view');
  const { users } = await api('GET', `/users?filter=${filter}&q=${encodeURIComponent(q)}`);
  view.innerHTML = '<div class="toolbar" id="tb"></div><div class="panel" id="list"></div>';
  if (tab === 'users') {
    $('tb').append(seg([['all', 'All'], ['drivers', 'Drivers'], ['banned', 'Banned']], filter, (f) => usersView(f, q)));
    const input = document.createElement('input');
    input.placeholder = 'Search ID, name, email';
    input.value = q;
    input.onchange = () => usersView(filter, input.value);
    $('tb').append(input);
  } else {
    $('tb').innerHTML = `<span class="muted">Seen in the last 3 minutes, newest first.</span>`;
  }
  $('list').innerHTML = userTable(users);
  wireUsers($('list'));
}

function banDialog(id) {
  openDialog(`<h1>Ban ${esc(id)}</h1>
    <p class="muted">This bans the account and every phone it used. They see the reason and can appeal once per 24 hours.</p>
    <div class="row"><select id="banKind"><option value="permanent">Permanently</option><option value="week">For one week</option></select></div>
    <textarea id="banReason" placeholder="Reason (they see this)"></textarea>
    <div class="row"><button class="primary" id="banGo">Ban</button></div>`);
  $('banGo').onclick = act(async () => {
    await api('POST', `/users/${encodeURIComponent(id)}/ban`, { kind: $('banKind').value, reason: $('banReason').value });
    $('dialog').close();
    go(tab);
  });
}
function strikeDialog(id, count) {
  openDialog(`<h1>Strike for ${esc(id)}</h1>
    <p class="muted">Strike ${count + 1} of ${overview.maxStrikes}. ${count + 1 >= overview.maxStrikes ? '<b>This one is a permanent ban.</b>' : 'Every strike is a one-week ban.'}</p>
    <textarea id="strikeReason" placeholder="Reason (they see this)"></textarea>
    <div class="row"><button class="primary" id="strikeGo">Give strike</button></div>`);
  $('strikeGo').onclick = act(async () => {
    await api('POST', `/users/${encodeURIComponent(id)}/strike`, { reason: $('strikeReason').value });
    $('dialog').close();
    go(tab);
  });
}
async function userDialog(id) {
  const d = await api('GET', `/users/${encodeURIComponent(id)}`);
  const u = d.user;
  openDialog(`<h1>${esc(u.name)}</h1><div class="mono muted">${esc(u.id)}</div>
    <dl class="kv"><dt>Email</dt><dd>${esc(u.email ?? '–')}</dd><dt>Joined</dt><dd>${when(u.createdAt)}</dd><dt>Last seen</dt><dd>${ago(u.lastSeenAt)}</dd>
    ${u.isDriver ? `<dt>Completed</dt><dd>${u.completedPercent ?? '–'}${u.completedPercent != null ? '%' : ''}</dd><dt>On time</dt><dd>${u.arrivalScore ?? '–'}${u.arrivalScore != null ? '%' : ''}</dd>` : ''}
    <dt>Strikes</dt><dd>${u.strikes} / ${overview.maxStrikes}</dd><dt>Phones</dt><dd>${d.devices.map((p) => `<span class="mono">${esc(p.device_id.slice(0, 8))}</span>${p.banned ? ' <span class="pill bad">banned</span>' : ''}`).join('<br>') || '–'}</dd>
    <dt>On hold for rides</dt><dd>${d.held.map((h) => `${esc(h.amount)} ${esc(h.coin)}`).join(', ') || '–'}</dd>
    <dt>Banned wallets</dt><dd>${d.bannedWallets.map((w) => `<span class="mono">${esc(w.address)}</span> <button data-unban-wallet="${esc(w.address)}">Allow again</button>`).join('<br>') || '–'}</dd></dl>
    <h2>Connected wallets</h2>${d.wallets.length ? `<div class="panel"><table>${d.wallets.map((w) => `<tr><td>${esc(w.coin)}</td><td class="mono wrap">${esc(w.address)}${w.tag != null ? ` tag ${esc(w.tag)}` : ''}</td><td>${esc(w.via ?? '')}</td><td>${w.enabled ? 'on' : 'off'}</td><td><button data-wallet="${esc(w.coin)}" class="danger" title="Only after a support request">Remove</button></td></tr>`).join('')}</table></div>` : '<p class="muted">None.</p>'}
    <div class="row">
      ${u.ban ? '<button class="primary" id="uUnban">Lift ban</button>' : '<button class="danger" id="uBan">Ban</button>'}
      <button id="uStrike">Give strike</button>
      <button id="uClean" title="Back to their user ID as a name, and no bio">Clean name and bio</button>
    </div>
    ${d.bio ? `<h2>About them</h2><p class="wrap">${esc(d.bio)}</p>` : ''}
    <p class="muted">${d.eula ? `Accepted the EULA, version ${esc(d.eula.version)}: ${when(d.eula.at)}` : 'Has not accepted the EULA: this account is older than it, or came from an app without it'}</p>
    ${d.rulesSeenAt ? `<p class="muted">Told that licences, permits and insurance are up to them: ${when(d.rulesSeenAt)}</p>` : ''}
    <h2>Reports about them</h2>${d.reports.length ? `<div class="panel"><table>${d.reports.map((r) => `<tr><td>${when(r.created_at)}</td><td>${esc(r.reason)}</td><td class="wrap">${esc(r.message ?? '')}</td><td><span class="pill">${esc(r.status)}</span></td></tr>`).join('')}</table></div>` : '<p class="muted">None.</p>'}
    <h2>Photos</h2>${d.photos.length ? `<div class="row">${d.photos.map((p) => `<div><img src="${esc(p.url)}" alt="" width="120" height="84" style="object-fit:cover;border-radius:8px;display:block"><button data-photo="${esc(p.id)}" class="danger">Remove</button></div>`).join('')}</div>` : '<p class="muted">None.</p>'}
    <h2>Reviews of them</h2>${d.reviews.length ? `<div class="panel"><table>${d.reviews.map((r) => `<tr><td>${when(r.created_at)}</td><td>${r.stars} / 5</td><td class="wrap">${esc(r.text ?? '')}</td><td><button data-review="${esc(r.ride_id)}" class="danger">Remove</button></td></tr>`).join('')}</table></div>` : '<p class="muted">None.</p>'}
    <h2>Strikes</h2>${d.strikes.length ? `<div class="panel"><table>${d.strikes.map((s) => `<tr><td>${when(s.created_at)}</td><td class="wrap">${esc(s.reason)}</td><td>${s.removed_at ? `<span class="pill">removed: ${esc(s.removed_why)}</span>` : `<button data-strike="${esc(s.id)}">Remove</button>`}</td></tr>`).join('')}</table></div>` : '<p class="muted">None.</p>'}
    <h2>Bans</h2>${d.bans.length ? `<div class="panel"><table>${d.bans.map((b) => `<tr><td>${when(b.created_at)}</td><td>${esc(b.kind)}</td><td class="wrap">${esc(b.reason)}</td><td>${b.lifted_at ? `<span class="pill">lifted: ${esc(b.lifted_why)}</span>` : b.ends_at ? `until ${when(b.ends_at)}` : 'for good'}</td></tr>`).join('')}</table></div>` : '<p class="muted">None.</p>'}
    <h2>Appeals</h2>${d.appeals.length ? `<div class="panel"><table>${d.appeals.map((a) => `<tr><td>${when(a.created_at)}</td><td class="wrap">${esc(a.message)}</td><td><span class="pill">${esc(a.status)}</span></td></tr>`).join('')}</table></div>` : '<p class="muted">None.</p>'}
    <h2>Rides</h2>${d.rides.length ? `<div class="panel"><table>${d.rides.map((r) => `<tr class="click" data-ride="${esc(r.id)}"><td>${when(r.created_at)}</td><td>${r.rider_id === u.id ? 'rider' : 'driver'}</td><td>${ridePill(r.status)}</td><td>${eur(r.price_cents ?? r.max_cents)}</td><td>${esc(r.coin)}</td></tr>`).join('')}</table></div>` : '<p class="muted">None.</p>'}`);
  const body = $('dialogBody');
  if ($('uBan')) $('uBan').onclick = () => banDialog(u.id);
  if ($('uUnban')) $('uUnban').onclick = act(async () => { await api('POST', `/users/${encodeURIComponent(u.id)}/unban`, { why: prompt('Why? (they see this)') || 'Lifted by an admin' }); userDialog(u.id); refreshStats(); });
  $('uStrike').onclick = () => strikeDialog(u.id, u.strikes);
  $('uClean').onclick = act(async () => { await api('POST', `/users/${encodeURIComponent(u.id)}/clean`, {}); userDialog(u.id); });
  body.querySelectorAll('[data-unban-wallet]').forEach((b) => { b.onclick = act(async () => { await api('POST', '/banned-wallets/remove', { address: b.dataset.unbanWallet }); userDialog(u.id); }); });
  body.querySelectorAll('[data-wallet]').forEach((b) => { b.onclick = act(async () => { if (!confirm(`Remove their ${b.dataset.wallet} address?`)) return; await api('POST', `/users/${encodeURIComponent(u.id)}/wallets/${encodeURIComponent(b.dataset.wallet)}/remove`, {}); userDialog(u.id); }); });
  body.querySelectorAll('[data-photo]').forEach((b) => { b.onclick = act(async () => { await api('POST', `/photos/${b.dataset.photo}/remove`, {}); userDialog(u.id); }); });
  body.querySelectorAll('[data-review]').forEach((b) => { b.onclick = act(async () => { await api('POST', `/reviews/${b.dataset.review}/remove`, {}); userDialog(u.id); }); });
  body.querySelectorAll('[data-strike]').forEach((b) => { b.onclick = act(async () => { await api('POST', `/strikes/${b.dataset.strike}/remove`, { why: prompt('Why?') || 'Removed by an admin' }); userDialog(u.id); }); });
  body.querySelectorAll('[data-ride]').forEach((r) => { r.onclick = () => rideDialog(r.dataset.ride); });
}

// ---------- reports ----------

// A reported chat. Chats are end-to-end encrypted: the only ones anyone here can read are those a report handed over.
function reportChat(r) {
  if (!r.chat) return '';
  const nameOf = (id) => (id === r.reporter_id ? r.reporter_name : r.target_name);
  return `<details class="chat"><summary>Their chat, ${r.chat.length} message${r.chat.length === 1 ? '' : 's'}</summary>${r.chat.map((m) => `<div class="chat-line ${m.from === r.reporter_id ? '' : 'them'}">
    <div class="muted">${esc(nameOf(m.from))} · ${when(m.at)}</div><div>${m.text === null ? '<em class="muted">Couldn’t be opened with the keys in this report</em>' : esc(m.text)}</div></div>`).join('')}</details>`;
}

async function reportsView(filter = 'open') {
  const { reports } = await api('GET', `/reports?filter=${filter}`);
  $('view').innerHTML = '<div class="toolbar" id="tb"></div><div class="panel" id="list"></div>';
  $('tb').append(seg([['open', 'Open'], ['all', 'All']], filter, reportsView));
  const note = document.createElement('span');
  note.className = 'muted';
  note.textContent = 'Apple expects an answer to reports within 24 hours.';
  $('tb').append(note);
  if (!reports.length) { $('list').innerHTML = '<div class="empty">No reports.</div>'; return; }
  $('list').innerHTML = `<table><tr><th>When</th><th>About</th><th>From</th><th>Why</th><th></th></tr>${reports.map((r) => `<tr>
    <td>${when(r.created_at)}</td><td><a href="#" data-user="${esc(r.target_id)}">${esc(r.target_name)}</a><div class="mono muted">${esc(r.target_id)}</div></td>
    <td><a href="#" data-user="${esc(r.reporter_id)}">${esc(r.reporter_name)}</a></td>
    <td class="wrap">${r.reason === 'Impossible drop-off location' ? `<span class="pill bad">${esc(r.reason)}</span>` : esc(r.reason)}<div class="muted">${esc(r.message ?? '')}</div>${r.ride_id ? `<a href="#" data-ride="${esc(r.ride_id)}">See the ride: planned route and playback</a>` : ''}${reportChat(r)}</td>
    <td>${r.status === 'open' ? `<button data-close="${esc(r.id)}">Close</button>` : `<span class="pill">closed</span><div class="muted">${esc(r.note ?? '')}</div>`}</td></tr>`).join('')}</table>`;
  $('list').querySelectorAll('a[data-user]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); userDialog(a.dataset.user); }; });
  $('list').querySelectorAll('a[data-ride]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); rideDialog(a.dataset.ride); }; });
  $('list').querySelectorAll('[data-close]').forEach((b) => { b.onclick = act(async () => {
    const note = prompt('What did you do? (only for you)');
    if (note === null) return;
    await api('POST', `/reports/${b.dataset.close}/close`, { note });
    go('reports');
  }); });
}

async function supportView(filter = 'open') {
  const { requests } = await api('GET', `/support?filter=${filter}`);
  $('view').innerHTML = '<div class="toolbar" id="tb"></div><div class="panel" id="list"></div>';
  $('tb').append(seg([['open', 'Open'], ['all', 'All']], filter, supportView));
  if (!requests.length) { $('list').innerHTML = '<div class="empty">No messages.</div>'; return; }
  $('list').innerHTML = `<table><tr><th>When</th><th>From</th><th>Message</th><th></th></tr>${requests.map((r) => `<tr>
    <td>${when(r.created_at)}</td><td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a><div class="muted">${esc(r.topic ?? '')}</div></td>
    <td class="wrap">${esc(r.message)}</td><td>${r.status === 'open' ? `<button data-close="${esc(r.id)}">Done</button>` : '<span class="pill">done</span>'}</td></tr>`).join('')}</table>`;
  $('list').querySelectorAll('[data-close]').forEach((b) => { b.onclick = act(async () => { await api('POST', `/support/${b.dataset.close}/close`, {}); go('support'); }); });
}

// ---------- wallet changes ----------

const WALLET_CHANGE_WORDS = { open: 'waiting', allowed: 'allowed, not used yet', declined: 'declined', used: 'changed' };
// Both coins usually share one wallet: then it's one line.
function walletLines(wallets) {
  const byAddress = new Map();
  for (const w of wallets) byAddress.set(w.address, [...(byAddress.get(w.address) ?? []), w]);
  return [...byAddress].map(([address, list]) => `${esc(address)}<div class="muted">${esc(list.map((w) => w.coin).join(', '))}${list[0].via ? `, ${esc(list[0].via)}` : ''}</div>`).join('');
}
async function walletChangesView(filter = 'open') {
  const { requests } = await api('GET', `/wallet-changes?filter=${filter}`);
  $('view').innerHTML = '<div class="toolbar" id="tb"></div><div class="panel" id="list"></div>';
  $('tb').append(seg([['open', 'Waiting'], ['allowed', 'Allowed'], ['all', 'All']], filter, walletChangesView));
  if (!requests.length) { $('list').innerHTML = '<div class="empty">No requests.</div>'; return; }
  $('list').innerHTML = `<table><tr><th>When</th><th>Who</th><th>Wallet now</th><th>Their message</th><th>Good to know</th><th></th></tr>${requests.map((r) => `<tr>
    <td>${when(r.created_at)}</td>
    <td class="click" data-user="${esc(r.user_id)}">${esc(r.name)}${r.name === r.user_id ? '' : `<div class="muted mono">${esc(r.user_id)}</div>`}${r.email ? `<div class="muted">${esc(r.email)}</div>` : ''}</td>
    <td class="mono address">${r.status === 'used' ? `${esc(r.old_address)}<div class="muted">became</div>${esc(r.new_address)}` : walletLines(r.wallets) || '–'}</td>
    <td class="wrap">${r.message ? esc(r.message) : '<span class="muted">No message.</span>'}</td>
    <td class="muted">Joined ${ago(r.joined_at)}<br>${r.drives} ride${r.drives === 1 ? '' : 's'} driven<br>${r.earlier ? `${r.earlier} earlier request${r.earlier === 1 ? '' : 's'}` : 'First request'}</td>
    <td>${r.status === 'open' ? `<div class="row"><button class="primary" data-allow="${esc(r.id)}">Allow</button><button class="danger" data-decline="${esc(r.id)}">Decline</button></div>`
      : `<span class="pill ${r.status === 'allowed' ? 'warn' : r.status === 'declined' ? 'bad' : 'ok'}">${esc(WALLET_CHANGE_WORDS[r.status] ?? r.status)}</span>${r.status === 'allowed' ? `<div class="row"><button data-decline="${esc(r.id)}">Take back</button></div>` : ''}`}</td>
  </tr>`).join('')}</table>`;
  const decide = (id, decision) => act(async () => { await api('POST', `/wallet-changes/${id}`, { decision }); await refreshStats(); await walletChangesView(filter); });
  $('list').querySelectorAll('[data-allow]').forEach((b) => { b.onclick = decide(b.dataset.allow, 'allow'); });
  $('list').querySelectorAll('[data-decline]').forEach((b) => { b.onclick = decide(b.dataset.decline, 'decline'); });
  $('list').querySelectorAll('[data-user]').forEach((c) => { c.onclick = () => userDialog(c.dataset.user); });
}

// ---------- driver checks (the Netherlands) ----------

const CHECK_WORDS = { started: 'Not finished', review: 'Waiting for you', approved: 'Approved', declined: 'Declined' };
const CHECK_PILLS = { started: '', review: 'warn', approved: 'ok', declined: 'bad' };
const ITEM_NAMES = { id: 'ID (chip)', face: 'Face', chauffeurskaart: 'Chauffeurskaart', permit: 'Taxi permit', kvk: 'KvK', plate: 'Photo of the car’s back' };
async function checksView(filter = 'review') {
  const { checks } = await api('GET', `/checks?filter=${filter}`);
  $('view').innerHTML = '<div class="toolbar" id="tb"></div><div class="panel" id="list"></div>';
  $('tb').append(seg([['review', 'Waiting'], ['approved', 'Approved'], ['declined', 'Declined'], ['started', 'Not finished'], ['all', 'All']], filter, checksView));
  if (!checks.length) { $('list').innerHTML = '<div class="empty">Nothing here.</div>'; return; }
  $('list').innerHTML = `<table><tr><th>Sent</th><th>Account</th><th>Name on the ID</th><th>Face</th><th>Why it waits</th><th></th></tr>${checks.map((c) => `<tr class="click" data-check="${esc(c.user_id)}">
    <td>${when(c.submitted_at ?? c.updated_at)}</td>
    <td>${esc(c.name)}<div class="muted mono">${esc(c.user_id)}</div>${c.email ? `<div class="muted">${esc(c.email)}</div>` : ''}</td>
    <td>${esc([c.given_names, c.surname].filter(Boolean).join(' ') || '–')}${c.doc_country ? `<div class="muted">${esc(c.doc_country)}</div>` : ''}</td>
    <td>${c.face_score != null ? Math.round(c.face_score * 100) : '–'}</td>
    <td class="wrap">${c.review_reasons.length ? c.review_reasons.map(esc).join('<br>') : '<span class="muted">–</span>'}</td>
    <td><span class="pill ${CHECK_PILLS[c.status] ?? ''}">${esc(CHECK_WORDS[c.status] ?? c.status)}</span>${c.status === 'approved' ? `<div class="muted">${c.auto ? 'by itself' : 'by a person'}</div>` : ''}</td>
  </tr>`).join('')}</table>`;
  $('list').querySelectorAll('[data-check]').forEach((r) => { r.onclick = () => checkDialog(r.dataset.check, () => checksView(filter)); });
}

async function checkDialog(id, done) {
  const { check: c, user, sameId, vehicles, drives, signingKeys = [] } = await api('GET', `/checks/${encodeURIComponent(id)}`);
  const yes = (v) => (v == null ? '<span class="muted">–</span>' : v ? '<span class="pill ok">yes</span>' : '<span class="pill bad">no</span>');
  const photo = (kind, label) => (c.files[kind] ? `<figure><img src="/admin/api/checks/${encodeURIComponent(id)}/file/${kind}" alt="${esc(label)}" style="max-width:100%;max-height:340px;border-radius:8px;display:block"><figcaption class="muted">${esc(label)}</figcaption></figure>` : '');
  openDialog(`<h1>${esc([c.given_names, c.surname].filter(Boolean).join(' ') || user.name)}</h1>
    <div class="muted"><a href="#" data-user="${esc(user.id)}">${esc(user.name)}</a> · <span class="mono">${esc(user.id)}</span>${user.email ? ` · ${esc(user.email)}` : ''} · joined ${ago(user.joinedAt)} · ${drives} drive${drives === 1 ? '' : 's'}</div>
    <p><span class="pill ${CHECK_PILLS[c.status] ?? ''}">${esc(CHECK_WORDS[c.status] ?? c.status)}</span>${c.decided_at ? ` <span class="muted">${c.auto ? 'by itself' : `by ${esc(c.decided_by)}`}, ${when(c.decided_at)}</span>` : ''}${c.decision_note ? `<br><span class="muted">Note: ${esc(c.decision_note)}</span>` : ''}</p>
    ${c.review_reasons.length ? `<div class="banner bad">${c.review_reasons.map(esc).join('<br>')}</div>` : ''}
    <p class="muted">${signingKeys.length
      ? `Signs with: ${signingKeys.map((k) => `${k.environment === 'android' ? 'an Android phone' : k.environment === 'development' ? 'an iPhone, debug build' : 'an iPhone'} (${when(k.at)})`).join(', ')}.`
      : 'No phone of theirs proved it runs the real app, so nothing they sent is signed: an older app, a simulator or emulator, or a phone that couldn’t (an unlocked bootloader, say).'}</p>
    ${sameId.length ? `<p class="muted">The same ID on: ${sameId.map((s) => `<a href="#" data-user="${esc(s.user_id)}">${esc(s.name)}</a> (${esc(s.status)})`).join(', ')}</p>` : ''}
    <h2>ID, from its chip</h2>
    <dl class="kv"><dt>Name</dt><dd>${esc(c.surname ?? '–')}, ${esc(c.given_names ?? '')}</dd><dt>Born</dt><dd>${esc(c.birth_date ?? '–')}</dd>
      <dt>Document</dt><dd>${esc(c.doc_type ?? '–')} of ${esc(c.doc_country ?? '–')}, ends in ${esc(c.doc_last4 ?? '–')}, valid until ${esc(c.doc_expires ?? '–')}</dd>
      <dt>Signed by the state</dt><dd>${yes(c.chip_signed)}${c.chip_problems ? ` <span class="muted">${esc(c.chip_problems)}</span>` : ''}</dd>
      <dt>Chip answered our challenge</dt><dd>${c.chip_live == null ? '<span class="muted">this chip can’t</span>' : yes(c.chip_live)}</dd><dt>Read</dt><dd>${when(c.chip_at)}</dd></dl>
    <h2>Face</h2>
    ${c.face_by_person ? `<p>They asked for a person to compare their face with the chauffeurskaart’s photo.</p>${photo('face', 'Their selfie')}` : `<dl class="kv"><dt>Match with the chip’s photo</dt><dd>${c.face_score != null ? `${Math.round(c.face_score * 100)} <span class="muted">(passes by itself from ${Math.round((overview.faceAutoMatch ?? 0.4) * 100)})</span>` : '–'}</dd>
      <dt>Turned their head</dt><dd>${yes(c.face_live)}</dd><dt>Signed by the real app</dt><dd>${yes(c.face_attested)}</dd><dt>Done</dt><dd>${when(c.face_at)}</dd></dl>`}
    <h2>Chauffeurskaart</h2>
    <dl class="kv"><dt>Number</dt><dd class="mono">${esc(c.ck_number ?? '–')}</dd><dt>Valid until</dt><dd>${esc(c.ck_expires ?? '–')}</dd><dt>Signed by the real app</dt><dd>${yes(c.ck_attested)}</dd><dt>Taken with the camera</dt><dd>${yes(c.ck_camera)}</dd><dt>Read from it</dt><dd class="wrap muted">${esc(c.ck_text ?? '–')}</dd></dl>
    ${photo('ck', 'Chauffeurskaart')}
    <h2>Taxi permit</h2>
    <dl class="kv"><dt>Number</dt><dd class="mono">${esc(c.permit_number ?? '–')}</dd><dt>Valid until</dt><dd>${esc(c.permit_expires ?? '–')}</dd><dt>Signed by the real app</dt><dd>${yes(c.permit_attested)}</dd><dt>Taken with the camera</dt><dd>${yes(c.permit_camera)}</dd><dt>Read from it</dt><dd class="wrap muted">${esc(c.permit_text ?? '–')}</dd></dl>
    ${photo('permit', 'Taxi permit')}
    <p class="muted">Kiwa has no register to look these up in; compare the name and photo with the ID.</p>
    <h2>KvK</h2>
    <dl class="kv"><dt>Number</dt><dd class="mono">${c.kvk_number ? `<a href="https://www.kvk.nl/zoeken/?source=all&q=${esc(c.kvk_number)}" target="_blank" rel="noopener">${esc(c.kvk_number)}</a>` : '–'}</dd><dt>Name</dt><dd>${esc(c.kvk_name ?? '–')}</dd>
      <dt>Found</dt><dd>${c.kvk_checked_at ? yes(c.kvk_found) : '<span class="muted">not asked (no KvK key)</span>'}</dd><dt>Still registered</dt><dd>${yes(c.kvk_active)}</dd><dt>Taxi (SBI 49.32)</dt><dd>${yes(c.kvk_taxi)}</dd></dl>
    <h2>Cars, from the RDW</h2>
    ${vehicles.length ? `<div class="panel"><table><tr><th>Plate</th><th>Taxi</th><th>Insured</th><th>APK until</th><th>Exported</th><th>Plate on its photo</th><th>Asked</th></tr>${vehicles.map((v) => `<tr><td class="mono">${esc(v.platePretty ?? v.plate)}</td><td>${v.found === false ? '<span class="pill bad">not in the register</span>' : yes(v.taxi)}</td><td>${yes(v.insured)}</td><td>${esc(v.apkUntil ?? '–')}</td><td>${v.exported ? '<span class="pill bad">yes</span>' : '<span class="muted">no</span>'}</td><td>${yes(v.plateSeen)}${v.backPhoto ? ` <a href="${esc(v.backPhoto)}" target="_blank" rel="noopener">photo</a>` : ''}</td><td>${ago(v.checkedAt)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No cars.</p>'}
    <p class="muted">The photos of documents go 30 days after the decision.</p>
    <div class="row">
      <button class="primary" id="cApprove">Approve</button>
      <button class="danger" id="cDecline">Decline</button>
      <select id="cAgain"><option value="">Ask again for…</option>${Object.entries(ITEM_NAMES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
    </div>`);
  const body = $('dialogBody');
  const decide = (decision, ask) => act(async () => {
    const note = prompt(ask);
    if (note === null) return;
    await api('POST', `/checks/${encodeURIComponent(id)}`, { decision, note });
    $('dialog').close();
    await refreshStats();
    done?.();
  });
  $('cApprove').onclick = decide('approve', 'A note for the record (optional). They can drive once you click OK.');
  $('cDecline').onclick = decide('decline', 'Why? The driver sees this.');
  $('cAgain').onchange = (e) => { if (e.target.value) decide(`again:${e.target.value}`, 'What should they send again, and why? The driver sees this.')(); e.target.value = ''; };
  body.querySelectorAll('[data-user]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); userDialog(a.dataset.user); }; });
}

// ---------- appeals ----------

async function appealsView(filter = 'open') {
  const { appeals } = await api('GET', `/appeals?filter=${filter}`);
  const view = $('view');
  view.innerHTML = '<div class="toolbar" id="tb"></div><div class="panel" id="list"></div>';
  $('tb').append(seg([['open', 'Open'], ['all', 'All']], filter, appealsView));
  if (!appeals.length) { $('list').innerHTML = '<div class="empty">No appeals.</div>'; return; }
  $('list').innerHTML = `<table><tr><th>When</th><th>Who</th><th>Ban</th><th>Their message</th><th></th></tr>${appeals.map((a) => `<tr>
    <td>${when(a.created_at)}</td><td><a href="#" data-user="${esc(a.user_id)}">${esc(a.name)}</a><div class="mono muted">${esc(a.user_id)}</div></td>
    <td class="wrap">${esc(a.reason)}<div class="muted">${a.ends_at ? `until ${when(a.ends_at)}` : 'for good'}</div></td>
    <td class="wrap">${esc(a.message)}</td>
    <td>${a.status === 'open' ? `<button class="primary" data-lift="${esc(a.id)}">Lift ban</button> <button data-uphold="${esc(a.id)}">Keep ban</button>` : `<span class="pill">${esc(a.status)}</span><div class="muted">${esc(a.answer ?? '')}</div>`}</td></tr>`).join('')}</table>`;
  const decide = (id, decision) => act(async () => {
    const answer = prompt(decision === 'lift' ? 'Answer to them (optional)' : 'Answer to them. This is final: no more appeals from the app.');
    if (answer === null) return;
    await api('POST', `/appeals/${id}`, { decision, answer });
    go('appeals');
  });
  $('list').querySelectorAll('[data-lift]').forEach((b) => { b.onclick = decide(b.dataset.lift, 'lift'); });
  $('list').querySelectorAll('[data-uphold]').forEach((b) => { b.onclick = decide(b.dataset.uphold, 'uphold'); });
  $('list').querySelectorAll('a[data-user]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); userDialog(a.dataset.user); }; });
}

async function disputesView(filter = 'open') {
  const { disputes } = await api('GET', `/disputes?filter=${filter}`);
  const view = $('view');
  view.innerHTML = '<div class="toolbar" id="tb"></div><div class="panel" id="list"></div>';
  $('tb').append(seg([['open', 'Open'], ['all', 'All']], filter, disputesView));
  if (!disputes.length) { $('list').innerHTML = '<div class="empty">No appeals about rides.</div>'; return; }
  $('list').innerHTML = `<table><tr><th>When</th><th>Ride</th><th>Appeal</th><th>Together</th><th>Driven</th><th>Reached drop-off</th><th></th></tr>${disputes.map((d) => `<tr>
    <td>${when(d.created_at)}</td>
    <td><a href="#" data-ride="${esc(d.ride_id)}">${esc(d.ride.riderName)} → ${esc(d.ride.driverName ?? '–')}</a><div class="muted">${eur(d.ride.priceCents)} · ${d.ride.coin === 'cash' ? 'paid in cash' : `${esc(d.ride.coinAmount)} ${esc(d.ride.coin)}`}</div></td>
    <td class="wrap">${esc(d.message)}<div class="muted">${d.opened_by ? `by ${esc(d.opened_by)}` : 'by Drivezzz'}</div></td>
    <td>${d.ride.syncScore != null ? `${Math.round(d.ride.syncScore * 100)}%` : '–'}</td>
    <td>${d.ride.progress != null ? `${d.ride.progress}%` : '–'}${d.ride.checkoutWarning ? '<div><span class="pill warn">rider not at drop-off</span></div>' : ''}</td>
    <td>${d.ride.closestM != null ? `${d.ride.closestM} m` : 'never'}</td>
    <td>${d.status !== 'open' ? `<span class="pill">${esc(d.status)}</span>` : d.ride.coin === 'cash' ? `<button class="primary" data-close="${esc(d.id)}">Close</button>` : `<button class="primary" data-pay="${esc(d.id)}">Pay driver</button> <button data-split="${esc(d.id)}">Split 50/50</button> <button data-refund="${esc(d.id)}">Refund rider</button>`}</td></tr>`).join('')}</table>
    <p class="muted">The escrow holds the money until you decide. Without a decision a driver who appealed after at least 60% of the way is paid after 3 days; everything else is refunded to the rider after 30 days. A ride paid in cash has no money to hold: you can only answer and close it.</p>`;
  const decide = (id, decision) => act(async () => {
    const answer = prompt('Answer to them (optional)');
    if (answer === null) return;
    await api('POST', `/disputes/${id}`, { decision, answer });
    go('disputes');
  });
  $('list').querySelectorAll('[data-pay]').forEach((b) => { b.onclick = decide(b.dataset.pay, 'pay_driver'); });
  $('list').querySelectorAll('[data-refund]').forEach((b) => { b.onclick = decide(b.dataset.refund, 'refund_rider'); });
  $('list').querySelectorAll('[data-split]').forEach((b) => { b.onclick = decide(b.dataset.split, 'split'); });
  $('list').querySelectorAll('[data-close]').forEach((b) => { b.onclick = decide(b.dataset.close, 'closed'); });
  $('list').querySelectorAll('a[data-ride]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); rideDialog(a.dataset.ride); }; });
}

// ---------- rides ----------

// A ride's status the same way everywhere, also in the app: completed green, under way yellow, cancelled red.
const RIDE_WORDS = { searching: 'waiting for driver', offered: 'waiting for driver', open: 'on the market', awaiting_payment: 'waiting for payment', scheduled: 'planned', accepted: 'driver on the way', arrived: 'driver at pickup', riding: 'riding', completed: 'completed', cancelled: 'cancelled' };
const ridePill = (status) => `<span class="pill ${status === 'completed' ? 'ok' : status === 'cancelled' ? 'bad' : 'ongoing'}">${esc(RIDE_WORDS[status] ?? status)}</span>`;

async function ridesView(filter = 'live') {
  const { rides } = await api('GET', `/rides?filter=${filter}`);
  const view = $('view');
  view.innerHTML = '<div class="toolbar" id="tb"></div><div class="panel" id="list"></div>';
  $('tb').append(seg([['live', 'Under way'], ['open', 'Waiting'], ['flagged', 'Flagged'], ['all', 'All']], filter, ridesView));
  if (!rides.length) { $('list').innerHTML = '<div class="empty">No rides.</div>'; return; }
  $('list').innerHTML = `<table><tr><th>Created</th><th>Status</th><th>Rider</th><th>Driver</th><th>From → to</th><th>Price</th><th>Together</th></tr>${rides.map((r) => `<tr class="click" data-ride="${esc(r.id)}">
    <td>${when(r.createdAt)}</td><td>${ridePill(r.status)}${r.scheduledAt ? `<div class="muted">for ${when(r.scheduledAt)}</div>` : ''}</td>
    <td>${esc(r.riderName)}</td><td>${esc(r.driverName ?? '–')}</td>
    <td class="wrap">${esc(r.pickup ?? '–')} → ${esc(r.dropoff ?? '–')}</td><td>${eur(r.priceCents ?? r.maxCents)}</td><td>${r.syncScore != null ? `${Math.round(r.syncScore * 100)}%` : '–'}${r.safetyAskedAt ? `<div><span class="pill ${r.safetyAnswer === 'not_ok' ? 'bad' : 'warn'}">asked: ${esc(r.safetyAnswer ?? 'no answer')}</span></div>` : ''}</td></tr>`).join('')}</table>`;
  $('list').querySelectorAll('[data-ride]').forEach((r) => { r.onclick = () => rideDialog(r.dataset.ride); });
}

// Stepping in on a ride's money: hold it, or settle it now. Only while it's still in its escrow.
const escrowButtons = (e, rideId) => (e.status === 'paid' ? `<div class="row">
  <button data-hold="${esc(rideId)}" data-on="${e.onHold ? '0' : '1'}">${e.onHold ? 'Release hold' : 'Hold'}</button>
  <button class="danger" data-decide="${esc(rideId)}" data-how="refund_rider">Refund</button>
  <button data-decide="${esc(rideId)}" data-how="split">Split 50/50</button>
  <button class="primary" data-decide="${esc(rideId)}" data-how="pay_driver">Pay driver</button></div>` : '');
function bindEscrowButtons(root, again) {
  const asks = { refund_rider: 'Refund everything to the wallet that paid, now?', split: 'Split it 50/50 between the rider and the driver, now?', pay_driver: 'Pay the driver now, minus the fee?' };
  root.querySelectorAll('[data-hold]').forEach((b) => { b.onclick = act(async () => { await api('POST', `/rides/${b.dataset.hold}/hold`, { hold: b.dataset.on === '1' }); await again(); refreshStats(); }); });
  root.querySelectorAll('[data-decide]').forEach((b) => {
    b.onclick = act(async () => {
      const answer = prompt(`${asks[b.dataset.how]} This can't be undone.\n\nSay why (they see this), or leave it empty. Cancel stops it.`);
      if (answer === null) return;
      await api('POST', `/rides/${b.dataset.decide}/decide`, { decision: b.dataset.how, answer });
      await again();
      refreshStats();
    });
  });
}

async function rideDialog(id) {
  const { ride: r, events, payouts, disputes, points, escrows, map } = await api('GET', `/rides/${id}`);
  openDialog(`<h1>Ride</h1><div class="mono muted">${esc(r.id)}</div>
    <dl class="kv"><dt>Status</dt><dd>${ridePill(r.status)} ${r.cancelReason ? `(${esc(r.cancelledBy)}: ${esc(r.cancelReason)})` : ''}</dd>
    <dt>Rider</dt><dd>${esc(r.riderName)} <span class="mono muted">${esc(r.riderId)}</span></dd>
    <dt>Driver</dt><dd>${esc(r.driverName ?? '–')} <span class="mono muted">${esc(r.driverId ?? '')}</span></dd>
    <dt>From</dt><dd>${esc(r.pickup ?? '–')}</dd><dt>To</dt><dd>${esc(r.dropoff ?? '–')}${r.dropoffMovedM > 25 ? ` <span class="pill warn">moved ${r.dropoffMovedM} m to where a car can get</span>` : ''}</dd>
    <dt>Distance</dt><dd>${(r.distanceM / 1000).toFixed(1)} km</dd>
    <dt>Price</dt><dd>${eur(r.priceCents)} ${r.coin === 'cash' ? '(in cash)' : `(held ${esc(r.coinAmount)} ${esc(r.coin)})`}</dd>
    <dt>Together</dt><dd>${r.syncScore != null ? `${Math.round(r.syncScore * 100)}%` : '–'} <span class="muted">${points.rider} rider and ${points.driver} driver positions</span></dd>
    <dt>Closest to drop-off</dt><dd>${r.closestM != null ? `${r.closestM} m` : '–'}</dd>
    <dt>Late at pickup</dt><dd>${r.arrivalLateS != null ? `${Math.round(r.arrivalLateS / 60)} min` : '–'}</dd></dl>
    <h2>Planned route and positions</h2><div id="ridemap"></div>
    <h2>What happened</h2><div class="panel"><table>${events.map((e) => `<tr><td>${when(e.at)}</td><td>${esc(e.kind)}</td><td class="wrap muted">${esc(e.detail ?? '')}</td></tr>`).join('')}</table></div>
    ${escrows.length ? `<h2>Escrow</h2>${r.checkoutWarning ? '<p><span class="pill warn">rider not near the drop-off at check-out</span></p>' : ''}<div class="panel"><table>${escrows.map((e) => `<tr><td>${esc(e.amount)} ${esc(e.coin === 'sol' ? 'SOL' : 'USDC')}<div class="muted">fee ${esc(e.fee)}</div></td>
      <td><span class="pill">${esc(e.status)}</span>${e.outcome ? ` <span class="pill">${esc(e.outcome)}</span>` : ''}${e.onHold ? ' <span class="pill warn">on hold</span>' : ''}</td>
      <td class="mono wrap">from ${esc(e.payer)}<br>to ${esc(e.driverAddress)}</td>
      <td class="wrap">${e.error ? `<span class="pill bad">${esc(e.error)}</span>` : ''}</td>
      <td><a target="_blank" rel="noopener" href="${esc(e.settleExplorer ?? e.explorer)}">chain</a></td></tr>`).join('')}</table></div>
      ${escrows.filter((e) => e.status === 'paid').map((e) => escrowButtons(e, r.id)).join('')}` : ''}
    ${disputes.length ? `<h2>Appeals</h2><div class="panel"><table>${disputes.map((d) => `<tr><td>${when(d.created_at)}</td><td class="wrap">${esc(d.message)}</td><td><span class="pill">${esc(d.status)}</span></td></tr>`).join('')}</table></div>` : ''}
    ${payouts.length ? `<h2>Payout</h2><div class="panel"><table>${payouts.map((p) => `<tr><td><span class="pill">${esc(p.status)}</span></td><td>due ${when(p.due_at)}</td><td class="mono">${esc(p.txid ?? '')}</td><td class="wrap muted">${esc(p.error ?? '')}</td></tr>`).join('')}</table></div>` : ''}`);
  rideMap($('ridemap'), map);
}

// ---------- a ride on the map: the planned route, and both phones played back ----------

const TILE = 256;
const mapX = (lng, z) => ((lng + 180) / 360) * TILE * 2 ** z;
const mapY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
};
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function rideMap(root, { route, pickup, dropoff, rider, driver }) {
  const W = root.clientWidth || 640, H = 360;
  const spots = [...route.map(([lat, lng]) => ({ lat, lng })), pickup, dropoff, ...rider, ...driver];
  const lats = spots.map((p) => p.lat), lngs = spots.map((p) => p.lng);
  const west = Math.min(...lngs), east = Math.max(...lngs), south = Math.min(...lats), north = Math.max(...lats);
  let z = 18;
  while (z > 2 && (mapX(east, z) - mapX(west, z) > W - 70 || mapY(south, z) - mapY(north, z) > H - 70)) z--;
  let cx = mapX((west + east) / 2, z), cy = mapY((north + south) / 2, z);
  const times = [...rider, ...driver].map((p) => p.at);
  const start = times.length ? Math.min(...times) : null, end = times.length ? Math.max(...times) : null;
  let t = end, timer = null;

  root.innerHTML = `<div class="ridemap" style="height:${H}px">
      <div class="tiles"></div><svg width="${W}" height="${H}"><g class="base"></g><g class="moving"></g></svg>
      <div class="zoom"><button type="button" data-zoom="1" aria-label="Zoom in">+</button><button type="button" data-zoom="-1" aria-label="Zoom out">−</button></div>
      <a class="credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>
    </div>
    <div class="legend"><span><i style="background:#1E6BFF"></i>Planned route</span><span><i style="background:#16A34A"></i>Pickup</span><span><i style="background:#DC2626"></i>Drop-off</span>${start != null ? '<span><i style="background:#EA580C"></i>Driver</span><span><i style="background:#7C3AED"></i>Rider</span>' : ''}</div>
    ${start != null ? `<div class="playback"><button type="button" class="play">Play</button><input type="range" min="${start}" max="${end}" step="1000" value="${end}" aria-label="Time in the ride"><span class="mono playclock"></span></div>
      <p class="muted">Each second plays one minute of the ride. A faded dot is a phone that had stopped sending.</p>` : '<p class="muted">No positions for this ride: nobody set off, or it\'s older than the 90 days they\'re kept.</p>'}`;

  const box = root.querySelector('.ridemap'), tiles = root.querySelector('.tiles'), base = root.querySelector('.base'), moving = root.querySelector('.moving');
  const sx = (lng) => mapX(lng, z) - cx + W / 2, sy = (lat) => mapY(lat, z) - cy + H / 2;
  const line = (points, attrs) => (points.length > 1 ? `<polyline fill="none" stroke-linecap="round" stroke-linejoin="round" points="${points.map((p) => `${sx(p.lng).toFixed(1)},${sy(p.lat).toFixed(1)}`).join(' ')}" ${attrs}/>` : '');
  const dot = (p, colour, label, opacity = 1) => `<g opacity="${opacity}"><circle cx="${sx(p.lng).toFixed(1)}" cy="${sy(p.lat).toFixed(1)}" r="9" fill="${colour}" stroke="#fff" stroke-width="2"/><text x="${sx(p.lng).toFixed(1)}" y="${(sy(p.lat) + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${label}</text></g>`;
  const at = (list) => { let last = null; for (const p of list) { if (p.at > t) break; last = p; } return last; };

  function drawMoving() {
    if (start == null) return;
    const until = (list) => list.filter((p) => p.at <= t);
    const d = at(driver), r = at(rider);
    moving.innerHTML = line(until(driver), 'stroke="#EA580C" stroke-width="3" stroke-dasharray="1 6"') + line(until(rider), 'stroke="#7C3AED" stroke-width="3" stroke-dasharray="1 6"')
      + (d ? dot(d, '#EA580C', 'D', t - d.at > 120_000 ? 0.45 : 1) : '') + (r ? dot(r, '#7C3AED', 'R', t - r.at > 120_000 ? 0.45 : 1) : '');
    root.querySelector('.playclock').textContent = `${clock(t)}  ${driver.length} driver, ${rider.length} rider positions`;
    root.querySelector('input[type=range]').value = t;
  }
  function draw() {
    const left = cx - W / 2, top = cy - H / 2, n = 2 ** z;
    let imgs = '';
    for (let x = Math.floor(left / TILE); x * TILE < left + W; x++) {
      for (let y = Math.floor(top / TILE); y * TILE < top + H; y++) {
        if (y < 0 || y >= n) continue;
        imgs += `<img alt="" src="https://tile.openstreetmap.org/${z}/${((x % n) + n) % n}/${y}.png" style="left:${x * TILE - left}px;top:${y * TILE - top}px">`;
      }
    }
    tiles.innerHTML = imgs;
    const planned = route.map(([lat, lng]) => ({ lat, lng }));
    base.innerHTML = line(planned, 'stroke="#fff" stroke-width="8"') + line(planned, 'stroke="#1E6BFF" stroke-width="5"') + dot(pickup, '#16A34A', 'P') + dot(dropoff, '#DC2626', 'X');
    drawMoving();
  }
  const stop = () => { clearInterval(timer); timer = null; const b = root.querySelector('.play'); if (b) b.textContent = 'Play'; };
  root.querySelectorAll('[data-zoom]').forEach((b) => { b.onclick = () => {
    const step = Number(b.dataset.zoom);
    if (z + step < 2 || z + step > 19) return;
    z += step; cx *= 2 ** step; cy *= 2 ** step;
    draw();
  }; });
  // Dragging moves the map.
  box.onpointerdown = (e) => {
    if (e.target.closest('button, a')) return;
    box.setPointerCapture(e.pointerId);
    let x = e.clientX, y = e.clientY;
    box.onpointermove = (m) => { cx -= m.clientX - x; cy -= m.clientY - y; x = m.clientX; y = m.clientY; draw(); };
    box.onpointerup = () => { box.onpointermove = null; box.onpointerup = null; };
  };
  if (start != null) {
    root.querySelector('input[type=range]').oninput = (e) => { stop(); t = Number(e.target.value); drawMoving(); };
    root.querySelector('.play').onclick = (e) => {
      if (timer) { stop(); return; }
      if (t >= end) t = start;
      e.target.textContent = 'Pause';
      drawMoving();
      timer = setInterval(() => {
        if (!root.isConnected || !$('dialog').open) { stop(); return; }
        t = Math.min(end, t + 60_000);
        drawMoving();
        if (t >= end) stop();
      }, 1000);
    };
  }
  draw();
}

// ---------- money: the escrow on Solana ----------

async function escrowView() {
  const view = $('view');
  view.innerHTML = '<div class="empty">Asking the chain…</div>';
  const w = await api('GET', '/escrow');
  const row = (e) => `<tr><td>${when(e.paidAt)}</td><td><a href="#" data-ride="${esc(e.rideId)}">${esc(e.rideId)}</a></td>
    <td>${esc(e.amount)} ${esc(e.coin === 'sol' ? 'SOL' : 'USDC')}<div class="muted">fee ${esc(e.fee)}</div></td>
    <td>${e.rideStatus ? ridePill(e.rideStatus) : ''} <span class="pill">${esc(e.status)}</span>${e.outcome ? ` <span class="pill">${esc(e.outcome)}</span>` : ''}${e.onHold ? ' <span class="pill warn">on hold</span>' : ''}${e.settleAfter && e.status === 'paid' ? `<div class="muted">${e.onHold ? 'held, was due' : 'from'} ${when(e.settleAfter)}</div>` : ''}</td>
    <td class="wrap">${e.error ? `<span class="pill bad">${esc(e.error)}</span>` : ''}</td>
    <td>${escrowButtons(e, e.rideId)}</td>
    <td>${w.pretendChain ? '' : `<a target="_blank" rel="noopener" href="${esc(e.settleExplorer ?? e.explorer)}">chain</a>`}</td></tr>`;
  const head = '<tr><th>Paid</th><th>Ride</th><th>Amount</th><th>State</th><th></th><th>Step in</th><th></th></tr>';
  view.innerHTML = `
    ${w.pretendChain ? '<div class="banner">Pretend chain: there is no contract yet and no real money moves. Paying is a button, and every outcome here settles at once.</div>' : w.network === 'testnet' ? '<div class="banner">On devnet: only test coins move.</div>' : ''}
    ${w.problem ? `<div class="banner bad">${esc(w.problem)}</div>` : ''}
    <div class="panel"><dl class="facts">
      <dt>Contract</dt><dd class="mono">${w.programId ? `<a target="_blank" rel="noopener" href="https://explorer.solana.com/address/${esc(w.programId)}${w.network === 'mainnet' ? '' : '?cluster=devnet'}">${esc(w.programId)}</a>` : 'not set'}</dd>
      <dt>Server key</dt><dd class="mono">${esc(w.serverKey ?? 'missing')} <span class="muted">${w.serverSol != null ? `${w.serverSol} SOL for fees (each escrow pays its own back)` : ''}</span></dd>
      <dt>Your Solana address</dt><dd>
        <form id="feeForm" class="toolbar"><input id="feeAddress" class="mono" size="46" value="${esc(w.feeAddress)}" autocomplete="off" spellcheck="false" aria-label="Your Solana address"><button>Connect</button></form>
        <div class="muted">Your €0.10 per ride goes here${w.fee?.sol != null ? `: it holds ${esc(w.fee.sol)} SOL, ${w.fee.usdcAccount ? 'with' : '<b>without</b>'} a USDC account` : ''}. Only the public address: never your 12 words or private key.</div>
      </dd>
      <dt>In escrows now</dt><dd>${esc(w.held.sol)} SOL · ${esc(w.held['usdc-sol'])} USDC</dd>
    </dl>
    <div class="toolbar">${w.pretendChain ? '' : `<button id="net" class="${w.network === 'testnet' ? 'danger' : ''}">Switch to ${w.network === 'testnet' ? 'mainnet' : 'devnet'}</button>`}
    <span class="muted">Drivezzz never holds the coins: each ride's money is in its own escrow, which only pays the rider who paid, the driver and the fee address.</span></div></div>
    <h2>In escrow</h2><p class="muted">You can step in on any of these, appealed or not. Hold keeps the money where it is until you release or decide it; only the refund after 30 days still goes ahead.</p><div class="panel">${w.open.length ? `<table>${head}${w.open.map(row).join('')}</table>` : '<div class="empty">Nothing in escrow.</div>'}</div>
    <h2>Settled lately</h2><div class="panel">${w.recent.length ? `<table>${head}${w.recent.map(row).join('')}</table>` : '<div class="empty">None yet.</div>'}</div>`;
  $('feeForm').onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const address = $('feeAddress').value.trim();
      if (address === w.feeAddress) return;
      if (!confirm(`Send your €0.10 per ride to ${address} from now on? Check it's really your address.`)) return;
      await api('POST', '/fee-address', { address });
      go('escrow');
    })();
  };
  $('net').onclick = act(async () => {
    const next = w.network === 'testnet' ? 'mainnet' : 'testnet';
    const confirm = prompt(`Only when nothing is in escrow. ${next === 'mainnet' ? 'This starts real money. ' : ''}Type SWITCH TO ${next.toUpperCase()}`);
    if (confirm === null) return;
    await api('POST', '/network', { network: next, confirm });
    go('escrow');
  });
  bindEscrowButtons(view, () => go('escrow'));
  view.querySelectorAll('a[data-ride]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); rideDialog(a.dataset.ride); }; });
}

// ---------- short links on the website ----------

const PHONE_NAMES = { iphone: 'iPhone', android: 'Android', other: 'Computer or other' };
const countryName = (code) => {
  if (!code) return 'Unknown';
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code; } catch { return code; }
};
const dayLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

// Clicks per day for the last 30 days: one series, bars on a shared baseline, a tooltip on each day.
function clickChart(days) {
  const top = Math.max(1, ...days.map((d) => d.n));
  const nice = top <= 4 ? top : Math.ceil(top / 5) * 5;
  return `<div class="chart" role="img" aria-label="Clicks per day, last 30 days">
    <div class="chart-scale"><span>${nice}</span><span>0</span></div>
    <div class="chart-bars">${days.map((d) => `<div class="chart-day" data-tip="${esc(dayLabel(d.day))}: ${d.n} click${d.n === 1 ? '' : 's'}"><i style="height:${d.n ? Math.max(3, (d.n / nice) * 100) : 0}%"></i></div>`).join('')}</div>
    <div class="chart-axis"><span>${esc(dayLabel(days[0].day))}</span><span>Today</span></div>
    <div class="chart-tip" hidden></div>
  </div>`;
}
function wireChart(root) {
  root.querySelectorAll('.chart').forEach((chart) => {
    const tip = chart.querySelector('.chart-tip');
    chart.querySelectorAll('.chart-day').forEach((day) => {
      day.onmouseenter = () => {
        tip.textContent = day.dataset.tip;
        tip.hidden = false;
        const box = chart.getBoundingClientRect(), bar = day.getBoundingClientRect();
        tip.style.left = `${Math.min(Math.max(bar.left - box.left + bar.width / 2, 70), box.width - 70)}px`;
      };
      day.onmouseleave = () => { tip.hidden = true; };
    });
  });
}

function linkDialog(link, base) {
  openDialog(`<h2>${link ? 'Change the link' : 'New link'}</h2>
    <form id="linkForm" class="link-form">
      <label>Name<div class="slug-field"><span class="muted">${esc(base.replace(/^https?:\/\//, ''))}/</span><input id="linkSlug" class="mono" value="${esc(link?.slug ?? '')}" placeholder="app" autocomplete="off" spellcheck="false" required></div></label>
      <label>Goes to<input id="linkTarget" class="mono" value="${esc(link?.target ?? '')}" placeholder="https://" autocomplete="off" spellcheck="false" required></label>
      <label>Android phones go to<input id="linkAndroid" class="mono" value="${esc(link?.androidTarget ?? '')}" placeholder="Empty: the same as above" autocomplete="off" spellcheck="false"></label>
      ${link ? '<p class="muted">Changing where it goes works at once, also for links people already have. A new name keeps the clicks, but the old address stops working.</p>' : ''}
      <div class="row"><button class="primary">${link ? 'Save' : 'Make the link'}</button></div>
      <p id="linkError" class="error"></p>
    </form>`);
  $('linkForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/links', { was: link?.slug, slug: $('linkSlug').value, target: $('linkTarget').value, androidTarget: $('linkAndroid').value });
      $('dialog').close();
      go('links');
    } catch (err) { $('linkError').textContent = err.message; }
  };
}

async function linksView() {
  const { links, base } = await api('GET', '/links');
  const view = $('view');
  view.innerHTML = `<div class="toolbar"><button class="primary" id="newLink">New link</button><span class="muted">Clicks from the same phone within a minute count once. Chat apps fetching a preview, and bots, are counted apart and not in the clicks.</span></div>
    ${links.length ? '' : '<div class="panel"><div class="empty">No links yet.</div></div>'}
    ${links.map((l, i) => {
      const short = `${base}/${l.slug}`;
      const phones = Object.entries(PHONE_NAMES).map(([k, name]) => `<li><span>${name}</span><b>${l.phones[k]}</b></li>`).join('');
      const countries = l.countries.slice(0, 6).map((c) => `<li><span>${esc(countryName(c.country))}</span><b>${c.n}</b></li>`).join('');
      return `<div class="panel link-card">
        <div class="link-head">
          <div><a class="link-short" target="_blank" rel="noopener" href="${esc(short)}">${esc(short.replace(/^https?:\/\//, ''))}</a>
            <div class="muted">${l.androidTarget ? 'iPhone and computers go' : 'goes'} to <a class="mono" target="_blank" rel="noopener" href="${esc(l.target)}">${esc(l.target)}</a></div>
            ${l.androidTarget ? `<div class="muted">Android goes to <a class="mono" target="_blank" rel="noopener" href="${esc(l.androidTarget)}">${esc(l.androidTarget)}</a></div>` : ''}
            <div class="muted">Made ${when(l.createdAt)}${l.updatedAt > l.createdAt + 1000 ? `, changed ${when(l.updatedAt)}` : ''}</div></div>
          <div class="row"><button data-copy="${esc(short)}">Copy</button><button data-edit="${i}">Change</button><button class="danger" data-remove="${esc(l.slug)}">Delete</button></div>
        </div>
        <div class="link-stats">
          <div class="stat"><b>${l.total}</b><span>clicks in all</span></div>
          <div class="stat"><b>${l.today}</b><span>today</span></div>
          <div class="stat"><b>${l.week}</b><span>last 7 days</span></div>
          <div class="stat"><b>${l.month}</b><span>last 30 days</span></div>
          <div class="stat"><b>${ago(l.lastClickAt)}</b><span>last click</span></div>
        </div>
        <h3>Clicks per day</h3>
        ${clickChart(l.days)}
        <div class="link-split">
          <div><h3>On what</h3><ul class="split">${phones}</ul></div>
          <div><h3>From where</h3>${countries ? `<ul class="split">${countries}</ul>` : '<p class="muted">No clicks yet.</p>'}</div>
          <div><h3>Not counted</h3><ul class="split"><li><span>Previews and bots</span><b>${l.previews}</b></li></ul></div>
        </div>
      </div>`;
    }).join('')}`;
  $('newLink').onclick = () => linkDialog(null, base);
  view.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => linkDialog(links[Number(b.dataset.edit)], base); });
  view.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = act(async () => { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); }); });
  view.querySelectorAll('[data-remove]').forEach((b) => { b.onclick = act(async () => {
    if (!confirm(`Delete /${b.dataset.remove}? The address stops working and its clicks are gone.`)) return;
    await api('POST', `/links/${encodeURIComponent(b.dataset.remove)}/remove`, {});
    go('links');
  }); });
  wireChart(view);
}

async function logView() {
  const { log } = await api('GET', '/log');
  $('view').innerHTML = `<div class="panel">${log.length ? `<table><tr><th>When</th><th>What</th><th>About</th><th></th></tr>${log.map((l) => `<tr><td>${when(l.at)}</td><td>${esc(l.action)}</td><td class="mono">${esc(l.target ?? '')}</td><td class="wrap muted">${esc(l.detail ?? '')}</td></tr>`).join('')}</table>` : '<div class="empty">Nothing yet.</div>'}</div>`;
}

const VIEWS = { online: () => usersView('online'), users: () => usersView('all'), checks: () => checksView(), reports: () => reportsView(), support: () => supportView(), walletChanges: () => walletChangesView(), appeals: () => appealsView(), disputes: () => disputesView(), rides: () => ridesView(), escrow: escrowView, links: linksView, log: logView };

(async () => {
  try { await api('GET', '/overview'); showApp(); go('online'); } catch { if ($('change').hidden) showLogin(); }
  setInterval(() => { if (!$('app').hidden && !$('dialog').open && tab === 'online') go('online').catch(() => {}); }, 30_000);
})();
