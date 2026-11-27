'use strict';

/*
 * 星火聊天室 · 后端 API（Express）
 *
 * 职责：把原来写在前端的业务逻辑搬到服务端——注册、登录、发消息、删消息、加好友。
 *       前端只调 HTTP 接口，校验、归属判断、身份认证都在这里做。
 *
 * 身份认证：登录/注册成功后签发 token（uid + HMAC 签名），后续请求带
 *   Authorization: Bearer <token>
 *   服务端据此确定"你是谁"，不再相信前端传来的 uid，冒充他人发消息会被拒。
 *
 * 存储两种驱动（DB_DRIVER）：
 *   file      —— 本地 JSON 文件，本机开发调试用
 *   cloudbase —— 腾讯云开发云数据库，云托管部署用（容器重启不丢）
 *
 * 云数据库沿用集合 chat_messages，靠 kind 区分记录：
 *   kind='profile'  账号目录     kind='social'  好友关系事件流    其他  聊天消息
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '80', 10);
const COLLECTION = process.env.COLLECTION || 'chat_messages';
const DRIVER_RAW = process.env.DB_DRIVER || (process.env.TCB_ENV ? 'cloudbase' : 'file');
// 云驱动必须有 TCB_ENV，否则读写会静默失败（注册/发消息直接 500），自动回退文件模式并告警
const DRIVER = DRIVER_RAW === 'cloudbase' && !process.env.TCB_ENV ? 'file' : DRIVER_RAW;
if (DRIVER_RAW === 'cloudbase' && DRIVER === 'file') {
  console.warn('[警告] 未配置 TCB_ENV，已从云数据库回退到本地文件模式（容器重启后数据会丢失）');
}
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'chatroom-demo-secret';
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;   // 30 天

/* 前端页面目录：容器里是 /app/public（Dockerfile 拷进来的），本地开发是仓库根目录。
   —— 这样同一个服务既给页面又给 API，云托管一次部署即可，不需要静态网站托管。 */
const WEB_ROOT = (() => {
  const candidates = [
    process.env.WEB_ROOT,
    path.join(__dirname, 'public'),
    path.join(__dirname, '..')
  ].filter(Boolean);
  for (const dir of candidates) {
    try { if (fs.existsSync(path.join(dir, 'index.html'))) return dir; } catch (e) { /* 忽略 */ }
  }
  return path.join(__dirname, 'public');
})();

/* ===================== 工具（hash 与前端保持同一算法） ===================== */

function hash(s) {
  let h = 5381;
  s = 'sp@' + String(s);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(36);
}

function idFromName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return 'u_' + Math.abs(h).toString(36);
}

function uid(prefix) {
  return (prefix || 'u_') + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function nowISO() {
  return new Date().toISOString();
}

function str(v, max) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return max && s.length > max ? s.slice(0, max) : s;
}

/* ===================== token 签发与校验 ===================== */

function sign(uidv) {
  const body = uidv + '.' + Date.now();
  const mac = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uidv, ts, mac] = parts;
  const body = uidv + '.' + ts;
  const expect = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  if (mac.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  if (Date.now() - Number(ts) > TOKEN_TTL_MS) return null;
  return uidv;
}

/* 从请求头取当前登录身份；没有或无效返回 null */
function currentUser(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? verify(m[1].trim()) : null;
}

/* ===================== 存储驱动 ===================== */

