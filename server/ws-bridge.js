/**
 * WebSocket-over-HTTP Bridge Server
 * Maintains "virtual" WebSocket connections that are polled by the client over HTTP.
 * No actual WebSocket connections are used, defeating WebSocket traffic pattern detection.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

const BRIDGE_SESSIONS = new Map();
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

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
      if (session.ws) {
        try { session.ws.close(); } catch (e) {}
      }
      BRIDGE_SESSIONS.delete(id);
    }
  }
}

setInterval(cleanupSessions, 60000);

function createRealWebSocket(url) {
  return new Promise((resolve, reject) => {
    const wsUrl = new URL(url);
    const lib = wsUrl.protocol === 'wss:' ? https : http;
    const options = {
      hostname: wsUrl.hostname,
      port: wsUrl.port || (wsUrl.protocol === 'wss:' ? 443 : 80),
      path: wsUrl.pathname + wsUrl.search,
      method: 'GET',
      headers: {
        'upgrade': 'websocket',
        'connection': 'Upgrade',
        'sec-websocket-key': Buffer.from(Math.random().toString()).toString('base64'),
        'sec-websocket-version': '13',
      },
      rejectUnauthorized: false,
    };

    const req = lib.request(options, (res) => {
      reject(new Error(`WS upgrade failed: ${res.statusCode}`));
    });

    req.on('upgrade', (res, socket) => {
      resolve({ socket, headers: res.headers });
    });

    req.on('error', reject);
    req.end();
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
          ws: null,
        };

        // For now, store session without real WS connection
        // In production, this would connect to the real WS server
        BRIDGE_SESSIONS.set(bridgeId, session);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sid: bridgeId, status: 'opened' }));
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
        // Store outbound messages
        if (data.messages) {
          for (const msg of data.messages) {
            session.messages.push({ id: ++session.lastRecvId || 0, direction: 'out', text: msg });
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
          if (session.ws) {
            try { session.ws.close(); } catch (e) {}
          }
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


