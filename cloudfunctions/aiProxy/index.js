'use strict';

/*
 * aiProxy —— 星火聊天室 · 扣子智能体代理云函数
 *
 * 作用：前端把问题发到本云函数，云函数在服务端带鉴权调用扣子，
 *       拿到答案后返回给前端。API Token 只存在环境变量里，不进浏览器。
 *
 * 环境变量（在云函数控制台配置）：
 *   COZE_API_TOKEN   必填  扣子后台创建的 API Token（永久有效）
 *   COZE_PROJECT_ID  必填  扣子部署详情页的 project_id
 *   COZE_DOMAIN      必填  扣子部署域名，例如 rv7jgzjmd.coze.site（不带 https://）
 *   COZE_TIMEOUT_MS  可选  最长等待毫秒数，默认 30000
 *   COZE_POLL_MS     可选  轮询间隔毫秒数，默认 1000（扣子要求至少 1 秒）
 *
 * 请求（POST，HTTP 访问服务触发）：
 *   { "question": "来个话题", "userId": "u_ab12cd34" }
 *
 * 响应：
 *   成功 { "ok": true,  "answer": "……" }
 *   失败 { "ok": false, "error": "……" }
 */

var https = require('https');

var TOKEN  = process.env.COZE_API_TOKEN  || '';
var PID    = process.env.COZE_PROJECT_ID || '';
var DOMAIN = (process.env.COZE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
var TIMEOUT = parseInt(process.env.COZE_TIMEOUT_MS || '30000', 10);
var POLL_MS = parseInt(process.env.COZE_POLL_MS || '1000', 10);

if (POLL_MS < 1000) POLL_MS = 1000;

function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store'
  };
}

function reply(statusCode, obj) {
  return { statusCode: statusCode, headers: corsHeaders(), body: JSON.stringify(obj) };
}

