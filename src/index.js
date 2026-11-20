// Worktime – Cloudflare Worker (API + iCal feed). Frontend lives in /public.
const enc = new TextEncoder();
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const fail = (status, message) => json({ error: message }, status);
const nowS = () => Math.floor(Date.now() / 1000);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function hashPassword(pw, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- time helpers ----------
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; } };
const localDate = (s, tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(s * 1000));
const weekday = (ymd) => new Date(ymd + 'T00:00:00Z').getUTCDay();
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function netSeconds(entry, breaks, now) {
  const end = entry.end_s ?? now;
  let total = end - entry.start_s - (entry.extra_break_s || 0);
  for (const b of breaks) total -= Math.max(0, Math.min(b.end_s ?? end, end) - b.start_s);
  return Math.max(0, total);
}
const breakSeconds = (entry, breaks, now) => {
  const end = entry.end_s ?? now;
  return (entry.extra_break_s || 0) + breaks.reduce((s, b) => s + Math.max(0, Math.min(b.end_s ?? end, end) - b.start_s), 0);
};

async function loadEntries(env, userId, fromS, toS) {
  const { results: entries } = await env.DB.prepare(
    'SELECT * FROM entries WHERE user_id = ? AND start_s >= ? AND start_s < ? ORDER BY start_s DESC')
    .bind(userId, fromS, toS).all();
  const { results: breaks } = await env.DB.prepare(
    `SELECT b.* FROM breaks b JOIN entries e ON e.id = b.entry_id
     WHERE e.user_id = ? AND e.start_s >= ? AND e.start_s < ?`).bind(userId, fromS, toS).all();
  const by = {};
  for (const b of breaks) (by[b.entry_id] ||= []).push(b);
  return entries.map((e) => ({ ...e, breaks: by[e.id] || [] }));
}

// ---------- auth ----------
async function currentUser(request, env) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(request.headers.get('cookie') || '');
  if (!m) return null;
  return env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256(m[1]), nowS()).first();
}
async function createSession(env, userId) {
  const token = rand(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, nowS() + SESSION_TTL).run();
  return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}
const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, tz: u.tz, weekly_hours: u.weekly_hours,
  work_days: u.work_days.split(',').filter(Boolean).map(Number),
  start_date: u.start_date, initial_balance_min: u.initial_balance_min, cal_token: u.cal_token,
});

// ---------- timer state ----------
async function timerState(env, user) {
  const entry = await env.DB.prepare('SELECT * FROM entries WHERE user_id = ? AND end_s IS NULL').bind(user.id).first();
  if (!entry) return { running: false };
  const { results: breaks } = await env.DB.prepare('SELECT * FROM breaks WHERE entry_id = ?').bind(entry.id).all();
  const now = nowS();
  return {
    running: true, entry, on_break: breaks.some((b) => b.end_s === null),
    net_s: netSeconds(entry, breaks, now), break_s: breakSeconds(entry, breaks, now), server_now: now,
  };
}

// ---------- summary / overtime balance ----------
async function summary(env, user, from, to) {
  const tz = user.tz, now = nowS();
  const today = localDate(now, tz);
  from = from || user.start_date;
  to = to || today;
  const entries = await loadEntries(env, user.id, Date.parse(from + 'T00:00:00Z') / 1000 - 86400, Date.parse(to + 'T00:00:00Z') / 1000 + 2 * 86400);
  const workDays = user.work_days.split(',').filter(Boolean).map(Number);
  const dailyTargetMin = workDays.length ? (user.weekly_hours * 60) / workDays.length : 0;
  const worked = {};
  for (const e of entries) {
    const d = localDate(e.start_s, tz);
    if (d >= from && d <= to) worked[d] = (worked[d] || 0) + netSeconds(e, e.breaks, now);
  }
  const days = [];
  let workedMin = 0, targetMin = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const target = workDays.includes(weekday(d)) ? dailyTargetMin : 0;
    const w = Math.round((worked[d] || 0) / 60);
    days.push({ date: d, worked_min: w, target_min: Math.round(target) });
    workedMin += w; targetMin += target;
  }
  // the balance always counts from start_date up to today, independent of the requested range
  let balance;
  if (from !== user.start_date || to !== today) balance = (await summary(env, user, user.start_date, today)).balance_min;
  else balance = user.initial_balance_min + workedMin - Math.round(targetMin);
  return { from, to, today, days, worked_min: workedMin, target_min: Math.round(targetMin), balance_min: balance };
}