function fileDriver() {
  const FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  let docs = [];
  try { docs = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { docs = []; }
  if (!Array.isArray(docs)) docs = [];
  const flush = () => fs.writeFileSync(FILE, JSON.stringify(docs));
  return {
    name: 'file',
    file: FILE,
    load: () => Promise.resolve(docs.slice()),
    append: (doc) => { docs.push(doc); flush(); return Promise.resolve(); },
    removeByMid: (mid) => { docs = docs.filter((d) => d.mid !== mid); flush(); return Promise.resolve(); }
  };
}

function cloudbaseDriver() {
  const tcb = require('@cloudbase/node-sdk');
  const opts = { env: process.env.TCB_ENV };
  if (process.env.SECRETID && process.env.SECRETKEY) {
    opts.secretId = process.env.SECRETID;
    opts.secretKey = process.env.SECRETKEY;
    if (process.env.SESSIONTOKEN) opts.sessionToken = process.env.SESSIONTOKEN;
  }
  const app = tcb.init(opts);
  const col = app.database().collection(COLLECTION);
  return {
    name: 'cloudbase',
    env: process.env.TCB_ENV,
    load: () => col.limit(1000).get().then((r) => r.data || []).catch((e) => {
      console.error('[cloudbase] 读取失败：', e && (e.message || e));
      return [];
    }),
    append: (doc) => col.add(doc).catch((e) => {
      console.error('[cloudbase] 写入失败：', e && (e.message || e));
      throw e;
    }),
    removeByMid: (mid) => col.where({ mid }).remove().catch((e) => {
      console.error('[cloudbase] 删除失败：', e && (e.message || e));
      throw e;
    })
  };
}

/* ===================== 内存状态 ===================== */

const state = {
  users: {},      // key(小写账号) -> {uid, username, nickname, pass, createdAt}
  messages: [],
  events: [],
  social: { requests: [], friends: [] }
};

let driver = null;

function pairMatch(f, a, b) {
  return (f.a === a && f.b === b) || (f.a === b && f.b === a);
}

function isFriendIn(list, a, b) {
  return list.some((f) => pairMatch(f, a, b));
}

function isFriend(a, b) {
  return isFriendIn(state.social.friends, a, b);
}

function pendingRequest(from, to) {
  return state.social.requests.filter((r) => r.from === from && r.to === to && r.status === 'pending')[0];
}

/* 好友关系是 append-only 事件流，重放出「申请列表 + 好友列表」 */
function rebuildSocial() {
  const requests = [];
  const byId = {};
  const friends = [];

  for (const ev of state.events) {
    if (ev.act === 'request') {
      if (byId[ev.reqId]) continue;
      const r = {
        id: ev.reqId, from: ev.from, fromName: ev.fromName || ev.from,
        to: ev.to, toName: ev.toName || ev.to,
        status: 'pending', createdAt: ev.createdAt || nowISO()
      };
      requests.push(r);
      byId[r.id] = r;
    } else if (ev.act === 'accept' || ev.act === 'reject') {
      const r = byId[ev.reqId];
      if (!r) continue;
      r.status = ev.act === 'accept' ? 'accepted' : 'rejected';
      if (ev.act === 'accept' && !isFriendIn(friends, r.from, r.to)) {
        friends.push({ a: r.from, b: r.to, aName: r.fromName, bName: r.toName, createdAt: ev.createdAt || nowISO() });
      }
    } else if (ev.act === 'remove') {
      for (let i = friends.length - 1; i >= 0; i--) {
        if (pairMatch(friends[i], ev.a, ev.b)) friends.splice(i, 1);
      }
      for (let i = requests.length - 1; i >= 0; i--) {
        const r = requests[i];
        if ((r.from === ev.a && r.to === ev.b) || (r.from === ev.b && r.to === ev.a)) {
          delete byId[r.id];
          requests.splice(i, 1);
        }
      }
    }
  }
  state.social = { requests, friends };
}

function publicUser(u) {
  return { uid: u.uid, username: u.username, nickname: u.nickname, createdAt: u.createdAt };
}

function meOf(u) {
  return { id: idFromName(u.uid), username: u.uid, uid: u.uid, nickname: u.nickname, token: sign(u.uid) };
}

function absorb(docs) {
  state.users = {};
  state.messages = [];
  state.events = [];
  for (const d of docs) {
    if (!d) continue;
    if (d.kind === 'profile' && d.uid) {
      state.users[d.uid] = {
        uid: d.uid, username: d.username || d.uid, nickname: d.nickname || d.uid,
        pass: d.pass || '', createdAt: d.createdAt || ''
      };
    } else if (d.kind === 'social') {
      state.events.push(d);
    } else {
      state.messages.push(d);
    }
  }
  const byTime = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  state.events.sort(byTime);
  state.messages.sort(byTime);
  rebuildSocial();
}

function reload() {
  return driver.load().then((docs) => { absorb(docs); });
}

/* ===================== HTTP 层 ===================== */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const fail = (res, code, error) => res.status(code).json({ ok: false, error });

/* 健康检查：部署后先打这个确认容器活着、连的是哪个存储 */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    driver: driver.name,
    collection: COLLECTION,
    users: Object.keys(state.users).length,
    messages: state.messages.length,
    uptime: Math.round(process.uptime())
  });
});

