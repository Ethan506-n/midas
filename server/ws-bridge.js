/**
 * WebSocket Bridge — proxies real WebSocket connections through HTTP upgrade.
 * Uses the 'ws' library for real bidirectional WebSocket tunneling.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import WebSocket from 'ws';

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
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('WS closed immediately')));
  });
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

