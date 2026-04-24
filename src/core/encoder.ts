/**
 * Binary encoder/decoder to avoid base64/JSON fingerprints.
 * Uses a lightweight custom binary protocol.
 */

const HEADER_SIZE = 4;

export function encodeRequest(data: { url: string; method: string; headers: Record<string, string>; body?: string }): ArrayBuffer {
  const urlBytes = new TextEncoder().encode(data.url);
  const methodBytes = new TextEncoder().encode(data.method);
  const headersStr = JSON.stringify(data.headers);
  const headersBytes = new TextEncoder().encode(headersStr);
  const bodyBytes = data.body ? new TextEncoder().encode(data.body) : new Uint8Array(0);

  const total = HEADER_SIZE + urlBytes.length + methodBytes.length + headersBytes.length + bodyBytes.length + 16;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let off = 0;
  view.setUint32(off, urlBytes.length, true); off += 4;
  bytes.set(urlBytes, off); off += urlBytes.length;

  view.setUint32(off, methodBytes.length, true); off += 4;
  bytes.set(methodBytes, off); off += methodBytes.length;

  view.setUint32(off, headersBytes.length, true); off += 4;
  bytes.set(headersBytes, off); off += headersBytes.length;

  view.setUint32(off, bodyBytes.length, true); off += 4;
  bytes.set(bodyBytes, off); off += bodyBytes.length;

  return buf.slice(0, off);
}

export function decodeResponse(buf: ArrayBuffer): { status: number; headers: Record<string, string>; body: Uint8Array } {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let off = 0;

  const status = view.getUint16(off, true); off += 2;

  const hLen = view.getUint32(off, true); off += 4;
  const hStr = new TextDecoder().decode(bytes.subarray(off, off + hLen));
  off += hLen;
  const headers = JSON.parse(hStr);

  const bLen = view.getUint32(off, true); off += 4;
  const body = bytes.subarray(off, off + bLen);

  return { status, headers, body };
}

export function encodeChunk(data: Uint8Array, seq: number, final: boolean): ArrayBuffer {
  const buf = new ArrayBuffer(5 + data.length);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint32(0, seq, true);
  bytes[4] = final ? 1 : 0;
  bytes.set(data, 5);
  return buf;
}

export function decodeChunk(buf: ArrayBuffer): { seq: number; final: boolean; data: Uint8Array } {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const seq = view.getUint32(0, true);
  const final = bytes[4] === 1;
  return { seq, final, data: bytes.subarray(5) };
}