/* 注册 */
app.post('/api/register', async (req, res) => {
  try {
    const account = str(req.body.account, 32).trim();
    const password = String(req.body.password || '');
    const nickname = str(req.body.nickname, 24).trim();
    if (!account) return fail(res, 400, '请输入账号');
    if (!/^[A-Za-z0-9_@.\-]{2,32}$/.test(account)) return fail(res, 400, '账号只能是字母、数字、下划线，2~32 位');
    if (password.length < 4) return fail(res, 400, '密码至少 4 位');

    const key = account.toLowerCase();
    if (state.users[key]) return fail(res, 409, '该账号已存在，请直接登录');

    const user = {
      uid: key, username: account, nickname: nickname || account,
      pass: hash(password), createdAt: nowISO()
    };
    await driver.append({
      mid: uid(), kind: 'profile',
      uid: user.uid, username: user.username, nickname: user.nickname,
      pass: user.pass, createdAt: user.createdAt
    });
    state.users[key] = user;
    console.log('[register]', key, '|', user.nickname);
    ok(res, { me: meOf(user) });
  } catch (e) {
    console.error('[register] 失败', e);
    fail(res, 500, '注册失败，请稍后重试');
  }
});

/* 登录：密码比对在服务端完成，前端拿不到任何哈希 */
app.post('/api/login', async (req, res) => {
  try {
    const account = str(req.body.account, 32).trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!account) return fail(res, 400, '请输入账号');
    if (password.length < 4) return fail(res, 400, '密码至少 4 位');

    const u = state.users[account];
    if (!u) return fail(res, 404, '账号不存在，请先注册');
    if (u.pass !== hash(password)) return fail(res, 401, '密码错误，请重试');
    ok(res, { me: meOf(u) });
  } catch (e) {
    console.error('[login] 失败', e);
    fail(res, 500, '登录失败，请稍后重试');
  }
});

/* 全量同步：账号目录 + 我相关的好友关系 + 消息 */
app.get('/api/sync', (req, res) => {
  const me = currentUser(req) || str(req.query.uid, 32).toLowerCase();
  const users = Object.keys(state.users).map((k) => publicUser(state.users[k]));   // 不含密码哈希
  const social = {
    requests: state.social.requests.filter((r) => !me || r.to === me || r.from === me),
    friends: state.social.friends.filter((f) => !me || f.a === me || f.b === me)
  };
  ok(res, { users, social, messages: state.messages, me: me || '' });
});

app.get('/api/messages', (req, res) => {
  ok(res, { messages: state.messages });
});

