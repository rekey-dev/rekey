/**
 * Single-page web UI for the QR SaaS — vanilla HTML+JS, no build step.
 * Served at GET / by the Express server. Talks to the same /auth + /api routes
 * a curl user would, attaching the ReliPay access token (kept in localStorage)
 * as a Bearer header. Purely a convenience face on the API.
 *
 * It exercises ReliPay end-to-end across four tabs:
 *   QR Codes — dynamic QR CRUD + per-QR scan analytics (Pro feature-gated).
 *   Billing  — entitlements, usage-this-month, plan catalog + upgrade checkout,
 *              prepaid credit balance/ledger + buy-credits checkout.
 *   Team     — ReliPay organizations: create, list, switch (active-org token),
 *              members, invitations. Org workspaces pool billing + usage.
 *   Account  — active sessions (revoke / sign-out-everywhere) + magic-link.
 *
 * NB: this string is a template literal — it must contain NO backticks and NO
 * ${...}; the embedded browser JS uses '+' concatenation throughout.
 */

export const INDEX_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>QR SaaS — built on ReliPay</title>
<style>
  :root { --bg:#0b0c10; --card:#15171e; --bd:#262a35; --fg:#e6e8ee; --mut:#9aa1b1; --pri:#5b8cff; --pri2:#3f6fe0; --ok:#37d39b; --err:#ff6b6b; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  .wrap { max-width:880px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:20px; margin:0 0 2px; } .sub { color:var(--mut); margin:0 0 20px; font-size:13px; }
  h3 { font-size:14px; margin:0 0 10px; }
  .card { background:var(--card); border:1px solid var(--bd); border-radius:12px; padding:16px; margin-bottom:16px; }
  label { display:block; font-size:12px; color:var(--mut); margin:8px 0 4px; }
  input, select { width:100%; padding:9px 11px; border:1px solid var(--bd); border-radius:8px; background:#0e1016; color:var(--fg); font:inherit; }
  button { padding:9px 14px; border:0; border-radius:8px; background:var(--pri); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:hover { background:var(--pri2); } button.ghost { background:transparent; border:1px solid var(--bd); color:var(--fg); font-weight:500; }
  button.danger { background:transparent; border:1px solid var(--bd); color:var(--err); font-weight:500; }
  button:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .qr { display:flex; gap:14px; align-items:flex-start; border-top:1px solid var(--bd); padding:14px 0; }
  .qr img { width:96px; height:96px; border-radius:8px; background:#fff; }
  .qr .meta { flex:1; min-width:0; } .qr .meta b { font-size:14px; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  a { color:var(--pri); text-decoration:none; } a:hover { text-decoration:underline; }
  .pill { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; background:#0e1016; border:1px solid var(--bd); color:var(--mut); }
  .pill.pro { color:var(--ok); border-color:#1f4a3c; }
  .msg { padding:9px 12px; border-radius:8px; font-size:13px; margin-bottom:12px; display:none; }
  .msg.show { display:block; } .msg.err { background:#2a1416; color:var(--err); border:1px solid #4a1f22; }
  .msg.ok { background:#0f2620; color:var(--ok); border:1px solid #1f4a3c; }
  .hide { display:none !important; } .right { margin-left:auto; }
  small.mut { color:var(--mut); }
  .tabs { display:flex; gap:4px; margin-bottom:16px; border-bottom:1px solid var(--bd); }
  .tab { background:transparent; border:0; border-bottom:2px solid transparent; border-radius:0; color:var(--mut); font-weight:600; padding:8px 12px; }
  .tab:hover { background:transparent; color:var(--fg); }
  .tab.active { color:var(--fg); border-bottom-color:var(--pri); }
  .plans { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; }
  .plan { border:1px solid var(--bd); border-radius:10px; padding:12px; background:#0e1016; }
  .plan .price { font-size:18px; font-weight:700; margin:4px 0 8px; }
  .lrow { display:flex; gap:8px; align-items:center; border-top:1px solid var(--bd); padding:8px 0; font-size:13px; }
  .lrow:first-child { border-top:0; }
  .kv { display:flex; gap:18px; flex-wrap:wrap; margin:4px 0 0; }
  .kv div b { display:block; font-size:18px; } .kv div span { font-size:12px; color:var(--mut); }
  @media (max-width:620px){ .plans{ grid-template-columns:1fr; } .grid2{ grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>QR SaaS <span class="pill">built on ReliPay</span></h1>
  <p class="sub">Dynamic QR codes — auth, billing, credits, usage caps &amp; teams all via ReliPay. This page is a thin face on the JSON API.</p>

  <div id="msg" class="msg"></div>

  <!-- AUTH -->
  <div id="authCard" class="card">
    <div class="row"><b>Sign in</b> <small class="mut">— or sign up; it's open (demo).</small></div>
    <div class="grid2">
      <div><label>Email</label><input id="email" type="email" placeholder="you@demo.dev" autocomplete="username" /></div>
      <div><label>Password</label><input id="password" type="password" placeholder="min 8 chars" autocomplete="current-password" /></div>
    </div>
    <div class="row" style="margin-top:12px">
      <button onclick="auth('sign-in')">Sign in</button>
      <button class="ghost" onclick="auth('sign-up')">Sign up</button>
      <button class="ghost right" onclick="magicFromLogin()">Email me a magic link</button>
    </div>
  </div>

  <!-- APP -->
  <div id="appCard" class="hide">
    <div class="card">
      <div class="row">
        <span>Signed in as <b id="who"></b></span>
        <span id="workspace" class="pill">Personal</span>
        <span id="plan" class="pill right"></span>
        <button id="upgradeBtn" onclick="checkout('pro_monthly')">Upgrade to Pro</button>
        <button class="ghost" onclick="signOut()">Sign out</button>
      </div>
    </div>

    <div id="orgGate" class="card hide" style="border-color:#4a3a1f;background:#241d10">
      <div class="row"><b>Team required</b> <small class="mut">— this app bills per team</small></div>
      <p class="sub" style="margin:8px 0 4px">Create or switch to a team to create QR codes and manage billing. This app is configured so billing belongs to a team, not an individual.</p>
      <div class="row" style="margin-top:8px"><button onclick="selectTab('team')">Go to Team</button></div>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="qr" onclick="selectTab('qr')">QR Codes</button>
      <button class="tab" data-tab="billing" onclick="selectTab('billing')">Billing</button>
      <button class="tab" data-tab="team" onclick="selectTab('team')">Team</button>
      <button class="tab" data-tab="account" onclick="selectTab('account')">Account</button>
    </div>

    <!-- TAB: QR -->
    <div id="tab-qr" class="tabpanel">
      <div class="card">
        <div class="row"><b>New dynamic QR</b></div>
        <div class="grid2">
          <div><label>Destination URL</label><input id="dest" placeholder="https://anthropic.com" /></div>
          <div><label>Title (optional)</label><input id="title" placeholder="Campaign A" /></div>
        </div>
        <div class="row" style="margin-top:12px"><button onclick="createQr()">Create QR</button>
          <small class="mut">Edit the destination later — the QR + short link stay the same.</small></div>
      </div>
      <div class="card">
        <div class="row"><b>QR codes</b> <small class="mut" id="qrScope"></small> <button class="ghost right" onclick="loadQrs()">Refresh</button></div>
        <div id="qrs"></div>
      </div>
    </div>

    <!-- TAB: BILLING -->
    <div id="tab-billing" class="tabpanel hide">
      <div class="card">
        <h3>This workspace</h3>
        <div class="kv">
          <div><b id="entMax">—</b><span>max QR codes</span></div>
          <div><b id="usageScans">—</b><span>scans this month</span></div>
          <div><b id="entAnalytics">—</b><span>analytics</span></div>
          <div><b id="entCredits">0</b><span>credits</span></div>
        </div>
      </div>
      <div class="card">
        <h3>Plans</h3>
        <div id="plans" class="plans"></div>
      </div>
      <div class="card">
        <h3>Prepaid credits <span class="pill">bulk QR pack</span></h3>
        <div class="row"><span>Balance: <b id="credBal">0</b> credits</span>
          <button class="right" onclick="buyCredits()">Buy 500 credits</button></div>
        <div id="ledger" style="margin-top:8px"></div>
      </div>
    </div>

    <!-- TAB: TEAM -->
    <div id="tab-team" class="tabpanel hide">
      <div class="card">
        <div class="row"><b>Workspace</b> <span id="wsName" class="pill right"></span></div>
        <p id="wsHint" class="sub" style="margin:8px 0 0"></p>
        <div class="row" style="margin-top:10px"><button id="toPersonalBtn" class="ghost hide" onclick="switchWorkspace('')">Leave team — back to Personal</button></div>
      </div>
      <div class="card">
        <div class="row"><b>My teams</b> <button class="ghost right" onclick="loadTeam()">Refresh</button></div>
        <div id="orgs"></div>
        <div class="row" style="margin-top:12px">
          <input id="orgName" placeholder="New team name" style="flex:1" />
          <button onclick="createOrg()">Create team</button>
        </div>
      </div>
      <div id="memberCard" class="card hide">
        <div class="row"><b>Members</b></div>
        <div id="members"></div>
        <div class="grid2" style="margin-top:12px">
          <div><label>Invite email</label><input id="invEmail" type="email" placeholder="teammate@demo.dev" /></div>
          <div><label>Role</label>
            <select id="invRole"><option value="MEMBER">Member</option><option value="ADMIN">Admin</option><option value="OWNER">Owner</option></select>
          </div>
        </div>
        <div class="row" style="margin-top:10px"><button onclick="invite()">Send invite</button></div>
        <div id="inviteOut" class="hide" style="margin-top:10px"></div>
      </div>
    </div>

    <!-- TAB: ACCOUNT -->
    <div id="tab-account" class="tabpanel hide">
      <div class="card">
        <div class="row"><b>Active sessions</b> <button class="ghost right" onclick="loadAccount()">Refresh</button></div>
        <div id="sessions"></div>
        <div class="row" style="margin-top:12px"><button class="danger" onclick="signOutEverywhere()">Sign out everywhere</button></div>
      </div>
      <div class="card">
        <h3>Magic link</h3>
        <p class="sub" style="margin:0 0 8px">Send a passwordless sign-in link to your email (ReliPay handles delivery).</p>
        <div class="row"><input id="magicEmail" type="email" placeholder="you@demo.dev" style="flex:1" />
          <button onclick="sendMagicLink()">Send link</button></div>
        <div id="magicOut" class="hide" style="margin-top:10px"></div>
      </div>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('qr_token') || '';
let ME = null;
let ORGS = [];
let ACTIVE_ORG = null;
let IS_PRO = false;
// Filled from /api/config. billingSubject 'org' => this app bills PER TEAM, so
// the user must be inside a team to create QRs or manage billing.
let CONFIG = { organizationsEnabled: true, billingSubject: 'user' };
function orgRequired() { return CONFIG.billingSubject === 'org'; }

function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function flash(text, kind) { const m = $('msg'); m.textContent = text; m.className = 'msg show ' + (kind||'ok'); setTimeout(()=>{ if(m.textContent===text) m.className='msg'; }, 5000); }

async function api(method, path, body, raw) {
  const opt = { method, headers: {} };
  if (token) opt.headers['authorization'] = 'Bearer ' + token;
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(path, opt);
  if (raw) return res;
  const json = await res.json().catch(()=>({}));
  if (!res.ok) { const e = json.error || {}; throw new Error((e.code? e.code+': ':'') + (e.message || ('HTTP '+res.status))); }
  return json;
}

// ---------- Auth ----------
async function auth(kind) {
  try {
    const email = $('email').value.trim(), password = $('password').value;
    if (!email || !password) return flash('Email + password required.', 'err');
    const r = await api('POST', '/auth/' + kind, { email, password });
    if (r.mfaRequired) return flash('MFA enrolled — not supported in this demo UI.', 'err');
    token = r.accessToken; localStorage.setItem('qr_token', token);
    flash(kind === 'sign-up' ? 'Account created.' : 'Signed in.', 'ok');
    await enter();
  } catch (e) { flash(e.message, 'err'); }
}

async function magicFromLogin() {
  try {
    const email = $('email').value.trim();
    if (!email) return flash('Enter your email first.', 'err');
    const r = await api('POST', '/auth/magic-link', { email });
    if (r.magicLinkToken) { token=''; await consumeMagic(r.magicLinkToken); }
    else flash('Magic link sent to ' + email + '. Check your inbox.', 'ok');
  } catch (e) { flash(e.message, 'err'); }
}

async function consumeMagic(tok) {
  try {
    const r = await api('POST', '/auth/magic-link/verify', { token: tok });
    if (r.mfaRequired) return flash('MFA required — not supported in this demo UI.', 'err');
    token = r.accessToken; localStorage.setItem('qr_token', token);
    flash('Signed in via magic link.', 'ok');
    await enter();
  } catch (e) { flash(e.message, 'err'); }
}

function signOut() { api('POST','/auth/sign-out',{ refreshToken:'' }).catch(()=>{}); token=''; localStorage.removeItem('qr_token'); ME=null; ACTIVE_ORG=null; ORGS=[]; $('appCard').classList.add('hide'); $('authCard').classList.remove('hide'); }

async function loadConfig() {
  try { CONFIG = await api('GET', '/api/config'); }
  catch { CONFIG = { organizationsEnabled: true, billingSubject: 'user' }; }
}

// In org-billing mode you can't do anything until you're inside a team; surface
// a persistent banner and steer the user to the Team tab.
function updateGate() {
  const need = orgRequired() && !ACTIVE_ORG;
  $('orgGate').classList.toggle('hide', !need);
  if (need) $('upgradeBtn').style.display = 'none';
}

async function enter() {
  try {
    ME = await api('GET', '/auth/me');
    $('who').textContent = ME.email;
    $('magicEmail').value = ME.email;
    $('authCard').classList.add('hide'); $('appCard').classList.remove('hide');
    ACTIVE_ORG = ME.activeOrganizationId || null;
    await loadConfig();
    // No teams on this app → drop the Team tab entirely (single-user app).
    document.querySelector('[data-tab=team]').classList.toggle('hide', !CONFIG.organizationsEnabled);
    if (CONFIG.organizationsEnabled) {
      try { const r = await api('GET', '/api/orgs'); ORGS = r.orgs || []; ACTIVE_ORG = r.activeOrganizationId || null; } catch {}
    }
    renderWorkspace();
    updateGate();
    await loadPlan();
    // Org-billing app with no active team → land on Team so they can create one.
    selectTab(orgRequired() && !ACTIVE_ORG ? 'team' : 'qr');
  } catch { signOut(); }
}

function renderWorkspace() {
  const o = ORGS.find((x)=>x.id===ACTIVE_ORG);
  const noTeamLabel = orgRequired() ? 'No team selected' : 'Personal';
  const label = ACTIVE_ORG ? ('Team: ' + (o ? o.name : ACTIVE_ORG)) : noTeamLabel;
  $('workspace').textContent = label;
  $('wsName').textContent = label;
  $('qrScope').textContent = ACTIVE_ORG ? '(team workspace)' : (orgRequired() ? '(no team — required)' : '(personal)');
  // "Switch to Personal" only applies when teams are OPTIONAL — in org-billing
  // mode there's no valid personal workspace to return to.
  $('toPersonalBtn').classList.toggle('hide', !ACTIVE_ORG || orgRequired());
  $('wsHint').textContent = ACTIVE_ORG
    ? 'Acting as this team — billing, scan quota & QR codes draw from the shared pool. Anything you create here belongs to the team.'
    : (orgRequired()
        ? 'This app bills per team. Create or switch to a team below — QR codes and billing require an active team.'
        : 'Your personal workspace. Create or switch to a team below to pool billing, scan quota & QR codes across members.');
}

// ---------- Tabs ----------
function selectTab(name) {
  const tabs = document.querySelectorAll('.tab');
  for (const t of tabs) t.classList.toggle('active', t.getAttribute('data-tab')===name);
  const panels = ['qr','billing','team','account'];
  for (const p of panels) $('tab-'+p).classList.toggle('hide', p!==name);
  if (name==='qr') loadQrs();
  else if (name==='billing') loadBilling();
  else if (name==='team') loadTeam();
  else if (name==='account') loadAccount();
}

// ---------- Plan badge ----------
async function loadPlan() {
  try { const e = await api('GET', '/api/billing/entitlements');
    const f = e.features || {}; IS_PRO = f.analytics === true;
    const max = f.max_qr_codes != null ? f.max_qr_codes : '—';
    $('plan').textContent = max + ' QRs · ' + (e.creditBalance != null ? e.creditBalance : 0) + ' credits' + (IS_PRO?' · Pro':'');
    $('plan').className = 'pill right' + (IS_PRO ? ' pro' : '');
    $('upgradeBtn').style.display = IS_PRO ? 'none' : '';
  } catch { $('plan').textContent = 'no active plan'; $('plan').className='pill right'; $('upgradeBtn').style.display=''; }
}

// ---------- Billing tab ----------
async function checkout(slug) {
  try {
    const r = await api('POST', '/api/billing/checkout', { planSlug: slug });
    if (r.url) window.location.href = r.url; else flash('No checkout URL returned.', 'err');
  } catch (e) { flash(e.message, 'err'); }
}
async function buyCredits() {
  try {
    const r = await api('POST', '/api/credits/buy');
    if (r.url) window.location.href = r.url; else flash('No checkout URL returned.', 'err');
  } catch (e) { flash(e.message, 'err'); }
}

function priceLabel(p) {
  if (p.amount === 0) return 'Free';
  const amt = '$' + (p.amount/100);
  if (p.kind === 'SUBSCRIPTION' && p.interval) return amt + '/' + String(p.interval).toLowerCase();
  if (p.kind === 'CREDIT' && p.creditsAmount) return amt;
  return amt;
}

async function loadBilling() {
  if (orgRequired() && !ACTIVE_ORG) {
    $('entMax').textContent='—'; $('entAnalytics').textContent='—'; $('entCredits').textContent='0'; $('usageScans').textContent='—';
    $('plans').innerHTML = '<p class="sub">This app bills per team. Create or switch to a team (Team tab) to see plans + manage billing.</p>';
    $('credBal').textContent='0'; $('ledger').innerHTML='';
    return;
  }
  try { const e = await api('GET','/api/billing/entitlements'); const f = e.features || {};
    $('entMax').textContent = f.max_qr_codes != null ? f.max_qr_codes : '—';
    $('entAnalytics').textContent = f.analytics === true ? 'yes' : 'no';
    $('entCredits').textContent = e.creditBalance != null ? e.creditBalance : 0;
  } catch (e) { /* leave dashes */ }
  try { const u = await api('GET','/api/usage'); $('usageScans').textContent = u.total; } catch { $('usageScans').textContent='—'; }

  try {
    const { plans } = await api('GET','/api/billing/plans');
    const box = $('plans'); box.innerHTML='';
    for (const p of plans) {
      const isCurrent = (p.slug==='pro_monthly' && IS_PRO) || (p.slug==='free' && !IS_PRO);
      let btn;
      if (isCurrent) btn = '<span class="pill pro">Current</span>';
      else if (p.kind==='CREDIT') btn = '<button data-buy="1">Buy</button>';
      else if (p.amount===0) btn = '<span class="pill">—</span>';
      else btn = '<button data-plan="'+esc(p.slug)+'">Choose</button>';
      const sub = (p.kind==='CREDIT' && p.creditsAmount) ? ('<small class="mut">'+p.creditsAmount+' credits</small>') : '<small class="mut">'+esc(p.kind||'')+'</small>';
      const el = document.createElement('div'); el.className='plan';
      el.innerHTML = '<b>'+esc(p.name)+'</b><div class="price">'+priceLabel(p)+'</div>'+sub+'<div class="row" style="margin-top:10px">'+btn+'</div>';
      box.appendChild(el);
    }
    box.querySelectorAll('[data-plan]').forEach((b)=> b.onclick=()=>checkout(b.getAttribute('data-plan')));
    box.querySelectorAll('[data-buy]').forEach((b)=> b.onclick=()=>buyCredits());
  } catch (e) { flash(e.message, 'err'); }

  try {
    const c = await api('GET','/api/credits');
    $('credBal').textContent = c.balance;
    const box = $('ledger');
    if (!c.ledger || !c.ledger.length) { box.innerHTML = '<p class="sub" style="margin:8px 0 0">No credit activity yet.</p>'; }
    else { box.innerHTML=''; for (const e of c.ledger) {
      const el = document.createElement('div'); el.className='lrow';
      el.innerHTML = '<span class="mono">'+(e.delta>0?'+':'')+e.delta+'</span> <span class="pill">'+esc(e.reason)+'</span> <span class="mut right">bal '+e.balanceAfter+'</span>';
      box.appendChild(el);
    } }
  } catch (e) { $('credBal').textContent='0'; }
}

// ---------- Team tab ----------
async function loadTeam() {
  try {
    const r = await api('GET','/api/orgs');
    ORGS = r.orgs || []; ACTIVE_ORG = r.activeOrganizationId || null;
    renderWorkspace(); updateGate();
    const box = $('orgs');
    if (!ORGS.length) { box.innerHTML = '<p class="sub" style="margin:8px 0 0">No teams yet — create one to pool QRs + billing.</p>'; }
    else { box.innerHTML='';
      for (const o of ORGS) {
        const active = o.id===ACTIVE_ORG;
        const el = document.createElement('div'); el.className='lrow';
        el.innerHTML = '<b>'+esc(o.name)+'</b> <span class="pill">'+esc(o.role)+'</span> '
          + (active ? '<span class="pill pro right">active</span>' : '<button class="ghost right" data-sw="'+esc(o.id)+'">Switch</button>');
        box.appendChild(el);
      }
      box.querySelectorAll('[data-sw]').forEach((b)=> b.onclick=()=>switchWorkspace(b.getAttribute('data-sw')));
    }
    if (ACTIVE_ORG) { $('memberCard').classList.remove('hide'); loadMembers(); }
    else { $('memberCard').classList.add('hide'); }
  } catch (e) { flash(e.message, 'err'); }
}

async function createOrg() {
  try {
    const name = $('orgName').value.trim(); if (!name) return flash('Team name required.', 'err');
    const r = await api('POST','/api/orgs', { name });
    $('orgName').value='';
    // Org-billing app → immediately act as the new team so billing + QRs work.
    if (orgRequired() && r.organization && r.organization.id) { await switchWorkspace(r.organization.id); }
    else { flash('Team created.', 'ok'); loadTeam(); }
  } catch (e) { flash(e.message, 'err'); }
}

async function switchWorkspace(orgId) {
  try {
    const r = await api('POST', orgId ? ('/api/orgs/'+orgId+'/switch') : '/api/orgs/clear-active');
    token = r.accessToken; localStorage.setItem('qr_token', token);
    ACTIVE_ORG = orgId || null;
    flash(orgId ? 'Switched to team workspace.' : 'Switched to personal.', 'ok');
    await loadPlan(); renderWorkspace(); updateGate(); loadTeam();
  } catch (e) { flash(e.message, 'err'); }
}

async function loadMembers() {
  try {
    const { members } = await api('GET','/api/orgs/'+ACTIVE_ORG+'/members');
    const box = $('members'); box.innerHTML='';
    for (const m of members) {
      const el = document.createElement('div'); el.className='lrow';
      el.innerHTML = '<span>'+esc(m.email)+'</span> <span class="pill right">'+esc(m.role)+'</span>';
      box.appendChild(el);
    }
  } catch (e) { flash(e.message, 'err'); }
}

async function invite() {
  try {
    const email = $('invEmail').value.trim(); if (!email) return flash('Invite email required.', 'err');
    const role = $('invRole').value;
    const r = await api('POST','/api/orgs/'+ACTIVE_ORG+'/invite', { email, role });
    $('invEmail').value='';
    const out = $('inviteOut'); out.classList.remove('hide');
    out.innerHTML = '<small class="mut">Invite token (a real app emails this):</small><br/><span class="mono">'+esc(r.token)+'</span>';
    flash('Invitation created.', 'ok');
  } catch (e) { flash(e.message, 'err'); }
}

// ---------- Account tab ----------
async function loadAccount() {
  try {
    const { sessions } = await api('GET','/api/account/sessions');
    const box = $('sessions'); box.innerHTML='';
    for (const s of sessions) {
      const ua = s.userAgent ? s.userAgent.slice(0,48) : 'unknown device';
      const when = new Date(s.createdAt).toLocaleString();
      const el = document.createElement('div'); el.className='lrow';
      el.innerHTML = '<span>'+esc(ua)+'</span> <small class="mut">'+esc(s.ip||'')+' · '+esc(when)+'</small> '
        + '<button class="danger right" data-rev="'+esc(s.id)+'">Revoke</button>';
      box.appendChild(el);
    }
    box.querySelectorAll('[data-rev]').forEach((b)=> b.onclick=()=>revokeSession(b.getAttribute('data-rev')));
  } catch (e) { flash(e.message, 'err'); }
}

async function revokeSession(id) {
  try { await api('DELETE','/api/account/sessions/'+id); flash('Session revoked.', 'ok'); loadAccount(); }
  catch (e) { flash(e.message, 'err'); }
}

async function signOutEverywhere() {
  try { const r = await api('POST','/api/account/sign-out-everywhere');
    flash('Revoked ' + (r.revokedCount!=null?r.revokedCount:'all') + ' sessions.', 'ok');
    signOut();
  } catch (e) { flash(e.message, 'err'); }
}

async function sendMagicLink() {
  try {
    const email = ($('magicEmail').value || (ME&&ME.email) || '').trim();
    if (!email) return flash('Email required.', 'err');
    const r = await api('POST','/auth/magic-link', { email });
    const out = $('magicOut'); out.classList.remove('hide');
    if (r.magicLinkToken) out.innerHTML = '<small class="mut">No email transport — link:</small><br/><a class="mono" href="/?magic=1&token='+encodeURIComponent(r.magicLinkToken)+'">sign-in link</a>';
    else out.innerHTML = '<small class="mut">Sent to '+esc(email)+'. Check your inbox.</small>';
    flash('Magic link sent.', 'ok');
  } catch (e) { flash(e.message, 'err'); }
}

// ---------- QR tab ----------
async function createQr() {
  if (orgRequired() && !ACTIVE_ORG) return flash('Create or switch to a team first — this app bills per team.', 'err');
  try {
    const destination = $('dest').value.trim(); if (!destination) return flash('Destination required.', 'err');
    const title = $('title').value.trim();
    await api('POST', '/api/qrs', { destination, title: title || undefined });
    $('dest').value=''; $('title').value=''; flash('QR created.', 'ok'); loadQrs(); loadPlan();
  } catch (e) { flash(e.message, 'err'); }
}

async function pngFor(id, img) {
  try { const res = await api('GET', '/api/qrs/'+id+'/qr.png', undefined, true); if(!res.ok) return; const b = await res.blob(); img.src = URL.createObjectURL(b); } catch {}
}

async function qrAnalytics(id, where) {
  try {
    const a = await api('GET', '/api/qrs/'+id+'/analytics');
    where.textContent = a.scans + ' scans (30d)';
  } catch (e) { where.textContent = e.message; }
}

async function loadQrs() {
  try {
    const { qrs } = await api('GET', '/api/qrs');
    const box = $('qrs'); box.innerHTML = qrs.length ? '' : '<p class="sub" style="margin:12px 0 0">No QR codes yet. Create one above.</p>';
    for (const q of qrs) {
      const el = document.createElement('div'); el.className = 'qr';
      el.innerHTML =
        '<img alt="QR" />' +
        '<div class="meta">' +
          '<b>'+ esc(q.title || 'Untitled') +'</b><br/>' +
          '<a href="'+ esc(q.shortUrl) +'" target="_blank" rel="noopener" class="mono">'+ esc(q.shortUrl) +'</a> ' +
          '<small class="mut">&rarr; scan opens this</small>' +
          '<div class="row" style="margin-top:8px">' +
            '<input class="mono" value="'+ esc(q.destination) +'" />' +
            '<button class="ghost" data-act="save">Save</button>' +
            '<button class="ghost" data-act="stats">Analytics</button>' +
            '<button class="danger" data-act="del">Delete</button>' +
          '</div>' +
          '<small class="mut" data-stats></small>' +
        '</div>';
      const img = el.querySelector('img'); pngFor(q.id, img);
      const input = el.querySelector('input');
      el.querySelector('[data-act=save]').onclick = async () => {
        try { await api('PATCH', '/api/qrs/'+q.id, { destination: input.value.trim() }); flash('Destination updated.', 'ok'); }
        catch(e){ flash(e.message,'err'); }
      };
      el.querySelector('[data-act=stats]').onclick = () => qrAnalytics(q.id, el.querySelector('[data-stats]'));
      el.querySelector('[data-act=del]').onclick = async () => {
        try { await api('DELETE', '/api/qrs/'+q.id, undefined, true); flash('Deleted.', 'ok'); loadQrs(); loadPlan(); }
        catch(e){ flash(e.message,'err'); }
      };
      box.appendChild(el);
    }
  } catch (e) { flash(e.message, 'err'); }
}

// ---------- Return-from-checkout + magic-link landing ----------
const _sp = new URLSearchParams(location.search);
if (_sp.get('magic') && _sp.get('token')) {
  history.replaceState({}, '', '/');
  consumeMagic(_sp.get('token'));
} else if (_sp.get('upgraded')) {
  flash('Payment approved — provisioning your Pro plan (webhook)…', 'ok');
  history.replaceState({}, '', '/');
  let n = 0; const t = setInterval(() => { loadPlan(); if (++n >= 6) clearInterval(t); }, 2500);
  if (token) enter();
} else if (_sp.get('bought')) {
  flash('Payment approved — crediting your account (webhook)…', 'ok');
  history.replaceState({}, '', '/');
  let n = 0; const t = setInterval(() => { loadPlan(); if (++n >= 6) clearInterval(t); }, 2500);
  if (token) enter();
} else if (_sp.get('upgrade') === 'cancel' || _sp.get('buy') === 'cancel') {
  flash('Checkout cancelled.', 'err'); history.replaceState({}, '', '/');
  if (token) enter();
} else if (token) {
  enter();
}
</script>
</body>
</html>`;
