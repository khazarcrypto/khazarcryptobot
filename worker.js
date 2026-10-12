/**
 * 🏆 Khazar Crypto Dəvət Yarışması Botu — @khazarcryptobot
 * Cloudflare Workers + D1 (SQLite) + Cron Trigger
 *
 * Lazım olan:
 *  - D1 database binding adı:  DB
 *  - Secrets:  BOT_TOKEN, WEBHOOK_SECRET   (WEBHOOK_SECRET yalnız hərf/rəqəm/_/- )
 *  - (istəyə bağlı Variables) ADMIN_ID, GROUP_ID, BOT_USERNAME
 *  - Cron Trigger:  * * * * *   (hər dəqiqə)
 *  - Quraşdırma:  https://SENIN-WORKER.workers.dev/setup?key=WEBHOOK_SECRET
 */

const PPI = 5;              // 1 təsdiqlənmiş dəvət = 5 xal
const MSG_REQUIRED = 10;    // təsdiq üçün lazım olan mesaj sayı
const MIN_LETTERS = 5;      // mesajın sayılması üçün minimum hərf/rəqəm sayı
const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const DAY = 86400000;
const BAKU_OFFSET = 4 * 3600 * 1000; // Bakı vaxtı UTC+4

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS participants (user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT, invite_link TEXT, gen INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT \'active\', adj INTEGER NOT NULL DEFAULT 0, created_at INTEGER)',
  'CREATE INDEX IF NOT EXISTS idx_part_link ON participants(invite_link)',
  'CREATE TABLE IF NOT EXISTS invites (invitee_id INTEGER PRIMARY KEY, inviter_id INTEGER NOT NULL, joined_at INTEGER, msg_count INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0, approved_at INTEGER, left_flag INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS idx_inv_inviter ON invites(inviter_id)',
  'CREATE TABLE IF NOT EXISTS msgs (invitee_id INTEGER NOT NULL, h TEXT NOT NULL, PRIMARY KEY (invitee_id, h))',
];

const DEF = {
  status: 'none', // none | active | paused | expired | ended
  month: 'Oktyabr',
  gen: '0',
  duration_days: '30',
  start_ts: '0',
  end_ts: '0',
  paused_at: '0',
  auto_minutes: '0',
  last_post_ts: '0',
  pending: '',
};

const PANEL_KB = [
  [{ text: '📊 Sıralama', callback_data: 'sir' }, { text: '📋 Siyahı', callback_data: 'list' }],
  [{ text: '▶️ Başlat', callback_data: 'start' }, { text: '⏸ Dayandır', callback_data: 'stop' }, { text: '⏯ Davam', callback_data: 'resume' }],
  [{ text: '🔄 Restart', callback_data: 'restart' }, { text: '🏁 Bitir', callback_data: 'end' }],
  [{ text: '📅 Bitmə tarixi', callback_data: 'dur' }, { text: '🗓 Ay adı', callback_data: 'month' }],
  [{ text: '⏰ Avto sıralama', callback_data: 'auto' }],
  [{ text: '🗑 Xal sil', callback_data: 'delpts' }, { text: '🚫 Diskvalifikasiya', callback_data: 'dq' }],
  [{ text: '♻️ Bərpa et', callback_data: 'undq' }, { text: '🔃 Yenilə', callback_data: 'panel' }],
];
const CANCEL_KB = [[{ text: '❌ Ləğv et', callback_data: 'cancel' }]];

/* ------------------------------------------------------------------ */
/* Köməkçi funksiyalar                                                 */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = (s) =>
  String(s || '').toLowerCase().replace(/ı/g, 'i').replace(/ə/g, 'e').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function ids(env) {
  return {
    admin: Number(env.ADMIN_ID || 5461064199),
    group: Number(env.GROUP_ID || -1004483409103),
    bot: String(env.BOT_USERNAME || 'khazarcryptobot').toLowerCase(),
  };
}

async function tg(env, method, params) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const j = await r.json();
    if (!j.ok) console.error('TG ERROR', method, j.description);
    return j;
  } catch (e) {
    console.error('TG FETCH ERROR', method, e);
    return { ok: false, description: String(e) };
  }
}