// ---------- iCal feed ----------
const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (s) => new Date(s * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const fmtHM = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;

async function calendarFeed(env, token) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE cal_token = ?').bind(token).first();
  if (!user) return new Response('Not found', { status: 404 });
  const now = nowS();
  const entries = await loadEntries(env, user.id, now - 365 * 86400, now + 86400);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//worktime//EN', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsEscape('Work time – ' + user.name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  for (const e of entries) {
    const net = Math.round(netSeconds(e, e.breaks, now) / 60);
    const brk = Math.round(breakSeconds(e, e.breaks, now) / 60);
    const desc = [e.note, `Net: ${fmtHM(net)}`, `Breaks: ${brk} min`].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:entry-${e.id}@worktime`, `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(e.start_s)}`, `DTEND:${icsDate(e.end_s ?? now)}`,
      `SUMMARY:${icsEscape('Work ' + fmtHM(net) + (e.end_s ? '' : ' (running)'))}`,
      `DESCRIPTION:${icsEscape(desc)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.join('\r\n'), {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

// ---------- validation ----------
async function overlaps(env, userId, start, end, exceptId = 0) {
  const r = await env.DB.prepare(
    'SELECT 1 FROM entries WHERE user_id = ? AND id != ? AND start_s < ? AND COALESCE(end_s, 9999999999) > ? LIMIT 1')
    .bind(userId, exceptId, end, start).first();
  return !!r;
}
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : NaN);

// ---------- router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      const cal = /^\/cal\/([a-f0-9]{32,64})\.ics$/.exec(path);
      if (cal && request.method === 'GET') return calendarFeed(env, cal[1]);
      if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });

      const body = ['POST', 'PATCH', 'PUT'].includes(request.method)
        ? await request.json().catch(() => ({})) : {};

      // --- public auth routes ---
      if (path === '/api/register' && request.method === 'POST') {
        if (env.ALLOW_REGISTRATION !== 'true') return fail(403, 'Registration is closed');
        const email = String(body.email || '').trim().toLowerCase();
        const name = String(body.name || '').trim().slice(0, 80);
        const pw = String(body.password || '');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, 'Invalid email');
        if (!name) return fail(400, 'Name required');
        if (pw.length < 10) return fail(400, 'Password must have at least 10 characters');
        const tz = validTz(body.tz) ? body.tz : 'Europe/Berlin';
        const salt = rand(16);
        try {
          const r = await env.DB.prepare(
            `INSERT INTO users (email, name, salt, password_hash, tz, start_date, cal_token, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(email, name, salt, await hashPassword(pw, salt), tz, localDate(nowS(), tz), rand(24), nowS()).run();
          return json({ ok: true }, 201, { 'set-cookie': await createSession(env, r.meta.last_row_id) });
        } catch { return fail(409, 'Email already registered'); }
      }
      if (path === '/api/login' && request.method === 'POST') {
        const email = String(body.email || '').trim().toLowerCase();
        const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
        const h = await hashPassword(String(body.password || ''), u ? u.salt : 'x'.repeat(32));
        if (!u || !safeEqual(h, u.password_hash)) return fail(401, 'Wrong email or password');
        return json({ ok: true }, 200, { 'set-cookie': await createSession(env, u.id) });
      }
      if (path === '/api/logout' && request.method === 'POST') {
        const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(request.headers.get('cookie') || '');
        if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(m[1])).run();
        return json({ ok: true }, 200, { 'set-cookie': 'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
      }

      // --- authenticated routes ---
      const user = await currentUser(request, env);
      if (!user) return fail(401, 'Not authenticated');

      if (path === '/api/me' && request.method === 'GET') return json(publicUser(user));
      if (path === '/api/me' && request.method === 'PATCH') {
        const f = {};
        if (body.name) f.name = String(body.name).slice(0, 80);
        if (body.tz) { if (!validTz(body.tz)) return fail(400, 'Invalid time zone'); f.tz = body.tz; }
        if (body.weekly_hours !== undefined) {
          const h = Number(body.weekly_hours);
          if (!(h >= 0 && h <= 80)) return fail(400, 'weekly_hours must be 0-80');
          f.weekly_hours = h;
        }
        if (Array.isArray(body.work_days)) {
          const d = [...new Set(body.work_days.map(Number))].filter((x) => x >= 0 && x <= 6).sort();
          f.work_days = d.join(',');
        }
        if (body.start_date) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(body.start_date)) return fail(400, 'Invalid start_date');
          f.start_date = body.start_date;
        }
        if (body.initial_balance_min !== undefined) {
          const v = int(body.initial_balance_min);
          if (Number.isNaN(v)) return fail(400, 'Invalid initial balance');
          f.initial_balance_min = v;
        }
        const keys = Object.keys(f);
        if (keys.length) {
          await env.DB.prepare(`UPDATE users SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`)
            .bind(...keys.map((k) => f[k]), user.id).run();
        }
        return json(publicUser(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first()));
      }
      if (path === '/api/me/cal-token' && request.method === 'POST') {
        const t = rand(24);
        await env.DB.prepare('UPDATE users SET cal_token = ? WHERE id = ?').bind(t, user.id).run();
        return json({ cal_token: t });
      }

      // --- timer ---
      if (path === '/api/timer' && request.method === 'GET') return json(await timerState(env, user));
      if (path === '/api/timer/start' && request.method === 'POST') {
        try {
          await env.DB.prepare('INSERT INTO entries (user_id, start_s, note, created_at) VALUES (?, ?, ?, ?)')
            .bind(user.id, nowS(), String(body.note || '').slice(0, 500), nowS()).run();
        } catch { return fail(409, 'A timer is already running'); }
        return json(await timerState(env, user), 201);
      }
      if (['/api/timer/pause', '/api/timer/resume', '/api/timer/stop'].includes(path) && request.method === 'POST') {
        const st = await timerState(env, user);
        if (!st.running) return fail(409, 'No timer running');
        const now = nowS(), id = st.entry.id;
        if (path.endsWith('/pause')) {
          if (st.on_break) return fail(409, 'Already on break');
          await env.DB.prepare('INSERT INTO breaks (entry_id, start_s) VALUES (?, ?)').bind(id, now).run();
        } else if (path.endsWith('/resume')) {
          if (!st.on_break) return fail(409, 'Not on break');
          await env.DB.prepare('UPDATE breaks SET end_s = ? WHERE entry_id = ? AND end_s IS NULL').bind(now, id).run();
        } else {
          await env.DB.batch([
            env.DB.prepare('UPDATE breaks SET end_s = ? WHERE entry_id = ? AND end_s IS NULL').bind(now, id),
            env.DB.prepare("UPDATE entries SET end_s = ?, note = COALESCE(NULLIF(?, ''), note) WHERE id = ?")
              .bind(now, String(body.note || '').slice(0, 500), id),
          ]);
        }
        return json(await timerState(env, user));
      }

      // --- entries ---
      if (path === '/api/entries' && request.method === 'GET') {
        const to = int(url.searchParams.get('to') || nowS() + 86400);
        const from = int(url.searchParams.get('from') || to - 14 * 86400);
        const now = nowS();
        const rows = await loadEntries(env, user.id, from, to);
        return json(rows.map((e) => ({
          id: e.id, start_s: e.start_s, end_s: e.end_s, note: e.note,
          break_s: breakSeconds(e, e.breaks, now), net_s: netSeconds(e, e.breaks, now),
        })));
      }
      if (path === '/api/entries' && request.method === 'POST') {
        const start = int(body.start_s), end = int(body.end_s), brk = int(body.break_min || 0) * 60;
        if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return fail(400, 'End must be after start');
        if (end > nowS() + 60) return fail(400, 'Entry lies in the future');
        if (Number.isNaN(brk) || brk < 0 || brk >= end - start) return fail(400, 'Invalid break');
        if (await overlaps(env, user.id, start, end)) return fail(409, 'Overlaps with another entry');
        await env.DB.prepare('INSERT INTO entries (user_id, start_s, end_s, note, extra_break_s, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(user.id, start, end, String(body.note || '').slice(0, 500), brk, nowS()).run();
        return json({ ok: true }, 201);
      }
      const em = /^\/api\/entries\/(\d+)$/.exec(path);
      if (em) {
        const id = Number(em[1]);
        const e = await env.DB.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').bind(id, user.id).first();
        if (!e) return fail(404, 'Not found');
        if (request.method === 'DELETE') {
          await env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
          return json({ ok: true });
        }
        if (request.method === 'PATCH') {
          if (e.end_s === null) return fail(409, 'Stop the timer first');
          const start = body.start_s !== undefined ? int(body.start_s) : e.start_s;
          const end = body.end_s !== undefined ? int(body.end_s) : e.end_s;
          const brk = body.break_min !== undefined ? int(body.break_min) * 60 : e.extra_break_s;
          if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return fail(400, 'End must be after start');
          if (Number.isNaN(brk) || brk < 0) return fail(400, 'Invalid break');
          if (await overlaps(env, user.id, start, end, id)) return fail(409, 'Overlaps with another entry');
          await env.DB.prepare('UPDATE entries SET start_s = ?, end_s = ?, extra_break_s = ?, note = ? WHERE id = ?')
            .bind(start, end, brk, body.note !== undefined ? String(body.note).slice(0, 500) : e.note, id).run();
          return json({ ok: true });
        }
      }

      // --- summary ---
      if (path === '/api/summary' && request.method === 'GET') {
        const ok = (s) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);
        const from = url.searchParams.get('from'), to = url.searchParams.get('to');
        if (!ok(from) || !ok(to)) return fail(400, 'Invalid date');
        return json(await summary(env, user, from, to));
      }

      return fail(404, 'Not found');
    } catch (e) {
      console.error(e);
      return fail(500, 'Internal error');
    }
  },
};
