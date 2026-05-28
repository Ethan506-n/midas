/**
 * WebSocket Bridge — proxies real WebSocket connections through HTTP upgrade.
 * Uses the 'ws' library for real bidirectional WebSocket tunneling.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import WebSocket from 'ws';
import { parseCookieHeader, jarFor, buildCookieHeader } from './router.js';

const BRIDGE_SESSIONS = new Map();
const SESSION_TIMEOUT = 5 * 60 * 1000;

function generateBridgeId() {
  return Array.from({ length: 32 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[
      Math.floor(Math.random() * 62)
    ]
  ).join('');
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of BRIDGE_SESSIONS) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      try { session.clientWs?.close(); } catch (e) {}
      try { session.serverWs?.close(); } catch (e) {}
      BRIDGE_SESSIONS.delete(id);
    }
  }
}
setInterval(cleanupSessions, 60000);

function createServerWebSocket(targetUrl, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(targetUrl, {
      headers: headers || {},
      rejectUnauthorized: false,
      perMessageDeflate: false,
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('WS closed immediately')));
  });
}

/**
 * Build the cookie header to send to the target site for a WS upgrade.
 * Merges server-side jar cookies (from prior Set-Cookie headers) with any
 * non-proxy cookies the browser forwarded in its upgrade request.
 */
function buildWsCookieHeader(req, targetHostname, targetPath, isSecure) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const sid = cookies.midas_sid;

  // Get jar cookies for this session / target host
  let jarHeader = '';
  if (sid) {
    const jar = jarFor(sid);
    jarHeader = buildCookieHeader(jar, targetHostname, targetPath, isSecure);
  }

  // Forward browser-stored cookies too (e.g. JS-set document.cookie values),
  // excluding proxy-internal ones.
  const PROXY_ONLY = new Set(['midas_sid']);
  const browserForward = (req.headers.cookie || '')
    .split(';')
    .map(s => s.trim())
    .filter(s => {
      const name = s.split('=')[0].trim();
      return name && !PROXY_ONLY.has(name);
    });

  // Jar cookies win on conflict
  const jarMap = new Map();
  jarHeader.split(';').map(s => s.trim()).filter(Boolean).forEach(s => {
    const eq = s.indexOf('=');
    if (eq > 0) jarMap.set(s.slice(0, eq).trim(), s);
  });
  const browserMap = new Map();
  browserForward.forEach(s => {
    const eq = s.indexOf('=');
    if (eq > 0) browserMap.set(s.slice(0, eq).trim(), s);
  });
  const merged = new Map([...browserMap, ...jarMap]);
  return [...merged.values()].join('; ');
}

/**
 * Native WebSocket upgrade handler.
 * Called by server.on('upgrade', ...) for both properly-rewritten
 * wss://proxy/_midas/BROWSE?url=wss://target.com/... requests AND
 * session-based bare-path rewrites done in index.js.
 *
 * Fixes applied:
 *  1. Cookies from the session jar + browser are forwarded to the target.
 *  2. Client messages are buffered until the target WS opens, so socket.io's
 *     "2probe" upgrade probe (sent immediately after handshake) is not lost.
 *  3. WebSocket-level ping frames from the target are forwarded to the client
 *     (and vice versa) so both sides see real keepalives; the ws library's
 *     auto-pong still fires so neither side times out.
 */
