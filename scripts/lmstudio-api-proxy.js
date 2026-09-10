#!/usr/bin/env node
/**
 * LM Studio API 代理：自动给 Anthropic /v1/messages 请求注入 reasoningBudget
 * 监听 127.0.0.1:1235 -> http://127.0.0.1:1234
 */
const http = require('http');

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 1234;
const LISTEN_PORT = 1235;
const REASONING_BUDGET = 500;

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

const server = http.createServer((clientReq, clientRes) => {
  const chunks = [];
  clientReq.on('data', (c) => chunks.push(c));
  clientReq.on('end', () => {
    let body = Buffer.concat(chunks);

    // 对 /v1/messages POST 注入 reasoningBudget
    if (clientReq.method === 'POST' && clientReq.url.startsWith('/v1/messages') && body.length > 0) {
      try {
        const data = JSON.parse(body.toString('utf-8'));
        if (!('reasoningBudget' in data)) {
          data.reasoningBudget = REASONING_BUDGET;
          body = Buffer.from(JSON.stringify(data), 'utf-8');
          console.error(`[proxy] injected reasoningBudget=${REASONING_BUDGET} for ${clientReq.url}`);
        }
      } catch (e) {
        // 非 JSON 直接转发
      }
    }

    // 构建上游请求头
    const headers = {};
    for (const [k, v] of Object.entries(clientReq.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) {
        headers[k] = v;
      }
    }
    headers['Content-Length'] = body.length;

    const upstreamReq = http.request({
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: clientReq.method,
      path: clientReq.url,
      headers: headers,
      timeout: 600000,
    }, (upstreamRes) => {
      // 转发响应头
      const resHeaders = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) {
          resHeaders[k] = v;
        }
      }
      clientRes.writeHead(upstreamRes.statusCode, resHeaders);
      // 流式透传
      upstreamRes.pipe(clientRes);
    });

    upstreamReq.on('error', (err) => {
      console.error(`[proxy] upstream error: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end(`Bad Gateway: ${err.message}`);
      } else {
        clientRes.end();
      }
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      if (!clientRes.headersSent) {
        clientRes.writeHead(504, { 'Content-Type': 'text/plain' });
        clientRes.end('Gateway Timeout');
      }
    });

    upstreamReq.write(body);
    upstreamReq.end();
  });

  clientReq.on('error', (err) => {
    console.error(`[proxy] client error: ${err.message}`);
  });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.error(`LM Studio API proxy listening on http://127.0.0.1:${LISTEN_PORT} -> http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  console.error(`reasoningBudget = ${REASONING_BUDGET}`);
});