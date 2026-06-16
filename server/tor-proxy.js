import { spawn } from 'child_process';
import { SocksProxyAgent } from 'socks-proxy-agent';
import fs from 'fs';

const SOCKS_PORT = 9050;
const TOR_DATA_DIR = '/tmp/midas-tor';

let torReady = false;
let torProcess = null;
let torAgent = null;

export function getTorAgent() {
  return torReady ? torAgent : null;
}

export function isTorReady() {
  return torReady;
}

export function startTor() {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(TOR_DATA_DIR)) {
        fs.mkdirSync(TOR_DATA_DIR, { recursive: true });
      }
    } catch (e) {}

    console.log('[TOR] Starting Tor daemon on SOCKS5 port', SOCKS_PORT);

    try {
      torProcess = spawn('tor', [
        '--SocksPort', String(SOCKS_PORT),
        '--DataDirectory', TOR_DATA_DIR,
        '--ControlPort', '0',
        '--Log', 'notice stderr',
        '--ClientOnly', '1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      console.log('[TOR] Failed to spawn tor:', err.message);
      resolve(false);
      return;
    }

    const onData = (chunk) => {
      const text = chunk.toString();
      const pctMatch = text.match(/Bootstrapped (\d+)%/);
      if (pctMatch) {
        const pct = parseInt(pctMatch[1], 10);
        if (pct > 0 && pct < 100) console.log(`[TOR] Bootstrap ${pct}%`);
        if (pct === 100) {
          torReady = true;
          torAgent = new SocksProxyAgent(`socks5h://127.0.0.1:${SOCKS_PORT}`);
          console.log('[TOR] Ready — all DDG requests will exit via Tor');
          torProcess.stdout.off('data', onData);
          torProcess.stderr.off('data', onData);
          resolve(true);
        }
      }
    };

    torProcess.stdout.on('data', onData);
    torProcess.stderr.on('data', onData);

    torProcess.on('error', (err) => {
      console.log('[TOR] Process error:', err.message);
      torReady = false;
      resolve(false);
    });

    torProcess.on('exit', (code) => {
      console.log('[TOR] Process exited with code', code);
      torReady = false;
    });

    setTimeout(() => {
      if (!torReady) {
        console.log('[TOR] Bootstrap timed out — falling back to direct for DDG');
        resolve(false);
      }
    }, 90000);
  });
}

export function stopTor() {
  if (torProcess) {
    torProcess.kill('SIGTERM');
    torProcess = null;
  }
  torReady = false;
  torAgent = null;
}