/* 发消息：ownerUid 以 token 为准，不信前端自报；system/ai 消息由服务端放行 */
app.post('/api/messages', async (req, res) => {
  try {
    const b = req.body || {};
    const me = currentUser(req);
    const kind = ['user', 'ai', 'system'].includes(b.kind) ? b.kind : 'user';

    if (!me && kind === 'user') return fail(res, 401, '登录状态已失效，请重新登录');
    if (!b.content && !b.image && !b.file && !b.audio && !b.sticker) {
      return fail(res, 400, '消息内容为空');
    }

    const ownerUid = kind === 'user' ? me : str(b.ownerUid, 32).toLowerCase();
    const owner = state.users[ownerUid];

    const msg = {
      mid: str(b.mid, 48) || uid(),
      ownerId: kind === 'user' ? idFromName(ownerUid) : str(b.ownerId, 64),
      ownerUid,
      // 用户消息的昵称以账号表为准，避免前端自报昵称冒充
      ownerName: kind === 'user' ? (owner ? owner.nickname : ownerUid) : str(b.ownerName, 32),
      content: str(b.content, 4000),
      kind,
      createdAt: str(b.createdAt, 40) || nowISO()
    };
    if (b.scope) msg.scope = str(b.scope, 16);
    if (b.sticker) msg.sticker = str(b.sticker, 32);
    if (b.image && /^data:image\//.test(b.image)) msg.image = b.image;
    if (b.audio && b.audio.data && /^data:audio\//.test(b.audio.data)) {
      msg.audio = { data: b.audio.data, dur: Number(b.audio.dur) || 0, mime: str(b.audio.mime, 40), bytes: Number(b.audio.bytes) || 0 };
    }
    if (b.file && b.file.data && /^data:/.test(b.file.data)) {
      msg.file = { name: str(b.file.name, 120), size: Number(b.file.size) || 0, type: str(b.file.type, 80), data: b.file.data };
    }
    if (b.dm && b.toUid) {
      msg.dm = true;
      msg.toUid = str(b.toUid, 32).toLowerCase();
      msg.toName = str(b.toName, 32);
    }

    await driver.append(Object.assign({}, msg));
    state.messages.push(msg);
    ok(res, { mid: msg.mid });
  } catch (e) {
    console.error('[messages] 写入失败', e);
    fail(res, 500, '发送失败，请稍后重试');
  }
});

/* 删消息：归属由服务端判定，删别人的会被 403 */
app.delete('/api/messages/:mid', async (req, res) => {
  try {
    const mid = str(req.params.mid, 48);
    const me = currentUser(req);
    if (!me) return fail(res, 401, '登录状态已失效，请重新登录');

    const target = state.messages.filter((m) => m.mid === mid)[0];
    if (!target) return fail(res, 404, '消息不存在');
    if (target.kind === 'system') return fail(res, 403, '系统消息不能删除');
    if (target.ownerUid && target.ownerUid !== me) return fail(res, 403, '只能删除自己的消息');

    await driver.removeByMid(mid);
    state.messages = state.messages.filter((m) => m.mid !== mid);
    ok(res, { mid });
  } catch (e) {
    console.error('[messages] 删除失败', e);
    fail(res, 500, '删除失败，请稍后重试');
  }
});

/* 发好友申请；对方已向我申请过则直接互加 */
app.post('/api/friends/request', async (req, res) => {
  try {
    const b = req.body || {};
    const me = currentUser(req);
    if (!me) return fail(res, 401, '登录状态已失效，请重新登录');

    const to = str(b.to, 32).toLowerCase();
    if (!to) return fail(res, 400, '缺少对方账号');
    if (me === to) return fail(res, 400, '不能加自己为好友');
    if (!state.users[to]) return fail(res, 404, '对方账号不存在');
    if (isFriend(me, to)) return fail(res, 409, '对方已经是你的好友了');
    if (pendingRequest(me, to)) return fail(res, 409, '申请已发出，等待对方同意');

    const reverse = pendingRequest(to, me);
    const ev = reverse
      ? { mid: uid(), kind: 'social', act: 'accept', reqId: reverse.id, from: me, to: reverse.from, createdAt: nowISO() }
      : {
        mid: uid(), kind: 'social', act: 'request', reqId: uid('r_'),
        from: me, fromName: state.users[me] ? state.users[me].nickname : me,
        to, toName: state.users[to].nickname, createdAt: nowISO()
      };
    await driver.append(ev);
    state.events.push(ev);
    rebuildSocial();
    ok(res, { auto: !!reverse });
  } catch (e) {
    console.error('[friends] 申请失败', e);
    fail(res, 500, '申请失败，请稍后重试');
  }
});

/* 同意 / 拒绝申请：只有接收人能处理 */
app.post('/api/friends/respond', async (req, res) => {
  try {
    const b = req.body || {};
    const me = currentUser(req);
    if (!me) return fail(res, 401, '登录状态已失效，请重新登录');

    const reqId = str(b.reqId, 48);
    const accept = !!b.accept;
    const r = state.social.requests.filter((x) => x.id === reqId)[0];
    if (!r) return fail(res, 404, '申请不存在');
    if (r.to !== me) return fail(res, 403, '这条申请不是发给你的');
    if (r.status !== 'pending') return fail(res, 409, '这条申请已处理过');

    const ev = {
      mid: uid(), kind: 'social', act: accept ? 'accept' : 'reject',
      reqId, from: me, to: r.from, createdAt: nowISO()
    };
    await driver.append(ev);
    state.events.push(ev);
    rebuildSocial();
    ok(res, {});
  } catch (e) {
    console.error('[friends] 处理申请失败', e);
    fail(res, 500, '操作失败，请稍后重试');
  }
});

/* 删除好友（同时清掉双方的申请记录） */
app.post('/api/friends/remove', async (req, res) => {
  try {
    const b = req.body || {};
    const me = currentUser(req);
    if (!me) return fail(res, 401, '登录状态已失效，请重新登录');

    const peer = str(b.peer, 32).toLowerCase();
    if (!peer) return fail(res, 400, '缺少对方账号');
    const ev = { mid: uid(), kind: 'social', act: 'remove', a: me, b: peer, createdAt: nowISO() };
    await driver.append(ev);
    state.events.push(ev);
    rebuildSocial();
    ok(res, {});
  } catch (e) {
    console.error('[friends] 删除失败', e);
    fail(res, 500, '删除失败，请稍后重试');
  }
});

/* ===================== 前端页面（与 API 同源） =====================
   放在所有 /api 路由之后：接口优先，静态文件兜底，互不抢路径。
   好处是同源，浏览器不发跨域预检，前端自动探测到同源 /api 就走后端模式。 */

app.use(express.static(WEB_ROOT, {
  index: 'index.html',
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    // 页面本身不缓存，改完刷新就能看到新版；图片等资源可以缓存
    if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use('/api', (req, res) => fail(res, 404, '接口不存在：' + req.method + ' ' + req.originalUrl));

// 其余路径回到首页（前端是单页应用）
app.get('*', (req, res) => {
  const home = path.join(WEB_ROOT, 'index.html');
  if (fs.existsSync(home)) return res.sendFile(home);
  res.status(404).type('text/plain; charset=utf-8').send('前端页面未打包进镜像：请检查 Dockerfile 是否 COPY 了 index.html');
});

app.use((err, req, res, next) => {
  console.error('[unhandled]', err && (err.stack || err.message || err));
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: '服务端异常' });
});

/* ===================== 启动 ===================== */

async function main() {
  try {
    driver = DRIVER === 'cloudbase' ? cloudbaseDriver() : fileDriver();
  } catch (e) {
    console.error('存储驱动初始化失败，退回文件模式：', e && (e.message || e));
    driver = fileDriver();
  }
  await reload();

  app.listen(PORT, '0.0.0.0', () => {
    console.log('星火聊天室后端已启动');
    console.log('  端口     :', PORT);
    console.log('  存储驱动 :', driver.name + (driver.file ? ' -> ' + driver.file : ''));
    console.log('  集合     :', COLLECTION);
    console.log('  前端目录 :', WEB_ROOT, fs.existsSync(path.join(WEB_ROOT, 'index.html')) ? '(已托管)' : '(缺少 index.html，仅提供 API)');
    console.log('  账号数   :', Object.keys(state.users).length, ' 消息数:', state.messages.length);
  });
}

main().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