const send = (env, chat_id, text, extra = {}) =>
  tg(env, 'sendMessage', { chat_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

async function loadCfg(env) {
  const { results } = await env.DB.prepare('SELECT k, v FROM config').all();
  const c = { ...DEF };
  for (const r of results) c[r.k] = r.v;
  return {
    status: c.status,
    month: c.month,
    gen: +c.gen,
    duration_days: +c.duration_days,
    start_ts: +c.start_ts,
    end_ts: +c.end_ts,
    paused_at: +c.paused_at,
    auto_minutes: +c.auto_minutes,
    last_post_ts: +c.last_post_ts,
    pending: c.pending,
  };
}

async function setCfg(env, obj) {
  const st = env.DB.prepare('INSERT INTO config(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  await env.DB.batch(Object.entries(obj).map(([k, v]) => st.bind(k, String(v))));
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts + BAKU_OFFSET);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function fmtLeft(ms) {
  if (ms <= 0) return '0 dəq';
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${d} gün ${h} saat ${m} dəq`;
}

function parseDate(s) {
  s = String(s || '').trim();
  let y, mo, d, h, mi;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (m) {
    [, y, mo, d, h, mi] = m;
  } else {
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (!m) return null;
    [, d, mo, y, h, mi] = m;
  }
  const ts = Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0)) - BAKU_OFFSET;
  return Number.isFinite(ts) ? ts : null;
}

function parseAuto(s) {
  const t = norm(s).trim();
  if (['0', 'off', 'sondur', 'yox', 'bagla'].includes(t)) return 0;
  let m = t.match(/^gunde\s+(\d+)$/);
  if (m) {
    const n = +m[1];
    if (n < 1 || n > 96) return null;
    return Math.round(1440 / n);
  }
  m = t.match(/^(\d+(?:[.,]\d+)?)\s*(?:saat|s|h)?$/);
  if (m) {
    const h = parseFloat(m[1].replace(',', '.'));
    if (h < 0.25 || h > 720) return null;
    return Math.round(h * 60);
  }
  return null;
}

function describeAuto(min) {
  if (!min) return 'söndürülüb';
  if (min === 1440) return 'gündə 1 dəfə (24 saatdan bir)';
  if (min < 1440 && 1440 % min === 0) return `hər ${min / 60} saatdan bir (gündə ${1440 / min} dəfə)`;
  return `hər ${+(min / 60).toFixed(2)} saatdan bir`;
}

function displayName(r) {
  if (r.username) return '@' + esc(r.username);
  const n = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
  return esc(n.slice(0, 40) || 'ID ' + r.user_id);
}

function linkName(u) {
  const uid = String(u.id);
  const label = u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ');
  const max = 32 - uid.length - 3;
  let out = '';
  for (const ch of label) {
    if ((out + ch).length > max) break;
    out += ch;
  }
  return out ? `${out} | ${uid}` : uid;
}

function parseCmd(env, text) {
  const parts = text.trim().split(/\s+/);
  const m = parts[0].match(/^\/([^@\s]+)(?:@(\S+))?$/);
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== ids(env).bot) return null;
  return { name: norm(m[1]), rest: parts.slice(1).join(' ') };
}

/* ------------------------------------------------------------------ */
/* Sıralama                                                            */
/* ------------------------------------------------------------------ */

async function rank(env, gen, limit, mode) {
  const where = mode === 'board' ? "AND p.status = 'active'" : '';
  const having = mode === 'board' ? 'HAVING pts > 0' : '';
  const sql = `SELECT p.user_id, p.username, p.first_name, p.last_name, p.status,
      (COALESCE(SUM(CASE WHEN i.approved = 1 AND i.left_flag = 0 THEN 1 ELSE 0 END), 0) * ${PPI} + p.adj) AS pts,
      MAX(CASE WHEN i.approved = 1 AND i.left_flag = 0 THEN i.approved_at END) AS last_at
    FROM participants p LEFT JOIN invites i ON i.inviter_id = p.user_id
    WHERE p.gen = ?1 ${where}
    GROUP BY p.user_id ${having}
    ORDER BY pts DESC, COALESCE(last_at, 9e15) ASC
    LIMIT ?2`;
  return (await env.DB.prepare(sql).bind(gen, limit).all()).results;
}

async function userStats(env, gen, uid) {
  return env.DB.prepare(
    `SELECT p.user_id, p.username, p.first_name, p.last_name, p.status, p.adj,
      COALESCE(SUM(CASE WHEN i.approved = 1 AND i.left_flag = 0 THEN 1 ELSE 0 END), 0) AS ok,
      COALESCE(SUM(CASE WHEN i.approved = 0 AND i.left_flag = 0 THEN 1 ELSE 0 END), 0) AS wait
     FROM participants p LEFT JOIN invites i ON i.inviter_id = p.user_id
     WHERE p.gen = ?1 AND p.user_id = ?2 GROUP BY p.user_id`
  ).bind(gen, uid).first();
}

function boardText(cfg, rows) {
  let t = `🏆 <b>KHAZAR CRYPTO</b> 🔥\n<b>TOP 10 — ${esc(cfg.month)} Dəvət Yarışı</b>\n`;
  if (!rows.length) return t + 'Hələ heç kim xal qazanmayıb. İlk sən ol! 🚀';
  rows.slice(0, 10).forEach((r, i) => {
    t += `${MEDALS[i]} ${displayName(r)}\n${r.pts} xal\n`;
  });
  return t.trimEnd();
}

async function listText(env, cfg) {
  const rows = await rank(env, cfg.gen, 40, 'all');
  if (!rows.length) return '📋 Hələ iştirakçı yoxdur.';
  let t = '📋 <b>İştirakçılar</b> (ilk 40)\n\n';
  rows.forEach((r, i) => {
    t += `${i + 1}. ${displayName(r)} — <b>${Math.max(r.pts, 0)}</b> xal — <code>${r.user_id}</code>${r.status === 'dq' ? ' 🚫' : ''}\n`;
  });
  return t;
}

/* ------------------------------------------------------------------ */
/* Giriş nöqtəsi                                                       */
/* ------------------------------------------------------------------ */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/setup') return setup(env, url);
    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      let update;
      try {
        update = await req.json();
      } catch {
        return new Response('bad request', { status: 400 });
      }
      ctx.waitUntil(handleUpdate(env, update).catch((e) => console.error('ERR', (e && e.stack) || e)));
      return new Response('ok');
    }
    return new Response('Khazar Crypto Bot ✅');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env).catch((e) => console.error('TICK ERR', (e && e.stack) || e)));
  },
};

async function setup(env, url) {
  if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  const wh = await tg(env, 'setWebhook', {
    url: url.origin + '/webhook',
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query', 'chat_member'],
    drop_pending_updates: true,
  });
  const me = await tg(env, 'getMe', {});
  let group_check = null;
  if (me.ok) {
    const r = await tg(env, 'getChatMember', { chat_id: ids(env).group, user_id: me.result.id });
    group_check = r.ok ? { status: r.result.status, can_invite_users: r.result.can_invite_users } : r;
  }
  return new Response(JSON.stringify({ database: 'ok', webhook: wh, bot: me.result && me.result.username, group_check }, null, 2), {
    headers: { 'content-type': 'application/json' },
  });
}

async function handleUpdate(env, u) {
  if (u.chat_member) return onChatMember(env, u.chat_member);
  if (u.callback_query) return onCallback(env, u.callback_query);
  if (u.message) return onMessage(env, u.message);
}

/* ------------------------------------------------------------------ */
/* Cron: müddət bitməsi + avtomatik sıralama                           */
/* ------------------------------------------------------------------ */

async function tick(env) {
  const { admin, group } = ids(env);
  const cfg = await loadCfg(env);
  const now = Date.now();
  if (cfg.status !== 'active') return;

  if (cfg.end_ts && now >= cfg.end_ts) {
    await setCfg(env, { status: 'expired' });
    await send(
      env,
      admin,
      '⏰ <b>Yarışın müddəti bitdi.</b>\nXallar dondurulub.\n\n🏁 Qalibləri açıqlamaq üçün /bitir\n📅 Müddəti uzatmaq üçün /uzat 7 və ya /bitme 25.11.2026 18:00'
    );
    return;
  }

  if (cfg.auto_minutes > 0) {
    const iv = cfg.auto_minutes * 60000;
    if (now - cfg.last_post_ts >= iv) {
      const k = Math.floor((now - cfg.last_post_ts) / iv);
      await setCfg(env, { last_post_ts: cfg.last_post_ts + k * iv });
      await send(env, group, boardText(cfg, await rank(env, cfg.gen, 10, 'board')));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Qrup hadisələri: qoşulma / çıxma                                    */
/* ------------------------------------------------------------------ */

async function onChatMember(env, cm) {
  const { group } = ids(env);
  if (cm.chat.id !== group) return;
  const isIn = (x) => ['member', 'administrator', 'creator'].includes(x.status) || (x.status === 'restricted' && x.is_member);
  const was = isIn(cm.old_chat_member);
  const nowIn = isIn(cm.new_chat_member);
  const user = cm.new_chat_member.user;
  if (user.is_bot) return;
  const cfg = await loadCfg(env);

  if (was && !nowIn) {
    // Qrupdan çıxdı: xal silinir və bu istifadəçi bir daha xal verə bilməz
    if (['none', 'ended'].includes(cfg.status)) return;
    await env.DB.batch([
      env.DB.prepare('UPDATE invites SET left_flag = 1 WHERE invitee_id = ? AND left_flag = 0').bind(user.id),
      env.DB.prepare('DELETE FROM msgs WHERE invitee_id = ?').bind(user.id),
    ]);
    return;
  }

  if (!was && nowIn) {
    const link = cm.invite_link && cm.invite_link.invite_link;
    if (!link) return;
    if (!['active', 'paused'].includes(cfg.status)) return;
    const p = await env.DB.prepare("SELECT user_id FROM participants WHERE invite_link = ? AND gen = ? AND status = 'active'")
      .bind(link, cfg.gen)
      .first();
    if (!p || p.user_id === user.id) return;
    // INSERT OR IGNORE: hər istifadəçi ömür boyu (bu yarışda) yalnız bir dəfə xal verə bilər
    await env.DB.prepare('INSERT OR IGNORE INTO invites(invitee_id, inviter_id, joined_at) VALUES(?, ?, ?)')
      .bind(user.id, p.user_id, Date.now())
      .run();
  }
}

/* ------------------------------------------------------------------ */
/* Mesajlar                                                            */
/* ------------------------------------------------------------------ */

async function onMessage(env, m) {
  const { admin, group } = ids(env);

  if (m.chat.type === 'private') {
    if (!m.from || m.from.id !== admin) return; // başqalarına cavab verilmir
    return adminDM(env, m);
  }

  if (m.chat.id !== group || !m.from || m.from.is_bot) return;
  const cfg = await loadCfg(env);
  await syncProfile(env, m.from);

  const text = m.text || '';
  if (text.startsWith('/')) {
    const c = parseCmd(env, text);
    if (!c) return;
    if (c.name === 'link') return onLink(env, m, cfg);
    if (c.name === 'siralama' && m.from.id === admin) {
      return send(env, group, boardText(cfg, await rank(env, cfg.gen, 10, 'board')));
    }
    return;
  }
  return countMessage(env, m, cfg);
}

async function syncProfile(env, u) {
  await env.DB.prepare(
    'UPDATE participants SET username = ?1, first_name = ?2, last_name = ?3 WHERE user_id = ?4 AND (username IS NOT ?1 OR first_name IS NOT ?2 OR last_name IS NOT ?3)'
  )
    .bind(u.username ?? null, u.first_name ?? null, u.last_name ?? null, u.id)
    .run();
}

async function countMessage(env, m, cfg) {
  if (cfg.status !== 'active' || !m.text || m.forward_origin || m.via_bot) return;
  const letters = (m.text.match(/[\p{L}\p{N}]/gu) || []).length;
  if (letters < MIN_LETTERS) return; // "a", "b", "ok" kimi spam mesajlar sayılmır
  const uid = m.from.id;
  const inv = await env.DB.prepare('SELECT msg_count FROM invites WHERE invitee_id = ? AND approved = 0 AND left_flag = 0')
    .bind(uid)
    .first();
  if (!inv) return;
  const key = m.text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
  const ins = await env.DB.prepare('INSERT OR IGNORE INTO msgs(invitee_id, h) VALUES(?, ?)').bind(uid, key).run();
  if (!ins.meta.changes) return; // eyni mesajı təkrar yazmaq sayılmır
  await env.DB.batch([
    env.DB.prepare('UPDATE invites SET msg_count = msg_count + 1 WHERE invitee_id = ? AND approved = 0 AND left_flag = 0').bind(uid),
    env.DB.prepare(
      'UPDATE invites SET approved = 1, approved_at = ? WHERE invitee_id = ? AND approved = 0 AND left_flag = 0 AND msg_count >= ?'
    ).bind(Date.now(), uid, MSG_REQUIRED),
    env.DB.prepare('DELETE FROM msgs WHERE invitee_id = ? AND EXISTS (SELECT 1 FROM invites WHERE invitee_id = ? AND approved = 1)').bind(uid, uid),
  ]);
}

/* ------------------------------------------------------------------ */
/* /link                                                               */
/* ------------------------------------------------------------------ */

async function onLink(env, m, cfg) {
  const { group } = ids(env);
  const u = m.from;
  const reply = (t) => send(env, group, t, { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });

  if (!['active', 'paused'].includes(cfg.status)) return reply('ℹ️ Hazırda aktiv yarış yoxdur.');

  let p = await env.DB.prepare('SELECT * FROM participants WHERE user_id = ?').bind(u.id).first();
  if (p && p.gen === cfg.gen && p.status === 'dq') return reply('🚫 Siz yarışdan kənarlaşdırılmısınız.');

  let link = p && p.gen === cfg.gen ? p.invite_link : null;
  if (!link) {
    if (p && p.invite_link) await tg(env, 'revokeChatInviteLink', { chat_id: group, invite_link: p.invite_link });
    const r = await tg(env, 'createChatInviteLink', { chat_id: group, name: linkName(u) });
    if (!r.ok) return reply('⚠️ Dəvət linki yaradıla bilmədi. Bir az sonra yenidən cəhd edin.');
    link = r.result.invite_link;
    await env.DB.prepare(
      `INSERT INTO participants(user_id, username, first_name, last_name, invite_link, gen, status, adj, created_at)
       VALUES(?, ?, ?, ?, ?, ?, 'active', 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
         last_name = excluded.last_name, invite_link = excluded.invite_link, gen = excluded.gen, status = 'active', adj = 0`
    )
      .bind(u.id, u.username ?? null, u.first_name ?? null, u.last_name ?? null, link, cfg.gen, Date.now())
      .run();
  }

  const s = await userStats(env, cfg.gen, u.id);
  const ok = s ? s.ok : 0;
  const wait = s ? s.wait : 0;
  const pts = Math.max(ok * PPI + (s ? s.adj : 0), 0);

  return reply(
    `🔗 <b>Sənin şəxsi dəvət linkin:</b>\n${link}\n\n` +
      `✅ Təsdiqlənmiş dəvət: <b>${ok}</b>\n` +
      `⏳ Təsdiq gözləyən dəvət: <b>${wait}</b>\n` +
      `⭐ Xalın: <b>${pts}</b>\n\n` +
      `ℹ️ Dəvət etdiyin şəxs qrupda ${MSG_REQUIRED} mesaj yazdıqda təsdiqlənir və sənə ${PPI} xal verilir.`
  );
}

/* ------------------------------------------------------------------ */
/* Admin: DM                                                           */
/* ------------------------------------------------------------------ */

async function adminDM(env, m) {
  const { admin } = ids(env);
  const cfg = await loadCfg(env);
  const text = (m.text || '').trim();

  if (text.startsWith('/')) {
    const c = parseCmd(env, text);
    if (!c) return;
    if (cfg.pending) await setCfg(env, { pending: '' });
    return runCommand(env, c.name, c.rest, cfg);
  }
  if (cfg.pending) return handleAwait(env, m, cfg);
  return send(env, admin, 'ℹ️ Admin paneli üçün /admin yaz.');
}

async function runCommand(env, name, rest, cfg) {
  const { admin } = ids(env);
  switch (name) {
    case 'start':
    case 'admin':
    case 'panel':
    case 'menu':
      return panel(env, cfg);
    case 'siralama':
      return send(env, admin, boardText(cfg, await rank(env, cfg.gen, 10, 'board')));
    case 'siyahi':
      return send(env, admin, await listText(env, cfg));
    case 'baslat':
      return startFlow(env, cfg, rest);
    case 'stop':
      return pauseContest(env, cfg);
    case 'davam':
      return resumeContest(env, cfg);
    case 'restart':
      return restartAsk(env);
    case 'bitir':
      return endPrompt(env, cfg);
    case 'legv':
      return send(env, admin, '❌ Ləğv edildi.');
    case 'ay':
      if (rest) return applyMonth(env, rest);
      return promptAwait(env, 'month', '🗓 Yeni ayın adını yaz (məs: Noyabr).');
    case 'gun':
      if (parseInt(rest) > 0) return applyDays(env, cfg, parseInt(rest));
      return promptAwait(env, 'days', '🔢 Yarış <b>indidən</b> neçə gün davam etsin? Rəqəm yaz (məs: 30).');
    case 'uzat':
      if (parseInt(rest) > 0) return extend(env, cfg, parseInt(rest));
      return send(env, admin, 'Nümunə: /uzat 7');
    case 'bitme':
      if (rest) return applyDate(env, cfg, rest);
      return promptAwait(env, 'date', DATE_PROMPT);
    case 'avto':
      if (rest) return applyAuto(env, cfg, rest);
      return autoMenu(env, cfg);
    case 'xalsil':
    case 'xalver':
    case 'disk':
    case 'berpa': {
      if (rest) return userAction(env, cfg, name, rest);
      return promptAwait(env, name, ACTION_PROMPTS[name]);
    }
    default:
      return send(
        env,
        admin,
        '<b>Komandalar:</b>\n/admin — panel\n/siralama — sıralama\n/siyahi — iştirakçılar\n/baslat [gün]\n/stop — dayandır\n/davam — davam et\n/restart — hər şeyi sıfırla\n/bitir — qalibləri açıqla və bitir\n/ay Noyabr\n/gun 30 — indidən N gün\n/uzat 7 — N gün uzat\n/bitme 25.11.2026 18:00\n/avto 6 · /avto gunde 3 · /avto 0\n/xalsil UID [say] · /xalver UID say\n/disk UID · /berpa UID'
      );
  }
}

const DATE_PROMPT = '📅 Yarışın bitmə tarixini yaz (Bakı vaxtı ilə).\nFormat: <code>25.11.2026 18:00</code> və ya <code>2026-11-25 18:00</code>';
const ACTION_PROMPTS = {
  xalsil: '🗑 Xalı silinəcək istifadəçinin <b>UID</b> və ya <b>@username</b>-ni yaz.\nMüəyyən miqdar silmək üçün sonuna rəqəm əlavə et: <code>5461064199 10</code>',
  xalver: '➕ <b>UID</b> və ya <b>@username</b> və xal miqdarını yaz: <code>5461064199 10</code>',
  disk: '🚫 Yarışdan çıxarılacaq istifadəçinin <b>UID</b> və ya <b>@username</b>-ni yaz.',
  berpa: '♻️ Yarışa qaytarılacaq istifadəçinin <b>UID</b> və ya <b>@username</b>-ni yaz.',
};

async function promptAwait(env, type, text) {
  await setCfg(env, { pending: type });
  return send(env, ids(env).admin, text, { reply_markup: { inline_keyboard: CANCEL_KB } });
}

async function handleAwait(env, m, cfg) {
  const { admin, group } = ids(env);

  if (cfg.pending === 'winners') {
    // Admin nə yazıbsa, necə yazıbsa — olduğu kimi qrupa kopyalanır
    const r = await tg(env, 'copyMessage', { chat_id: group, from_chat_id: admin, message_id: m.message_id });
    if (!r.ok) {
      return send(env, admin, `⚠️ Qrupa göndərilə bilmədi: ${esc(r.description)}\nYenidən göndər və ya /legv yaz.`);
    }
    await setCfg(env, { status: 'ended', pending: '' });
    return send(env, admin, '✅ Qaliblər elanı qrupa göndərildi və yarış bitirildi.\nYeni yarış üçün /baslat yaz.');
  }

  const text = (m.text || '').trim();
  if (!text) return send(env, admin, '⚠️ Mətn göndər və ya /legv yaz.');
  await setCfg(env, { pending: '' });

  switch (cfg.pending) {
    case 'month':
      return applyMonth(env, text);
    case 'days': {
      const n = parseInt(text);
      if (!(n > 0)) return promptAwait(env, 'days', '⚠️ Düzgün rəqəm yaz (məs: 30).');
      return applyDays(env, cfg, n);
    }
    case 'date':
      return applyDate(env, cfg, text);
    case 'auto':
      return applyAuto(env, cfg, text);
    case 'xalsil':
    case 'xalver':
    case 'disk':
    case 'berpa':
      return userAction(env, cfg, cfg.pending, text);
  }
}

/* ------------------------------------------------------------------ */
/* Admin: panel və callback-lər                                        */
/* ------------------------------------------------------------------ */

const STATUS_LABEL = {
  none: '⚪ Yarış yoxdur',
  active: '🟢 Aktiv',
  paused: '🟡 Dayandırılıb',
  expired: '🟠 Müddət bitib (qalibləri açıqlamaq üçün /bitir)',
  ended: '🔴 Bitib',
};

async function statusText(env, cfg) {
  const s = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM participants WHERE gen = ?1 AND status = 'active') AS parts,
            (SELECT COUNT(*) FROM participants WHERE gen = ?1 AND status = 'dq') AS dqs,
            (SELECT COUNT(*) FROM invites WHERE approved = 1 AND left_flag = 0) AS ok,
            (SELECT COUNT(*) FROM invites WHERE approved = 0 AND left_flag = 0) AS wait`
  )
    .bind(cfg.gen)
    .first();
  const left = cfg.status === 'active' ? ` (qalıb: ${fmtLeft(cfg.end_ts - Date.now())})` : '';
  return (
    `🏆 <b>Khazar Crypto Dəvət Yarışması — Admin panel</b>\n\n` +
    `📌 Status: ${STATUS_LABEL[cfg.status] || cfg.status}\n` +
    `🗓 Ay: <b>${esc(cfg.month)}</b>\n` +
    `▶️ Başlama: ${fmtDate(cfg.start_ts)}\n` +
    `⏳ Bitmə: ${fmtDate(cfg.end_ts)}${left}\n` +
    `⏰ Avto sıralama: ${describeAuto(cfg.auto_minutes)}\n\n` +
    `👥 İştirakçı: <b>${s.parts}</b>  |  🚫 Diskvalifikasiya: <b>${s.dqs}</b>\n` +
    `✅ Təsdiqlənmiş dəvət: <b>${s.ok}</b>  |  ⏳ Gözləyən: <b>${s.wait}</b>`
  );
}

async function panel(env, cfg) {
  return send(env, ids(env).admin, await statusText(env, cfg), { reply_markup: { inline_keyboard: PANEL_KB } });
}

async function onCallback(env, cb) {
  const { admin } = ids(env);
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
  if (cb.from.id !== admin || !cb.message || cb.message.chat.type !== 'private') return;
  const cfg = await loadCfg(env);
  const [a, b] = String(cb.data || '').split(':');

  switch (a) {
    case 'panel':
      return panel(env, cfg);
    case 'sir':
      return send(env, admin, boardText(cfg, await rank(env, cfg.gen, 10, 'board')));
    case 'list':
      return send(env, admin, await listText(env, cfg));
    case 'start':
      return startFlow(env, cfg, '');
    case 'startd':
      return doStart(env, cfg, parseInt(b));
    case 'stop':
      return pauseContest(env, cfg);
    case 'resume':
      return resumeContest(env, cfg);
    case 'restart':
      return restartAsk(env);
    case 'rst':
      if (b === 'yes') return doRestart(env, cfg);
      return send(env, admin, '❌ Ləğv edildi.');
    case 'end':
      return endPrompt(env, cfg);
    case 'cancel':
      await setCfg(env, { pending: '' });
      return send(env, admin, '❌ Ləğv edildi.');
    case 'dur':
      return durMenu(env, cfg);
    case 'ext':
      return extend(env, cfg, parseInt(b));
    case 'durd':
      if (b === 'date') return promptAwait(env, 'date', DATE_PROMPT);
      return promptAwait(env, 'days', '🔢 Yarış <b>indidən</b> neçə gün davam etsin? Rəqəm yaz (məs: 30).');
    case 'month':
      return promptAwait(env, 'month', '🗓 Yeni ayın adını yaz (məs: Noyabr).\nSıralamadakı köhnə ay adı bununla əvəz olunacaq.');
    case 'auto':
      return autoMenu(env, cfg);
    case 'autoset':
      return setAutoMinutes(env, parseInt(b));
    case 'autotxt':
      return promptAwait(env, 'auto', '⏰ Yaz: <code>6</code> (hər 6 saatdan bir), <code>gunde 3</code> (gündə 3 dəfə) və ya <code>0</code> (söndür).');
    case 'delpts':
      return promptAwait(env, 'xalsil', ACTION_PROMPTS.xalsil);
    case 'dq':
      return promptAwait(env, 'disk', ACTION_PROMPTS.disk);
    case 'undq':
      return promptAwait(env, 'berpa', ACTION_PROMPTS.berpa);
  }
}

/* ------------------------------------------------------------------ */
/* Admin: yarış idarəsi                                                */
/* ------------------------------------------------------------------ */

async function startContest(env, cfg, days) {
  const now = Date.now();
  await env.DB.batch([env.DB.prepare('DELETE FROM invites'), env.DB.prepare('DELETE FROM msgs')]);
  await setCfg(env, {
    gen: cfg.gen + 1,
    status: 'active',
    start_ts: now,
    end_ts: now + days * DAY,
    duration_days: days,
    paused_at: 0,
    last_post_ts: now,
    pending: '',
  });
  return now + days * DAY;
}

async function startFlow(env, cfg, rest) {
  const { admin } = ids(env);
  if (['active', 'paused', 'expired'].includes(cfg.status)) {
    return send(env, admin, '⚠️ Yarış hələ bitməyib.\n🏁 /bitir ilə bitir, ya da 🔄 /restart ilə sıfırlayıb yenidən başlat.');
  }
  const days = parseInt(rest);
  if (days > 0) return doStart(env, cfg, days);
  return send(env, admin, '▶️ <b>Yeni yarış</b> neçə gün davam etsin?\n(Özün yazmaq üçün: <code>/baslat 45</code>)', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '7 gün', callback_data: 'startd:7' }, { text: '15 gün', callback_data: 'startd:15' }],
        [{ text: '30 gün', callback_data: 'startd:30' }, { text: '60 gün', callback_data: 'startd:60' }],
      ],
    },
  });
}

