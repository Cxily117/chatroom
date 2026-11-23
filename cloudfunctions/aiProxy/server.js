'use strict';

/*
 * Web 函数 HTTP 桥接层
 * scf_bootstrap 启动本文件，监听 9000 端口；
 * 收到 HTTP 请求后转成 event 交给 index.js 的 exports.main 处理，
 * 再把 {statusCode, headers, body} 写回 HTTP 响应。
 * index.js 的业务逻辑一行都不用改。
 */

var http = require('http');
var proxy = require('./index');

var PORT = parseInt(process.env.PORT || '9000', 10);

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS));
    return res.end('{"ok":true}');
  }

  var chunks = '';
  req.on('data', function (c) { chunks += c; });
  req.on('end', function () {
    var event = { httpMethod: req.method, body: chunks, headers: req.headers };
    Promise.resolve(proxy.main(event)).then(function (r) {
      r = r || { statusCode: 200, headers: {}, body: '{}' };
      var headers = Object.assign({}, r.headers || {}, CORS);
      res.writeHead(r.statusCode || 200, headers);
      res.end(r.body || '');
    }).catch(function (e) {
      console.error('[aiProxy] server error', e && e.message);
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS));
      res.end(JSON.stringify({ ok: false, error: (e && e.message) || 'server error' }));
    });
  });
}).listen(PORT, '0.0.0.0', function () {
  console.log('[aiProxy] listening on ' + PORT);
});
