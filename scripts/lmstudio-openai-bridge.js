#!/usr/bin/env node
/**
 * OpenAI 兼容 -> LM Studio(Anthropic /v1/messages) 转换代理
 * 给只会发 OpenAI 格式(/v1/chat/completions)的客户端用，例如小米 MiMo。
 *
 * 背景：本机 Qwen3.5-9B(thinking, 已 patch 模板) 在 LM Studio 的
 *   - /v1/chat/completions(OpenAI) 会在思考后断流、不出正文，且 reasoningBudget 不生效；
 *   - /v1/messages(Anthropic) + reasoningBudget=500 稳定快速。
 * 本代理把 OpenAI 请求转成 Anthropic 请求发给 LM Studio，再把 Anthropic SSE
 * 转回 OpenAI 格式返回给客户端；到上游始终走流式(最稳)，并对“空响应”自动重试一次。
 *
 * 监听 1236 -> 上游 1234。
 */
const http = require('http');

const UPSTREAM = { host: '127.0.0.1', port: 1234 };
const LISTEN_PORT = 1236;
const REASONING_BUDGET = 500;
const DEFAULT_MAX_TOKENS = 4096;
const MODEL = 'qwen3.5-9b';
const MAX_ATTEMPTS = 2; // 空响应时最多尝试次数

const genId = () => 'chatcmpl-' + Math.random().toString(36).slice(2, 12);

// OpenAI 请求体 -> Anthropic 请求体（到上游始终 stream:true）
function toAnthropic(openai) {
  const sysParts = [];
  const msgs = [];
  for (const m of openai.messages || []) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    if (m.role === 'system' || m.role === 'developer') sysParts.push(content);
    else if (m.role === 'user' || m.role === 'assistant') msgs.push({ role: m.role, content });
  }
  const a = {
    model: openai.model || MODEL,
    messages: msgs,
    max_tokens: openai.max_tokens || openai.max_completion_tokens || DEFAULT_MAX_TOKENS,
    stream: true,
    reasoningBudget: REASONING_BUDGET,
  };
  if (sysParts.length) a.system = sysParts.join('\n\n');
  if (typeof openai.temperature === 'number') a.temperature = openai.temperature;
  return a;
}

function chunk(id, delta, finishReason) {
  return {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
}

// 发起一次上游流式请求，解析 Anthropic SSE。
// handlers: onText(t) 收到正文; onReason(r) 收到停止原因。
// 返回 Promise<{ gotText:boolean, reason:string|null }>
function callUpstream(anth, handlers) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(anth));
    const req = http.request({
      ...UPSTREAM, method: 'POST', path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'lm-studio',
        'anthropic-version': '2023-06-01',
        'Content-Length': payload.length,
        'Connection': 'close',
      },
      timeout: 600000,
    }, (u) => {
      if (u.statusCode !== 200) {
        let eb = '';
        u.on('data', (d) => (eb += d));
        u.on('end', () => reject(new Error('upstream ' + u.statusCode + ': ' + eb.slice(0, 300))));
        return;
      }
      let gotText = false;
      let reason = null;
      let buf = '';
      u.setEncoding('utf-8');
      const feed = (line) => {
        if (!line.startsWith('data:')) return;
        const p = line.slice(5).trim();
        if (!p || p === '[DONE]') return;
        let ev;
        try { ev = JSON.parse(p); } catch { return; }
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && ev.delta.text) {
            gotText = true;
            handlers.onText(ev.delta.text);
          }
          // thinking_delta 丢弃，不把思考吐给客户端
        } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) {
          const map = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop' };
          reason = map[ev.delta.stop_reason] || 'stop';
          handlers.onReason(reason);
        }
      };
      u.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          feed(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      });
      u.on('end', () => { if (buf.trim()) feed(buf.trim()); resolve({ gotText, reason }); });
      u.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.write(payload);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(parts).toString('utf-8');

    if (req.method === 'GET' && url.endsWith('/v1/models')) {
      const ureq = http.request({ ...UPSTREAM, method: 'GET', path: '/v1/models', headers: { Connection: 'close' } }, (u) => {
        res.writeHead(u.statusCode, { 'Content-Type': 'application/json' });
        u.pipe(res);
      });
      ureq.on('error', (e) => { res.writeHead(502); res.end(JSON.stringify({ error: { message: e.message } })); });
      ureq.end();
      return;
    }

    if (req.method !== 'POST' || !url.endsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'only /v1/chat/completions is proxied' } }));
      return;
    }

    let openai;
    try { openai = JSON.parse(raw || '{}'); }
    catch { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'bad json' } })); return; }

    const wantStream = !!openai.stream;
    const anth = toAnthropic(openai);
    const id = genId();

    try {
      // 单槽(parallel=1)下，上一请求刚结束时新请求可能被上游瞬时 400/abort，
      // 因此对“空响应”和“上游瞬时错误”都重试，间隔等待槽位释放。
      const RETRY_WAIT = 1200;
      if (wantStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache', Connection: 'close',
        });
        const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
        let headerSent = false;
        let lastReason = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            const r = await callUpstream(anth, {
              onText: (t) => {
                if (!headerSent) { send(chunk(id, { role: 'assistant', content: '' })); headerSent = true; }
                send(chunk(id, { content: t }));
              },
              onReason: (x) => { lastReason = x; },
            });
            if (r.gotText) { lastErr = null; break; }
          } catch (e) { lastErr = e; }
          if (attempt < MAX_ATTEMPTS) await new Promise((s) => setTimeout(s, RETRY_WAIT));
        }
        if (!headerSent && lastErr) { send(chunk(id, { role: 'assistant', content: '（本地模型暂时繁忙，请重试一次）' })); }
        else if (!headerSent) send(chunk(id, { role: 'assistant', content: '' }));
        send(chunk(id, {}, lastReason || 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        let text = '';
        let reason = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            text = '';
            const r = await callUpstream(anth, {
              onText: (t) => { text += t; },
              onReason: (x) => { reason = x; },
            });
            if (r.gotText) { lastErr = null; break; }
          } catch (e) { lastErr = e; }
          if (attempt < MAX_ATTEMPTS) await new Promise((s) => setTimeout(s, RETRY_WAIT));
        }
        if (lastErr && !text) throw lastErr;
        const out = {
          id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: reason || 'stop' }],
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => console.error(`OpenAI->Anthropic bridge :${LISTEN_PORT} -> :${UPSTREAM.port}`));