async function doStart(env, cfg, days) {
  const { admin } = ids(env);
  if (!(days > 0 && days <= 365)) return send(env, admin, '⚠️ Gün sayı 1–365 arası olmalıdır.');
  if (['active', 'paused', 'expired'].includes(cfg.status)) return send(env, admin, '⚠️ Yarış artıq davam edir.');
  const end = await startContest(env, cfg, days);
  return send(
    env,
    admin,
    `✅ <b>Yarış başladı!</b>\n⏳ Müddət: ${days} gün\n📅 Bitmə: ${fmtDate(end)}\n\nİstifadəçilər qrupda /link yazaraq şəxsi dəvət linki ala bilər.`
  );
}

async function pauseContest(env, cfg) {
  const { admin } = ids(env);
  if (cfg.status !== 'active') return send(env, admin, 'ℹ️ Yalnız aktiv yarışı dayandırmaq olar.');
  await setCfg(env, { status: 'paused', paused_at: Date.now() });
  return send(env, admin, '⏸ <b>Yarış dayandırıldı.</b> Dayandırma müddətində mesajlar və xallar sayılmır, bitmə vaxtı da donur.\nDavam etmək üçün /davam');
}

async function resumeContest(env, cfg) {
  const { admin } = ids(env);
  if (cfg.status !== 'paused') return send(env, admin, 'ℹ️ Yarış dayandırılmayıb.');
  const now = Date.now();
  const end = cfg.end_ts + Math.max(now - cfg.paused_at, 0);
  await setCfg(env, { status: 'active', paused_at: 0, end_ts: end, last_post_ts: now });
  return send(env, admin, `▶️ <b>Yarış davam edir.</b>\n📅 Yeni bitmə tarixi: ${fmtDate(end)}`);
}