/* 原生 https 请求，返回 Promise<{status, data}> */
function request(options, bodyString) {
  return new Promise(function (resolve, reject) {
    var req = https.request(options, function (res) {
      var chunks = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () {
        var parsed;
        try { parsed = JSON.parse(chunks); }
        catch (e) { return reject(new Error('扣子返回非 JSON：' + chunks.slice(0, 200))); }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, function () { req.destroy(new Error('请求扣子超时')); });
    if (bodyString) req.write(bodyString);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/* 把对话历史 + 当前问题拼成一次请求文本。
   这个扣子应用的 async_run 不按 session_id 维护上下文，因此由我们显式把历史带进去。 */
function buildPrompt(question, history) {
  var h = Array.isArray(history) ? history.slice(-12) : [];
  if (!h.length) return String(question);
  var lines = [];
  for (var i = 0; i < h.length; i++) {
    var item = h[i] || {};
    var role = item.role === 'assistant' ? '小星' : '我';
    lines.push(role + '：' + String(item.content || '').replace(/\s+/g, ' ').slice(0, 300));
  }
  return '下面是之前聊过的几句话，请参考它们继续对话（不要重复别人的问句）：\n'
    + lines.join('\n')
    + '\n\n现在我说：' + String(question);
}

/* 发起异步任务，返回 task_id */
function startTask(question, sessionId, history) {
  if (!DOMAIN || !TOKEN || !PID) {
    return Promise.reject(new Error('云函数环境变量未配置完整（COZE_DOMAIN / COZE_API_TOKEN / COZE_PROJECT_ID）'));
  }

  // project_id 是 19 位大整数，超过 JS 安全整数范围，不能 parseInt，
  // 否则末位精度丢失。这里手工拼接，让它在 JSON 里保持裸数字字面量。
  if (!/^\d+$/.test(PID)) {
    return Promise.reject(new Error('COZE_PROJECT_ID 应为纯数字，当前值：' + PID));
  }
  var prompt = buildPrompt(question, history);
  var body = '{"content":{"query":{"prompt":[{"type":"text","content":{"text":'
    + JSON.stringify(prompt)
    + '}}]}},"type":"query","session_id":'
    + JSON.stringify(sessionId)
    + ',"project_id":' + PID + '}';

  return request({
    hostname: DOMAIN,
    path: '/async_run',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body).then(function (res) {
    if (res.status < 200 || res.status >= 300) {
      throw new Error('扣子发起任务失败 HTTP ' + res.status + '：' + JSON.stringify(res.data).slice(0, 200));
    }
    if (!res.data.task_id) {
      throw new Error('扣子未返回 task_id：' + JSON.stringify(res.data).slice(0, 200));
    }
    return res.data.task_id;
  });
}

/* 从扣子 result 中递归提取答案文本，兼容多种返回结构 */
function extractAnswer(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw.trim() ? raw.trim() : null;
  if (Array.isArray(raw)) {
    var parts = [];
    for (var i = 0; i < raw.length; i++) {
      var v = extractAnswer(raw[i]);
      if (v) parts.push(v);
    }
    return parts.length ? parts.join('') : null;
  }
  if (typeof raw === 'object') {
    var prefer = ['answer', 'content', 'text', 'output', 'response', 'result', 'answer_text', 'message'];
    for (var p = 0; p < prefer.length; p++) {
      if (raw[prefer[p]] !== null && raw[prefer[p]] !== undefined) {
        var got = extractAnswer(raw[prefer[p]]);
        if (got) return got;
      }
    }
    for (var k in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, k)) {
        var g = extractAnswer(raw[k]);
        if (g) return g;
      }
    }
  }
  return null;
}

/* 轮询任务状态，直到 completed */
function waitResult(taskId) {
  var deadline = Date.now() + TIMEOUT;

  function poll() {
    if (Date.now() > deadline) throw new Error('等待扣子回复超时（' + TIMEOUT + 'ms）');

    return request({
      hostname: DOMAIN,
      path: '/task/' + encodeURIComponent(taskId),
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + TOKEN }
    }).then(function (res) {
      var d = res.data || {};
      if (d.status === 'completed') {
        var raw = d.result;
        if (typeof raw === 'string') {
          try { raw = JSON.parse(raw); } catch (e) { /* 纯文本直接返回 */ }
        }
        var ans = extractAnswer(raw);
        if (!ans) {
          // 带出原始结果片段，便于定位扣子实际返回结构（不泄露 token）
          throw new Error('扣子返回了空答案；原始 result 片段：' + JSON.stringify(d.result).slice(0, 400));
        }
        return String(ans);
      }
      if (d.status === 'failed' || d.status === 'timeout') {
        throw new Error('扣子任务 ' + d.status + '：' + (d.error || '无错误信息'));
      }
      return sleep(POLL_MS).then(poll);
    });
  }

  return sleep(POLL_MS).then(poll);
}

/* 清洗答案：扣子有时会把用户问句回显在答案前面，这里去掉。
   只处理「答案以问题开头」这一种确定情况，避免误伤正常回复。 */
function cleanAnswer(answer, question) {
  var a = String(answer || '').trim();
  var q = String(question || '').trim();
  if (q && a.indexOf(q) === 0) {
    var rest = a.slice(q.length).trim();
    if (rest) return rest; // 去掉回显的问句，保留后面真正的回答
  }
  return a;
}

/* 云函数入口 */
exports.main = function (event) {
  // 预检请求
  if (event && event.httpMethod === 'OPTIONS') {
    return Promise.resolve(reply(200, { ok: true }));
  }

  try {
    var payload = event.body;
    if (typeof payload === 'string') payload = JSON.parse(payload);
    payload = payload || {};

    var question = String(payload.question || '').trim();
    if (!question) return Promise.resolve(reply(400, { ok: false, error: '问题为空' }));

    var sessionId = String(payload.userId || 'guest').slice(0, 64);
    var history = Array.isArray(payload.history) ? payload.history : [];

    return startTask(question, sessionId, history)
      .then(waitResult)
      .then(function (answer) {
        var cleaned = cleanAnswer(answer, question);
        console.log('[aiProxy] OK session=' + sessionId + ' len=' + cleaned.length);
        return reply(200, { ok: true, answer: cleaned });
      })
      .catch(function (err) {
        console.error('[aiProxy] ERROR', err && err.message);
        return reply(200, { ok: false, error: (err && err.message) || '未知错误' });
      });
  } catch (e) {
    return Promise.resolve(reply(400, { ok: false, error: '请求格式错误：' + e.message }));
  }
};
