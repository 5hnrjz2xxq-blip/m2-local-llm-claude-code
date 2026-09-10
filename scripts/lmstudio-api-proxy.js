#!/usr/bin/env node
/**
 * LM Studio <-> Claude Code 兼容代理（生产版）
 * 1. 转换 Claude Code 请求体以兼容 LM Studio 的 /v1/messages
 * 2. 强制流式、注入 reasoningBudget、扁平化 content、剔除不支持字段
 */
const http = require('http');

const UPSTREAM = { host: '127.0.0.1', port: 1234 };
const LISTEN_PORT = 1235;
const REASONING_BUDGET = 500;

function transformBody(bodyStr) {
  try {
    const data = JSON.parse(bodyStr);
    const removeCC = (obj) => {
      if (Array.isArray(obj)) return obj.map(removeCC);
      if (obj && typeof obj === 'object') {
        const r = {};
        for (const [k, v] of Object.entries(obj)) if (k !== 'cache_control') r[k] = removeCC(v);
        return r;
      }
      return obj;
    };
    let d = removeCC(data);
    for (const f of ['thinking', 'context_management', 'output_config', 'metadata']) delete d[f];
    d.stream = true;
    d.reasoningBudget = REASONING_BUDGET;
    const flatten = (c) => {
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(b => typeof b === 'string' ? b : (b && b.type === 'text' && b.text ? b.text : '')).filter(Boolean).join('\n');
      return String(c || '');
    };
    if (d.system !== undefined) d.system = flatten(d.system);
    if (Array.isArray(d.messages)) {
      d.messages = d.messages.filter(m => m.role !== 'system').map(m => ({ ...m, content: flatten(m.content) }));
    }
    return JSON.stringify(d);
  } catch (e) { return bodyStr; }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    if (req.method === 'POST' && req.url.startsWith('/v1/messages') && body.length > 0) {
      body = Buffer.from(transformBody(body.toString('utf-8')));
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'content-length' || lk === 'accept-encoding' || lk === 'anthropic-beta') continue;
      headers[k] = v;
    }
    headers['Content-Length'] = body.length;
    headers['Connection'] = 'close';
    const url = req.url.split('?')[0];
    const upstreamReq = http.request({ ...UPSTREAM, method: req.method, path: url, headers, timeout: 600000 }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.on('data', c => res.write(c));
      upstreamRes.on('end', () => res.end());
      upstreamRes.on('error', () => { if (!res.writableEnded) res.end(); });
      upstreamRes.on('close', () => { if (!res.writableEnded) res.end(); });
    });
    upstreamReq.on('error', (err) => {
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`Bad Gateway: ${err.message}`); } else res.end();
    });
    upstreamReq.write(body);
    upstreamReq.end();
  });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => console.error(`LM Studio proxy :${LISTEN_PORT} -> :${UPSTREAM.port}`));