async function restartAsk(env) {
  return send(env, ids(env).admin, '🔄 <b>Restart</b>\nBütün xallar, dəvətlər və diskvalifikasiyalar sıfırlanacaq, köhnə linklər keçərsiz olacaq və yarış yenidən başlayacaq. Əminsən?', {
    reply_markup: {
      inline_keyboard: [[{ text: '✅ Bəli, sıfırla', callback_data: 'rst:yes' }, { text: '❌ Xeyr', callback_data: 'rst:no' }]],
    },
  });
}

async function doRestart(env, cfg) {
  const days = cfg.duration_days > 0 ? cfg.duration_days : 30;
  const end = await startContest(env, cfg, days);
  return send(
    env,
    ids(env).admin,
    `🔄 <b>Yarış yenidən başladı!</b>\nHamının xalı sıfırlandı. Hər istifadəçi /link yazıb yeni dəvət linki alacaq (köhnə linklər xal vermir).\n⏳ ${days} gün · 📅 Bitmə: ${fmtDate(end)}`
  );
}

async function endPrompt(env, cfg) {
  const { admin } = ids(env);
  if (['none', 'ended'].includes(cfg.status)) return send(env, admin, 'ℹ️ Bitirilə biləcək aktiv yarış yoxdur.');
  const board = boardText(cfg, await rank(env, cfg.gen, 10, 'board'));
  await setCfg(env, { pending: 'winners' });
  return send(
    env,
    admin,
    `🏁 <b>Qalibləri açıqla</b>\n\nQrupa göndəriləcək qalib elanı mesajını indi yaz (kimlər qazandı, nə qədər mükafat və s.).\nMesaj <b>heç nə dəyişdirilmədən, olduğu kimi</b> qrupa göndəriləcək və yarış bitəcək.\n\n<i>Köməkçi — hazırkı sıralama:</i>\n${board}`,
    { reply_markup: { inline_keyboard: CANCEL_KB } }
  );
}

