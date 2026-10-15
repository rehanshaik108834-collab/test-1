/**
 * LANNENT — StoreContext
 * Ported from front-end/js/store.js, and shared with the app through React Context.
 *
 *   const Store = useStore();
 *   Store.getTasks();  Store.createTask({...});   // same API as before
 *
 * The Store keeps a local cache for synchronous reads and sends changes to
 * the API. The cache is (re)filled by Store.init(), which the router calls on
 * every navigation — the React equivalent of the full page load that used to
 * re-run store.js on every page (see App.jsx → PageLoader).
 *
 * There is one Store for the whole app (it owns the cache), so <StoreProvider>
 * hands that single instance to every component.
 */
import { createContext, useContext } from 'react';

/**
 * Where the API lives.
 *
 * During development Vite proxies /api to the NestJS server on port 3000
 * (see vite.config.js), so requests stay same-origin. Set VITE_API_URL to
 * point somewhere else, e.g. VITE_API_URL=http://localhost:3000/api.
 */
export const LANNENT_API = import.meta.env.VITE_API_URL || '/api';

const Store = (() => {
  const API = LANNENT_API;

  // Local cache — initialized from API on first load
  let _cache = {
    users: [], tasks: [], milestones: [], proposals: [],
    auditRequests: [], auditReports: [], disputes: [],
    transactions: [], expertApplications: [], notifications: [],
    messages: [],
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function _headers() {
    const h = { 'Content-Type': 'application/json' };
    try {
      const session = JSON.parse(localStorage.getItem('lannent_session') || '{}');
      if (session.role) h['role'] = session.role;
      if (session.userId) h['user-id'] = session.userId;
      // The bearer token is authoritative server-side and overrides the two
      // headers above; they stay for sessions created before tokens existed.
      const token = localStorage.getItem('lannent_token');
      if (token) h['Authorization'] = 'Bearer ' + token;
    } catch {}
    return h;
  }

  /**
   * Uploads one file and resolves to the reference a deliverable stores:
   * `{ id, name, size, mime, url }`.
   *
   * This cannot go through `_write`: that sends a JSON string over a
   * synchronous XHR, and `_headers()` forces `Content-Type: application/json`.
   * A multipart body needs the browser to set the content type itself, so the
   * boundary is right — hence async fetch and a headers object with the
   * content type deliberately left out.
   */
  async function uploadFile(file, meta = {}) {
    const form = new FormData();
    form.append('file', file);
    if (meta.taskId) form.append('taskId', meta.taskId);
    if (meta.milestoneId) form.append('milestoneId', meta.milestoneId);
    if (meta.purpose) form.append('purpose', meta.purpose);

    const h = _headers();
    delete h['Content-Type'];

    // An Expert Reviewer applicant has no account yet, so their résumé goes to
    // the public application route — the authenticated one would refuse a
    // request with no role header.
    const endpoint = meta.purpose === 'expert-application' ? `${API}/files/application` : `${API}/files`;

    const res = await fetch(endpoint, { method: 'POST', headers: h, body: form });
    let payload = null;
    try { payload = await res.json(); } catch {}
    if (!res.ok || !payload || payload.success === false) {
      throw new Error((payload && payload.message) || `Upload failed (${res.status})`);
    }
    return payload.data !== undefined ? payload.data : payload;
  }

  /** Absolute URL for a stored file, for links and download buttons. */
  function fileUrl(ref) {
    if (!ref) return '';
    const path = typeof ref === 'string' ? ref : ref.url;
    if (!path) return '';
    return /^https?:\/\//i.test(path) ? path : API.replace(/\/api$/, '') + path;
  }

  /** True when `href` points at a stored file, which is a route that needs credentials. */
  function _isFileHref(href) {
    if (!href) return false;
    const origin = API.replace(/\/api$/, '');
    return href.indexOf(API + '/files/') === 0 || href.indexOf(origin + '/api/files/') === 0 || href.indexOf('/api/files/') === 0;
  }

  /**
   * Downloads a stored file and hands it to the browser to save.
   *
   * `GET /api/files/:id` is behind RequireAuthMiddleware, and identity lives in
   * localStorage — it is attached per request by `_headers()`. A plain
   * `<a href download>` sends none of it, so the browser followed the link
   * anonymously, received a 401 JSON body, and saved *that* under the .pdf
   * name. The file looked downloaded and would not open. Fetching it here
   * carries the credentials and saves the actual bytes.
   */
  async function downloadFile(ref, filename) {
    const url = fileUrl(ref);
    if (!url) throw new Error('That file was never stored on the server.');
    const name = filename || (ref && typeof ref === 'object' && ref.name) || 'download';

    // A GET carries no body, and declaring a JSON content type on one is both
    // meaningless and enough to trigger a preflight.
    const h = _headers();
    delete h['Content-Type'];

    let res;
    try {
      res = await fetch(url, { headers: h });
    } catch (e) {
      throw new Error('The server could not be reached, so the file was not downloaded.');
    }

    if (!res.ok) {
      // Read the reason rather than saving it as the file.
      let message = '';
      try { message = ((await res.json()) || {}).message || ''; } catch (e) {}
      if (!message) {
        message = res.status === 401 || res.status === 403
          ? 'You are not signed in with an account that can open this file.'
          : `The file could not be downloaded (${res.status}).`;
      }
      throw new Error(message);
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    // A link with no `download` attribute still deserves the real filename,
    // which the server already states on the response.
    a.download = name !== 'download' ? name : (_filenameFromResponse(res) || name);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the save while it is still being read.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    return true;
  }

  /** The filename from `Content-Disposition`, preferring the RFC 5987 form. */
  function _filenameFromResponse(res) {
    try {
      const cd = res.headers.get('Content-Disposition') || '';
      const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      if (star) return decodeURIComponent(star[1].trim());
      const plain = /filename="?([^";]+)"?/i.exec(cd);
      if (plain) return plain[1].trim();
    } catch (e) {}
    return '';
  }

  /** A message the user can actually see, on a page whose CSS we cannot assume. */
  function _notifyDownloadError(message) {
    try {
      const el = document.createElement('div');
      el.setAttribute('role', 'alert');
      el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;' +
        'max-width:min(460px,92vw);background:#dc2626;color:#fff;padding:12px 16px;border-radius:12px;' +
        'font:500 13.5px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,0.25);';
      el.textContent = message;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 6000);
    } catch (e) {
      console.error('[Store] download failed:', message);
    }
  }

  /**
   * Makes every existing file link work without touching the pages that build
   * them. The links are rendered into innerHTML across several pages, so this
   * is delegated from the document rather than bound per element — including
   * the ones rendered after this runs.
   */
  function _interceptFileLinks() {
    if (typeof document === 'undefined' || document.__lannentFileLinks) return;
    document.__lannentFileLinks = true;
    // Capture phase: several pages call stopPropagation() inside cards, which
    // would keep a bubbling listener from ever seeing the click.
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      if (!_isFileHref(a.getAttribute('href'))) return;

      // Opening it in a new tab would be anonymous too, so every click is
      // handled here rather than only the plain ones.
      e.preventDefault();
      if (a.dataset.downloading === '1') return;
      a.dataset.downloading = '1';

      downloadFile(a.getAttribute('href'), a.getAttribute('download') || '')
        .catch(err => _notifyDownloadError(err && err.message ? err.message : 'The file could not be downloaded.'))
        .finally(() => { delete a.dataset.downloading; });
    }, true);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _interceptFileLinks);
    } else {
      _interceptFileLinks();
    }
  }

  // ─── Synchronous HTTP helpers (blocks until API responds) ─────────────────
  function _syncFetch(url) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      const hdrs = _headers();
      Object.keys(hdrs).forEach(k => xhr.setRequestHeader(k, hdrs[k]));
      xhr.send();
      if (xhr.status === 200) {
        const json = JSON.parse(xhr.responseText);
        return json.data !== undefined ? json.data : json;
      }
      _handleUnauthorized(xhr.status);
    } catch (e) {
      console.warn('Store sync GET error:', url, e);
    }
    return null;
  }

  /**
   * The server no longer accepts our token — it expired (12h), or a dev
   * server restarted with a fresh secret. Every request then failed with 401
   * and the app rendered as if it were offline, with the user still "signed
   * in" and no way to tell why. Sign out and go to the login page instead.
   */
  function _handleUnauthorized(status) {
    if (status !== 401) return;
    let hadToken = false;
    try { hadToken = !!localStorage.getItem('lannent_token'); } catch {}
    if (!hadToken) return;
    try { localStorage.removeItem('lannent_session'); localStorage.removeItem('lannent_token'); } catch {}
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  }

  /**
   * Every write goes through here. It returns the server's data, or throws an
   * Error carrying the server's own message.
   *
   * The old helpers returned null both when the server was unreachable and
   * when it *refused* the request, and most writes then fell back to editing
   * the local cache. So a hire the server rejected for insufficient funds,
   * or an approval it refused, showed on screen as done until the next
   * reload. A refused write now fails visibly, with the reason.
   */
  function _write(method, url, body) {
    const xhr = new XMLHttpRequest();
    try {
      xhr.open(method, url, false);
      const hdrs = _headers();
      Object.keys(hdrs).forEach(k => xhr.setRequestHeader(k, hdrs[k]));
      xhr.send(body === undefined ? null : JSON.stringify(body));
    } catch (e) {
      throw new Error('The server could not be reached, so nothing was saved.');
    }
    let json = null;
    try { json = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 200 && xhr.status < 300) {
      return json && json.data !== undefined ? json.data : json;
    }
    _handleUnauthorized(xhr.status);
    throw new Error((json && json.message) || `The server refused this request (${xhr.status}).`);
  }

  // True once at least one endpoint has answered. Pages read this to tell
  // "the API is down" apart from "there is genuinely no data yet" — without it,
  // an unreachable backend renders every page as a silent empty shell.
  let _online = false;
  let _reachedEndpoints = 0;

  function init() {
    // Load all data synchronously from the API so the cache is ready before pages render.
    const endpoints = [
      ['users', '/users'], ['tasks', '/tasks'], ['milestones', '/milestones'],
      ['proposals', '/proposals'], ['auditRequests', '/audit-requests'],
      ['auditReports', '/audit-reports'], ['disputes', '/disputes'],
      ['transactions', '/transactions'], ['expertApplications', '/expert-applications'],
      ['notifications', '/notifications'],
      ['messages', '/messages'],
    ];
    // Expert applications hold applicants' contact details and are admin-only.
    // Fetching them for every role logged a 403 on every page load, which buries
    // real errors in the console.
    let role = null, token = null;
    try {
      role = JSON.parse(localStorage.getItem('lannent_session') || '{}').role;
      token = localStorage.getItem('lannent_token');
    } catch {}

    // Nobody is signed in — on the login page, the landing page, signup. Every
    // endpoint below now requires credentials, so firing them anyway produced
    // ten 401s and ten console errors before the visitor had typed anything.
    // The cache stays empty until there is someone to fill it for.
    if (!role && !token) {
      // Still establish reachability, or `isOnline()` would report the API
      // down to every visitor who has not signed in. One public endpoint is
      // enough — this is the application-status lookup, which needs no
      // credentials by design.
      let reachable = null;
      try { reachable = _syncFetch(API + '/expert-applications/status?email=ping@none.invalid'); } catch (e) {}
      _online = reachable !== null;
      _reachedEndpoints = _online ? 1 : 0;
      return;
    }

    const allowed = endpoints.filter(([key]) => key !== 'expertApplications' || (role === 'intake-admin' || role === 'compliance-admin'));

    _reachedEndpoints = 0;
    for (const [key, path] of allowed) {
      // One failing endpoint must not abort the rest.
      let data = null;
      try { data = _syncFetch(API + path); } catch (e) { data = null; }
      if (data) { _cache[key] = data; _reachedEndpoints++; }
      else if (!Array.isArray(_cache[key])) { _cache[key] = []; }
    }
    _online = _reachedEndpoints > 0;
    return _online;
  }

  function isOnline() { return _online; }

  function resetToSeed() {
    _write('POST', `${API}/seed/reset`, {});
    init(); // reload cache
  }

  // ─── USERS ────────────────────────────────────────────────────────────────
  function getUsers() { return _cache.users; }
  function getUserById(id) { return _cache.users.find(u => u.id === id) || null; }
  function getUserByEmail(email) { return _cache.users.find(u => u.email.toLowerCase() === email.toLowerCase()) || null; }

  function createUser(data) {
    // Staff/admin roles cannot be created through the public signup endpoint.
    // When the caller is a superuser creating a privileged role, use the
    // dedicated staff route that bypasses the self-service restriction.
    const STAFF_ROLES = ['superuser', 'revenue-admin', 'intake-admin', 'compliance-admin', 'expert'];
    let endpoint = `${API}/users`;
    try {
      const session = JSON.parse(localStorage.getItem('lannent_session') || '{}');
      if (session.role === 'superuser' && STAFF_ROLES.includes(data.role)) {
        endpoint = `${API}/users/staff`;
      }
    } catch {}
    // No local fallback: a signup the server refused (e.g. a taken email)
    // used to create a fake account in the cache and carry on.
    const result = _write('POST', endpoint, data);
    _cache.users.push(result);
    return result;
  }

  function updateUser(id, updates) {
    const result = _write('PATCH', `${API}/users/${id}`, updates);
    const idx = _cache.users.findIndex(u => u.id === id);
    if (idx >= 0) _cache.users[idx] = result;
    return result;
  }

  function deleteUser(id) {
    _write('DELETE', `${API}/users/${id}`);
    _cache.users = _cache.users.filter(u => u.id !== id);
  }

  // Balance changes must never fall back to a cache-only mutation: that reports
  // success for money the server never moved, and the change is lost on reload.
  // (`deductFromWallet` was removed along with its unrecorded server route.)

  // Deposits and withdrawals carry a platform fee, so these return the fee
  // breakdown ({ gross, fee, net, balance }) rather than the user record.
  // The cached user is refreshed from the server afterwards.
  // The server writes a ledger row for every wallet movement. Without this the
  // wallet pages showed a stale history and a frozen "Total Deposited" until reload.
  function _refreshTransactions() {
    const txs = _syncFetch(`${API}/transactions`);
    if (txs) _cache.transactions = txs;
  }

  function _refreshUser(userId) {
    const fresh = _syncFetch(`${API}/users/${userId}`);
    if (fresh) {
      const idx = _cache.users.findIndex(u => u.id === userId);
      if (idx >= 0) _cache.users[idx] = fresh;
    }
    return fresh;
  }

  function addToWallet(userId, amount) {
    const result = _write('POST', `${API}/users/${userId}/wallet/add`, { amount });
    _refreshUser(userId);
    _refreshTransactions();
    return result;
  }

  /** Withdraws to an external account. Returns { gross, fee, net, balance }. */
  function withdrawFromWallet(userId, amount) {
    const result = _write('POST', `${API}/users/${userId}/wallet/withdraw`, { amount });
    _refreshUser(userId);
    _refreshTransactions();
    return result;
  }

  // ─── AUDIT ENGAGEMENTS ────────────────────────────────────────────────────
  // An audit is a hired, negotiated, escrow-paid engagement:
  //   preview-sent → negotiating → agreed → escrow-funded
  //                → in-progress → report-submitted → paid
  function getAuditPreview(id) {
    return _syncFetch(`${API}/audit-requests/${id}/preview`);
  }
  function getAuditRequestsByTask(taskId) {
    return (_cache.auditRequests || []).filter(a => a.taskId === taskId);
  }
  function _refreshAuditRequests() {
    const fresh = _syncFetch(`${API}/audit-requests`);
    if (fresh) _cache.auditRequests = fresh;
  }
  // The server decides which side an offer comes from (the caller), so
  // `offeredBy` is no longer sent.
  function makeAuditOffer(id, { amount, note }) {
    const r = _write('POST', `${API}/audit-requests/${id}/offers`, { amount, note });
    _refreshAuditRequests();
    return r;
  }
  function acceptAuditOffer(id, offerId) {
    const r = _write('POST', `${API}/audit-requests/${id}/offers/${offerId}/accept`, {});
    _refreshAuditRequests();
    return r;
  }
  function fundAuditEscrow(id) {
    const r = _write('POST', `${API}/audit-requests/${id}/fund`, {});
    _refreshAuditRequests(); _refreshUser(_sessionUserId());
    return r;
  }
  function acceptAuditEngagement(id) {
    const r = _write('POST', `${API}/audit-requests/${id}/accept`, {});
    _refreshAuditRequests();
    const tasks = _syncFetch(`${API}/tasks`);
    if (tasks) _cache.tasks = tasks;
    return r;
  }
  function declineAuditEngagement(id, reason) {
    const r = _write('POST', `${API}/audit-requests/${id}/decline`, { reason });
    _refreshAuditRequests(); _refreshUser(_sessionUserId());
    return r;
  }
  function cancelDraftTask(taskId) {
    const r = _write('POST', `${API}/tasks/${taskId}/cancel-draft`, {});
    const tasks = _syncFetch(`${API}/tasks`);
    if (tasks) _cache.tasks = tasks;
    _refreshUser(_sessionUserId());
    return r;
  }
  function getExperts() {
    return (_cache.users || []).filter(u => u.role === 'expert' && u.status === 'active');
  }
  function _sessionUserId() {
    try { return JSON.parse(localStorage.getItem('lannent_session') || '{}').userId; } catch { return null; }
  }

  // ─── LEDGER ───────────────────────────────────────────────────────────────
  // Authoritative escrow and revenue totals. Do not re-derive escrow from
  // transaction rows: milestone-release rows carry the NET paid to the worker,
  // so summing them under-counts what actually left escrow by the service fee.
  function getLedgerSummary() {
    return _syncFetch(`${API}/ledger/summary`) || {
      totalHeld: 0, totalRevenue: 0, escrowByTask: {}, revenueEntries: [],
    };
  }

  function getEscrowForTask(taskId) {
    return _syncFetch(`${API}/ledger/escrow/${taskId}`) || { projectHeld: 0, auditHeld: 0 };
  }

  // ─── REVENUE (admin) ──────────────────────────────────────────────────────
  function getRevenueSummary()      { return _syncFetch(`${API}/revenue/summary`); }
  function getRevenueByFeeType()    { return _syncFetch(`${API}/revenue/by-fee-type`) || []; }
  function getRevenueTimeseries(period) {
    return _syncFetch(`${API}/revenue/timeseries?period=${period || 'day'}`) || [];
  }
  function getRevenueByUser()       { return _syncFetch(`${API}/revenue/by-user`) || []; }
  function getRevenueDistribution() { return _syncFetch(`${API}/revenue/distribution`); }
  function getRevenueByProject()    { return _syncFetch(`${API}/revenue/by-project`) || []; }
  function getProjectBreakdown(taskId) { return _syncFetch(`${API}/revenue/project/${taskId}`); }
  function getFeeConfig()           { return _syncFetch(`${API}/revenue/fee-config`); }
  function updateFeeConfig(patch)   { return _write('PATCH', `${API}/revenue/fee-config`, patch); }

  // ─── FEE PREVIEW ──────────────────────────────────────────────────────────
  // Mirrors back-end/src/modules/ledger/fee-config.ts so forms can show the
  // charge before it is committed. The server always recomputes authoritatively.
  const FEES = {
    deposit:            { percent: 2.9,  fixed: 0.30 },
    clientMarketplace:  { percent: 5.0 },
    contractInitiation: [
      { upTo: 500, fee: 0.99 }, { upTo: 2000, fee: 4.99 },
      { upTo: 10000, fee: 9.99 }, { upTo: Infinity, fee: 14.99 },
    ],
    workerService: [
      { upTo: 500, percent: 20 }, { upTo: 10000, percent: 10 },
      { upTo: Infinity, percent: 5 },
    ],
    expertService: { percent: 10 },
    withdrawal:    { percent: 0.25, fixed: 0.25, min: 0.25 },
  };

  function _round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function _tier(tiers, amount) { return tiers.find(t => amount <= t.upTo) || tiers[tiers.length - 1]; }

  const Fees = {
    round2: _round2,
    deposit(gross) {
      const fee = _round2(gross * (FEES.deposit.percent / 100) + FEES.deposit.fixed);
      return { gross, fee, net: _round2(gross - fee) };
    },
    withdrawal(gross) {
      const raw = gross * (FEES.withdrawal.percent / 100) + FEES.withdrawal.fixed;
      const fee = _round2(Math.max(raw, FEES.withdrawal.min));
      return { gross, fee, net: _round2(gross - fee) };
    },
    projectFunding(budget) {
      const marketplace = _round2(budget * (FEES.clientMarketplace.percent / 100));
      const initiation = _tier(FEES.contractInitiation, budget).fee;
      return { budget, marketplace, initiation, total: _round2(budget + marketplace + initiation) };
    },
    workerRelease(amount, lifetimeBillings) {
      const rate = _tier(FEES.workerService, lifetimeBillings || 0).percent;
      const fee = _round2(amount * (rate / 100));
      return { amount, rate, fee, net: _round2(amount - fee) };
    },
    expertPayout(amount) {
      const fee = _round2(amount * (FEES.expertService.percent / 100));
      return { amount, fee, net: _round2(amount - fee) };
    },
  };

  // ─── TASKS ────────────────────────────────────────────────────────────────
  function getTasks() { return _cache.tasks; }
  function getTaskById(id) { return _cache.tasks.find(t => t.id === id) || null; }
  function getTasksByClient(clientId) { return _cache.tasks.filter(t => t.clientId === clientId); }
  function getTasksByWorker(workerId) { return _cache.tasks.filter(t => t.workerId === workerId); }
  function getOpenTasks() { return _cache.tasks.filter(t => t.status === 'open'); }

  function createTask(data) {
    const result = _write('POST', `${API}/tasks`, data);
    _cache.tasks.push(result);
    return result;
  }

  function updateTask(id, updates) {
    const result = _write('PATCH', `${API}/tasks/${id}`, updates);
    const idx = _cache.tasks.findIndex(t => t.id === id);
    if (idx >= 0) _cache.tasks[idx] = result;
    return result;
  }

  function deleteTask(id) {
    _write('DELETE', `${API}/tasks/${id}`);
    _cache.tasks = _cache.tasks.filter(t => t.id !== id);
  }

  // ─── MILESTONES ───────────────────────────────────────────────────────────
  function getMilestones() { return _cache.milestones; }
  function getMilestonesByTask(taskId) { return _cache.milestones.filter(m => m.taskId === taskId); }
  function getMilestoneById(id) { return _cache.milestones.find(m => m.id === id) || null; }

  function createMilestone(data) {
    const result = _write('POST', `${API}/milestones`, data);
    _cache.milestones.push(result);
    return result;
  }

  function updateMilestone(id, updates) {
    const result = _write('PATCH', `${API}/milestones/${id}`, updates);
    const idx = _cache.milestones.findIndex(m => m.id === id);
    if (idx >= 0) _cache.milestones[idx] = result;
    return result;
  }

  function _checkTaskCompletion(taskId) {
    const t = _syncFetch(`${API}/tasks/${taskId}`);
    if (t) { const idx = _cache.tasks.findIndex(x => x.id === taskId); if (idx >= 0) _cache.tasks[idx] = t; }
  }

  function submitDeliverable(milestoneId, deliverable) {
    // A refusal surfaces with the server's reason. (Re-sending it as a PATCH
    // once silently dropped the deliverable; keeping a local copy when the
    // server is down would show a submission the client never receives.)
    const result = _write('POST', `${API}/milestones/${milestoneId}/submit`, { deliverable });
    const idx = _cache.milestones.findIndex(m => m.id === milestoneId);
    if (idx >= 0) _cache.milestones[idx] = result;
    return result;
  }

  function approveDeliverable(milestoneId) {
    // No fallback: marking a milestone paid locally when the server refused
    // to release escrow showed money moving that never moved.
    const result = _write('POST', `${API}/milestones/${milestoneId}/approve`, {});
    const idx = _cache.milestones.findIndex(m => m.id === milestoneId);
    if (idx >= 0) _cache.milestones[idx] = result;
    // Refresh tasks, users, and transactions cache to get updated progress/wallet/releases
    const ms = result;
    if (ms.taskId) _checkTaskCompletion(ms.taskId);
    _refreshTransactions();
    // Refresh client user (task owner) for wallet balance
    const task = _cache.tasks.find(t => t.id === ms.taskId);
    if (task && task.clientId) _refreshUser(task.clientId);
    return result;
  }

  // ─── PROPOSALS ────────────────────────────────────────────────────────────
  function getProposals() { return _cache.proposals; }
  function getProposalsByTask(taskId) { return _cache.proposals.filter(p => p.taskId === taskId); }
  function getProposalsByWorker(workerId) { return _cache.proposals.filter(p => p.workerId === workerId && p.type !== 'invitation'); }
  function getInvitationsByWorker(workerId) { return _cache.proposals.filter(p => p.workerId === workerId && p.type === 'invitation'); }

  function createProposal(data) {
    const result = _write('POST', `${API}/proposals`, data);
    _cache.proposals.push(result);
    return result;
  }

  function updateProposal(id, updates) {
    const result = _write('PATCH', `${API}/proposals/${id}`, updates);
    const idx = _cache.proposals.findIndex(p => p.id === id);
    if (idx >= 0) _cache.proposals[idx] = result;
    return result;
  }

  function hireWorker(proposalId) {
    // No fallback: a hire the server refused (usually insufficient funds for
    // escrow) used to be marked hired in the cache anyway.
    const result = _write('POST', `${API}/proposals/${proposalId}/hire`, {});
    const proposals = _syncFetch(`${API}/proposals`);
    const tasks = _syncFetch(`${API}/tasks`);
    if (proposals) _cache.proposals = proposals;
    if (tasks) _cache.tasks = tasks;
    _refreshTransactions();
    _refreshUser(_sessionUserId());
    return result;
  }

  function acceptInvitation(proposalId) {
    const result = _write('POST', `${API}/proposals/${proposalId}/accept`, {});
    const proposals = _syncFetch(`${API}/proposals`);
    const tasks = _syncFetch(`${API}/tasks`);
    if (proposals) _cache.proposals = proposals;
    if (tasks) _cache.tasks = tasks;
    return result;
  }

  function declineInvitation(proposalId) {
    const result = _write('POST', `${API}/proposals/${proposalId}/decline`, {});
    const idx = _cache.proposals.findIndex(p => p.id === proposalId);
    if (idx >= 0) _cache.proposals[idx] = result;
    return result;
  }

  // ─── AUDIT REQUESTS ──────────────────────────────────────────────────────
  function getAuditRequests() { return _cache.auditRequests; }
  function getAuditRequestById(id) { return _cache.auditRequests.find(a => a.id === id) || null; }

  function createAuditRequest(data) {
    const result = _write('POST', `${API}/audit-requests`, data);
    _cache.auditRequests.push(result);
    return result;
  }

  function updateAuditRequest(id, updates) {
    const result = _write('PATCH', `${API}/audit-requests/${id}`, updates);
    const idx = _cache.auditRequests.findIndex(a => a.id === id);
    if (idx >= 0) _cache.auditRequests[idx] = result;
    return result;
  }

  // ─── AUDIT REPORTS ────────────────────────────────────────────────────────
  function getAuditReports() { return _cache.auditReports; }
  /**
   * One engagement now covers every milestone on the project, so a report is
   * identified by the pair. Called with only an engagement id it returns that
   * engagement's first report, which is what the pre-milestone callers expect.
   */
  function getAuditReportByRequest(auditRequestId, milestoneId) {
    if (milestoneId === undefined) {
      return _cache.auditReports.find(r => r.auditRequestId === auditRequestId) || null;
    }
    return _cache.auditReports.find(r =>
      r.auditRequestId === auditRequestId && (r.milestoneId || null) === (milestoneId || null)) || null;
  }

  /** Every report filed under one engagement, newest first. */
  function getReportsByRequest(auditRequestId) {
    return _cache.auditReports.filter(r => r.auditRequestId === auditRequestId);
  }
  function getReportsByTask(taskId) { return _cache.auditReports.filter(r => r.taskId === taskId); }

  function saveAuditReport(data) {
    // No retry and no local fallback (a retry with a forged `role: expert`
    // header, and a fake cached report, were both removed earlier). The
    // request headers — bearer token included — are no longer logged to the
    // console here.
    const result = _write('POST', `${API}/audit-reports`, data);
    const existing = _cache.auditReports.findIndex(r =>
      r.auditRequestId === data.auditRequestId && (r.milestoneId || null) === (data.milestoneId || null));
    if (existing >= 0) _cache.auditReports[existing] = result;
    else _cache.auditReports.push(result);
    // Refresh related caches
    const ar = _syncFetch(`${API}/audit-requests`);
    const ms = _syncFetch(`${API}/milestones`);
    if (ar) _cache.auditRequests = ar;
    if (ms) _cache.milestones = ms;
    return result;
  }

  // ─── DISPUTES ─────────────────────────────────────────────────────────────
  function getDisputes() { return _cache.disputes; }
  function getDisputeById(id) { return _cache.disputes.find(d => d.id === id) || null; }

  function createDispute(data) {
    const result = _write('POST', `${API}/disputes`, data);
    _cache.disputes.push(result);
    if (data.milestoneId) {
      const ms = _syncFetch(`${API}/milestones`);
      if (ms) _cache.milestones = ms;
    }
    return result;
  }

  function resolveDispute(id, { verdict, resolution }) {
    // The server records the caller as the reviewer, so no expertId is sent.
    const result = _write('POST', `${API}/disputes/${id}/resolve`, { verdict, resolution });
    const idx = _cache.disputes.findIndex(d => d.id === id);
    if (idx >= 0) _cache.disputes[idx] = result;
    // Refresh milestones & tasks
    const ms = _syncFetch(`${API}/milestones`);
    const tasks = _syncFetch(`${API}/tasks`);
    if (ms) _cache.milestones = ms;
    if (tasks) _cache.tasks = tasks;
    return result;
  }

  // ─── TRANSACTIONS ─────────────────────────────────────────────────────────
  function getTransactions() { return _cache.transactions; }
  function getTransactionsByUser(userId) { return _cache.transactions.filter(t => t.fromId === userId || t.toId === userId); }

  // `createTransaction` was removed with its server route. Ledger rows are
  // written by the server alongside the money movement they record.

  // ─── EXPERT APPLICATIONS ──────────────────────────────────────────────────
  function getExpertApplications() { return _cache.expertApplications || []; }
  function getExpertApplicationById(id) { return (_cache.expertApplications || []).find(a => a.id === id) || null; }
  function getExpertApplicationByEmail(email) { return (_cache.expertApplications || []).find(a => a.email.toLowerCase() === email.toLowerCase()) || null; }

  /**
   * Public lookup: does an application exist for this email, and what is its
   * status. The full application list is admin-only — it holds applicants'
   * contact details — so signup and login use this instead.
   */
  function getExpertApplicationStatus(email) {
    return _syncFetch(`${API}/expert-applications/status?email=${encodeURIComponent(email)}`)
      || { exists: false, status: null };
  }

  function saveExpertApplication(data) {
    // The server rejects a duplicate email itself; this cache is empty for
    // anyone who is not intake staff, so a local check never caught one.
    try {
      const result = _write('POST', `${API}/expert-applications`, data);
      if (_cache.expertApplications) _cache.expertApplications.push(result);
      return { success: true, application: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function updateExpertApplicationStatus(id, status) {
    const result = _write('PATCH', `${API}/expert-applications/${id}/status`, { status });
    const idx = _cache.expertApplications.findIndex(a => a.id === id);
    if (idx >= 0) _cache.expertApplications[idx] = result;
    // Refresh users (auto-created on approval)
    if (status === 'approved') {
      const users = _syncFetch(`${API}/users`);
      if (users) _cache.users = users;
    }
    return result;
  }

  // ─── NOTIFICATIONS ────────────────────────────────────────────────────────
  function getNotifications(userId) { return (_cache.notifications || []).filter(n => n.userId === userId); }

  /**
   * Best-effort: a notification that cannot be delivered must not undo or
   * hide the action it describes, so a refusal is logged rather than thrown.
   */
  function addNotification(data) {
    try {
      const result = _write('POST', `${API}/notifications`, data);
      if (result && result.userId === _sessionUserId()) _cache.notifications.push(result);
    } catch (e) {
      console.warn('[Store] notification not sent:', e.message);
    }
  }

  function markNotificationsRead(userId) {
    try { _write('PATCH', `${API}/notifications/${userId}/read-all`, {}); } catch (e) { console.warn('[Store]', e.message); }
    // Update local cache
    (_cache.notifications || []).forEach(n => {
      if (n.userId === userId) n.read = true;
    });
  }

  // ─── MESSAGES ──────────────────────────────────────────────────────────────
  function getMessagesByTask(taskId) { return (_cache.messages || []).filter(m => m.taskId === taskId); }
  function getMessagesByUser(userId) { return (_cache.messages || []).filter(m => m.senderId === userId || m.receiverId === userId); }

  function sendMessage(data) {
    const result = _write('POST', `${API}/messages`, data);
    _cache.messages.push(result);
    // Auto-generate notification for the receiver
    addNotification({
      userId: data.receiverId,
      type: 'message',
      text: `New message from ${result.senderName || 'Someone'}`,
      subtext: data.content.length > 50 ? data.content.substring(0, 50) + '...' : data.content,
    });
    return result;
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────────────
  return {
    init, resetToSeed, isOnline,
    getUsers, getUserById, getUserByEmail, createUser, updateUser, deleteUser, addToWallet, withdrawFromWallet, Fees, getLedgerSummary, getEscrowForTask,
    getRevenueSummary, getRevenueByFeeType, getRevenueTimeseries, getRevenueByUser,
    getRevenueDistribution, getRevenueByProject, getProjectBreakdown, getFeeConfig, updateFeeConfig,
    getTasks, getTaskById, getTasksByClient, getTasksByWorker, getOpenTasks, createTask, updateTask, deleteTask,
    getMilestones, getMilestonesByTask, getMilestoneById, createMilestone, updateMilestone, submitDeliverable, approveDeliverable,
    getProposals, getProposalsByTask, getProposalsByWorker, getInvitationsByWorker, createProposal, updateProposal, hireWorker, acceptInvitation, declineInvitation,
    getAuditRequests, getAuditRequestById, createAuditRequest, updateAuditRequest,
    getAuditPreview, getAuditRequestsByTask, makeAuditOffer, acceptAuditOffer, fundAuditEscrow,
    acceptAuditEngagement, declineAuditEngagement, cancelDraftTask, getExperts,
    uploadFile, fileUrl, downloadFile,
    getAuditReports, getAuditReportByRequest, getReportsByRequest, getReportsByTask, saveAuditReport,
    getDisputes, getDisputeById, createDispute, resolveDispute,
    getTransactions, getTransactionsByUser,
    getNotifications, addNotification, markNotificationsRead,
    getMessagesByTask, getMessagesByUser, sendMessage,
    getExpertApplications, getExpertApplicationById, getExpertApplicationByEmail, getExpertApplicationStatus, saveExpertApplication, updateExpertApplicationStatus,
  };
})();


const StoreContext = createContext(Store);

/** Makes the Store available to every component below it. */
export function StoreProvider({ children }) {
  return <StoreContext.Provider value={Store}>{children}</StoreContext.Provider>;
}

/** The app's Store (same API as the original global `Store`). */
export function useStore() {
  return useContext(StoreContext);
}