export function wsUpgradeHandler(req, socket, head) {
  try {
    const reqUrl = new URL(req.url, 'http://x');
    const targetParam = reqUrl.searchParams.get('url');
    if (!targetParam) { socket.destroy(); return; }

    // Accept both https:// (MidasWebSocket converts wss→https before toProxy)
    // and bare wss:// forms.
    const targetUrl = targetParam
      .replace(/^https:\/\//i, 'wss://')
      .replace(/^http:\/\//i, 'ws://');

    const targetForCookies = targetUrl.replace(/^wss?:/i, 'https:');
    let targetHostname = '';
    let targetPath = '/';
    let isSecure = true;
    try {
      const tu = new URL(targetForCookies);
      targetHostname = tu.hostname;
      targetPath = tu.pathname || '/';
      isSecure = tu.protocol === 'https:';
    } catch { /* ignore */ }

    // Build cookie header from the session jar + browser cookies.
    const cookieHeader = buildWsCookieHeader(req, targetHostname, targetPath, isSecure);

    // Build headers to send on the WS upgrade to the target.
    const targetHeaders = {
      'host':       targetHostname,
      'origin':     'https://' + targetHostname,
      'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
    };
    if (cookieHeader) targetHeaders['cookie'] = cookieHeader;
    // Forward auth header if present.
    if (req.headers['authorization']) targetHeaders['authorization'] = req.headers['authorization'];
    // Forward any x-* custom headers from the browser.
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.startsWith('x-') && !['x-forwarded-for', 'x-real-ip'].includes(k)) {
        targetHeaders[k] = v;
      }
    }
    // Forward subprotocols requested by the browser.
    if (req.headers['sec-websocket-protocol']) {
      targetHeaders['sec-websocket-protocol'] = req.headers['sec-websocket-protocol'];
    }

    // Complete the handshake with the browser first.
    const wss = new WebSocket.Server({ noServer: true });
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      // --- Message buffer: captures client messages that arrive before the
      //     target connection is open (e.g. socket.io "2probe" upgrade probe).
      const pendingFromClient = [];
      let targetOpen = false;

      // Start accumulating client messages immediately.
      const bufferClient = (data, isBinary) => { pendingFromClient.push({ data, isBinary }); };
      clientWs.on('message', bufferClient);

      const targetWs = new WebSocket(targetUrl, {
        rejectUnauthorized: false,
        headers: targetHeaders,
        perMessageDeflate: false,
      });

      targetWs.once('open', () => {
        targetOpen = true;

        // Flush any messages the client sent while we were connecting.
        for (const { data, isBinary } of pendingFromClient) {
          if (targetWs.readyState === WebSocket.OPEN)
            targetWs.send(data, { binary: isBinary });
        }

        // Switch from buffering to live forwarding.
        clientWs.off('message', bufferClient);
        clientWs.on('message', (data, isBinary) => {
          if (targetWs.readyState === WebSocket.OPEN)
            targetWs.send(data, { binary: isBinary });
        });

        // Forward data messages: target → client.
        targetWs.on('message', (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN)
            clientWs.send(data, { binary: isBinary });
        });

        // Forward WS-level pings from target → client.
        // The ws library auto-pongs for us so the target doesn't time out,
        // AND we forward the ping so the client also sees the keepalive.
        targetWs.on('ping', (data) => {
          try { if (clientWs.readyState === WebSocket.OPEN) clientWs.ping(data); } catch (_) {}
        });
        // Forward WS-level pings from client → target.
        clientWs.on('ping', (data) => {
          try { if (targetWs.readyState === WebSocket.OPEN) targetWs.ping(data); } catch (_) {}
        });
        // Forward pongs both ways too.
        targetWs.on('pong', (data) => {
          try { if (clientWs.readyState === WebSocket.OPEN) clientWs.pong(data); } catch (_) {}
        });
        clientWs.on('pong', (data) => {
          try { if (targetWs.readyState === WebSocket.OPEN) targetWs.pong(data); } catch (_) {}
        });
      });

      // If target fails to open, close the client connection cleanly.
      targetWs.once('error', (err) => {
        console.error('[WS-PROXY] target connect error:', err.message);
        try { clientWs.close(1011, 'upstream error'); } catch (_) {}
      });

      clientWs.on('close', (code, reason) => { try { targetWs.close(code, reason); } catch (_) {} });
      targetWs.on('close', (code, reason) => {
        // Give the client a moment to flush its own send buffer before closing.
        setTimeout(() => { try { clientWs.close(code, reason); } catch (_) {} }, 50);
      });
      clientWs.on('error', () => { try { targetWs.close(1011); } catch (_) {} });
      targetWs.on('error', () => { try { clientWs.close(1011); } catch (_) {} });
    });
  } catch (e) {
    console.error('[WS-PROXY] upgrade handler error:', e.message);
    try { socket.destroy(); } catch (_) {}
  }
}

export function wsBridgeHandler(req, res, url) {
  const pathname = url.pathname;

  if (pathname.endsWith('/open')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const bridgeId = generateBridgeId();

        const session = {
          id: bridgeId,
          targetUrl: data.url,
          protocol: data.protocol || '',
          messages: [],
          lastActivity: Date.now(),
          closed: false,
          closeCode: null,
          closeReason: '',
          clientWs: null,
          serverWs: null,
        };

        try {
          const serverWs = await createServerWebSocket(data.url, data.headers);
          session.serverWs = serverWs;

          serverWs.on('message', (data, isBinary) => {
            session.lastActivity = Date.now();
            const msg = {
              id: (session.lastRecvId = (session.lastRecvId || 0) + 1),
              direction: 'in',
              text: isBinary ? null : data.toString(),
              binary: isBinary ? Buffer.from(data).toString('base64') : null,
            };
            session.messages.push(msg);
          });

          serverWs.on('close', (code, reason) => {
            session.closed = true;
            session.closeCode = code;
            session.closeReason = reason?.toString() || '';
          });

          serverWs.on('error', () => {
            session.closed = true;
            session.closeCode = 1011;
          });
        } catch (e) {
          // Store session anyway so client can poll for failure
          session.closed = true;
          session.closeCode = 1006;
          session.closeReason = 'connect failed';
        }

        BRIDGE_SESSIONS.set(bridgeId, session);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sid: bridgeId, status: session.serverWs ? 'opened' : 'failed' }));
      } catch (e) {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  if (pathname.endsWith('/send')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const session = BRIDGE_SESSIONS.get(data.sid);
        if (!session) { res.writeHead(404); res.end(); return; }

        session.lastActivity = Date.now();

        if (data.messages && session.serverWs && session.serverWs.readyState === WebSocket.OPEN) {
          for (const msg of data.messages) {
            if (msg.binary) {
              session.serverWs.send(Buffer.from(msg.binary, 'base64'));
            } else if (msg.text !== undefined) {
              session.serverWs.send(msg.text);
            }
          }
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, queued: data.messages?.length || 0 }));
      } catch (e) {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  if (pathname.endsWith('/poll')) {
    const sid = url.searchParams.get('sid');
    const last = parseInt(url.searchParams.get('last') || '0', 10);
    const session = BRIDGE_SESSIONS.get(sid);

    if (!session) { res.writeHead(404); res.end(); return; }
    session.lastActivity = Date.now();

    const messages = session.messages
      .filter(m => m.id > last && m.direction === 'in')
      .map(m => ({ id: m.id, text: m.text, binary: m.binary }));

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      messages,
      closed: session.closed,
      closeCode: session.closeCode,
      closeReason: session.closeReason,
    }));
    return;
  }

  if (pathname.endsWith('/close')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const session = BRIDGE_SESSIONS.get(data.sid);
        if (session) {
          session.closed = true;
          session.closeCode = data.code || 1000;
          session.closeReason = data.reason || '';
          try { session.serverWs?.close(); } catch (e) {}
        }
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  res.writeHead(404); res.end();
}