async function durMenu(env, cfg) {
  return send(
    env,
    ids(env).admin,
    `📅 <b>Yarışın bitmə tarixi</b>\nİndi: ${fmtDate(cfg.end_ts)}\n\nUzatmaq üçün seç və ya dəqiq tarix / gün sayı yaz:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ 7 gün', callback_data: 'ext:7' }, { text: '➕ 15 gün', callback_data: 'ext:15' }, { text: '➕ 30 gün', callback_data: 'ext:30' }],
          [{ text: '🗓 Dəqiq tarix yaz', callback_data: 'durd:date' }],
          [{ text: '🔢 İndidən N gün yaz', callback_data: 'durd:days' }],
        ],
      },
    }
  );
}

async function applyEnd(env, cfg, ts) {
  const { admin } = ids(env);
  if (!['active', 'expired'].includes(cfg.status)) {
    return send(env, admin, cfg.status === 'paused' ? '⚠️ Əvvəlcə /davam yaz, sonra tarixi dəyiş.' : 'ℹ️ Aktiv yarış yoxdur. Yeni yarış üçün /baslat');
  }
  if (!(ts > Date.now())) return send(env, admin, '⚠️ Tarix gələcəkdə olmalıdır.');
  await setCfg(env, { end_ts: ts, status: 'active' });
  return send(env, admin, `✅ Yarış <b>${fmtDate(ts)}</b> tarixinədək davam edəcək.\n⏳ Qalıb: ${fmtLeft(ts - Date.now())}`);
}

async function extend(env, cfg, days) {
  if (!(days > 0)) return;
  const base = Math.max(cfg.end_ts, Date.now());
  return applyEnd(env, cfg, base + days * DAY);
}

async function applyDays(env, cfg, days) {
  if (!(days > 0 && days <= 365)) return send(env, ids(env).admin, '⚠️ Gün sayı 1–365 arası olmalıdır.');
  await setCfg(env, { duration_days: days });
  return applyEnd(env, cfg, Date.now() + days * DAY);
}

async function applyDate(env, cfg, text) {
  const ts = parseDate(text);
  if (!ts) return promptAwait(env, 'date', '⚠️ Format səhvdir.\n' + DATE_PROMPT);
  return applyEnd(env, cfg, ts);
}

async function applyMonth(env, text) {
  const month = text.trim().slice(0, 30);
  await setCfg(env, { month, pending: '' });
  return send(env, ids(env).admin, `✅ Sıralamada ay adı dəyişdi: <b>${esc(month)}</b>\n(TOP 10 — ${esc(month)} Dəvət Yarışı)`);
}

async function autoMenu(env, cfg) {
  return send(env, ids(env).admin, `⏰ <b>Avtomatik sıralama</b>\nİndi: ${describeAuto(cfg.auto_minutes)}\n\nQrupa neçə saatdan bir sıralama göndərilsin?`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Hər 1 saat', callback_data: 'autoset:60' }, { text: 'Hər 3 saat', callback_data: 'autoset:180' }, { text: 'Hər 6 saat', callback_data: 'autoset:360' }],
        [{ text: 'Hər 12 saat', callback_data: 'autoset:720' }, { text: 'Gündə 1 dəfə', callback_data: 'autoset:1440' }],
        [{ text: '✍️ Özüm yazım', callback_data: 'autotxt' }, { text: '🔕 Söndür', callback_data: 'autoset:0' }],
      ],
    },
  });
}

async function setAutoMinutes(env, min) {
  await setCfg(env, { auto_minutes: min, last_post_ts: Date.now() });
  return send(env, ids(env).admin, `✅ Avtomatik sıralama: <b>${describeAuto(min)}</b>`);
}

async function applyAuto(env, cfg, text) {
  const min = parseAuto(text);
  if (min === null) return promptAwait(env, 'auto', '⚠️ Başa düşmədim. Nümunə: <code>6</code>, <code>gunde 3</code>, <code>0</code>');
  return setAutoMinutes(env, min);
}

/* ------------------------------------------------------------------ */
/* Admin: istifadəçi əməliyyatları (xal sil / diskvalifikasiya)        */
/* ------------------------------------------------------------------ */

async function findTarget(env, gen, q, create) {
  q = String(q).replace(/^@/, '');
  let p;
  if (/^\d+$/.test(q)) {
    p = await env.DB.prepare('SELECT * FROM participants WHERE user_id = ? AND gen = ?').bind(+q, gen).first();
    if (!p && create) {
      await env.DB.prepare(
        `INSERT INTO participants(user_id, first_name, invite_link, gen, status, adj, created_at) VALUES(?, ?, NULL, ?, 'dq', 0, ?)
         ON CONFLICT(user_id) DO UPDATE SET gen = excluded.gen, status = 'dq', adj = 0, invite_link = NULL`
      )
        .bind(+q, 'ID ' + q, gen, Date.now())
        .run();
      p = await env.DB.prepare('SELECT * FROM participants WHERE user_id = ?').bind(+q).first();
    }
  } else {
    p = await env.DB.prepare('SELECT * FROM participants WHERE LOWER(username) = LOWER(?) AND gen = ?').bind(q, gen).first();
  }
  return p;
}

async function userAction(env, cfg, type, text) {
  const { admin, group } = ids(env);
  const tokens = text.trim().split(/\s+/);
  const p = await findTarget(env, cfg.gen, tokens[0], type === 'disk');
  if (!p) return send(env, admin, '⚠️ İstifadəçi tapılmadı (yalnız bu yarışda /link almış istifadəçilər tapılır). UID ilə yoxla.');
  const name = displayName(p);
  const num = tokens[1] !== undefined ? parseInt(tokens[1]) : NaN;

  if (type === 'disk') {
    if (p.invite_link) await tg(env, 'revokeChatInviteLink', { chat_id: group, invite_link: p.invite_link });
    await env.DB.prepare("UPDATE participants SET status = 'dq', invite_link = NULL WHERE user_id = ?").bind(p.user_id).run();
    return send(env, admin, `🚫 ${name} (<code>${p.user_id}</code>) yarışdan diskvalifikasiya edildi. Sıralamadan çıxarıldı və linki ləğv olundu.`);
  }

  if (type === 'berpa') {
    await env.DB.prepare("UPDATE participants SET status = 'active' WHERE user_id = ?").bind(p.user_id).run();
    return send(env, admin, `♻️ ${name} yarışa qaytarıldı. Yeni dəvət linki üçün qrupda /link yazmalıdır.`);
  }

  if (type === 'xalver') {
    if (!(num > 0)) return send(env, admin, '⚠️ Xal miqdarını yaz. Nümunə: /xalver 5461064199 10');
    await env.DB.prepare('UPDATE participants SET adj = adj + ? WHERE user_id = ?').bind(num, p.user_id).run();
    return send(env, admin, `➕ ${name} üçün ${num} xal əlavə olundu.`);
  }

  // xalsil
  const s = await userStats(env, cfg.gen, p.user_id);
  const cur = Math.max(s.ok * PPI + s.adj, 0);
  const amount = num > 0 ? Math.min(num, cur) : cur;
  await env.DB.prepare('UPDATE participants SET adj = adj - ? WHERE user_id = ?').bind(amount, p.user_id).run();
  return send(env, admin, `🗑 ${name} istifadəçisindən <b>${amount}</b> xal silindi. Qalan xal: <b>${cur - amount}</b>`);
}
