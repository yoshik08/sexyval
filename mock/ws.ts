// Minimal WebSocket server for the mock Riot Client: same handshake auth (Basic riot:password),
// same subscribe message ([5, "OnJsonApiEvent"]) and the same event frames
// ([8, "OnJsonApiEvent", { data, eventType, uri }]) as the real local API.
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (len >= 126 && len < 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else if (len >= 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

export interface MockEvents {
  emit(uri: string, eventType?: 'Create' | 'Update' | 'Delete', data?: unknown): void;
  subscribers(): number;
  close(): void;
}

export function attachEvents(server: http.Server, password: string): MockEvents {
  const subs = new Set<Duplex>();
  const all = new Set<Duplex>();
  const expected = 'Basic ' + Buffer.from(`riot:${password}`).toString('base64');

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.authorization !== expected || typeof key !== 'string') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    all.add(socket);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const mask = masked ? buf.subarray(off, off + 4) : null;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(off + len);
        if (opcode === 0x8) {
          socket.end(frame(0x8, Buffer.alloc(0)));
          return;
        }
        if (opcode === 0x9) socket.write(frame(0xa, payload));
        if (opcode === 0x1) {
          try {
            const msg = JSON.parse(payload.toString('utf8'));
            if (Array.isArray(msg) && msg[0] === 5 && msg[1] === 'OnJsonApiEvent') subs.add(socket);
          } catch {
            // ignore non-JSON text
          }
        }
      }
    });
    const gone = () => {
      subs.delete(socket);
      all.delete(socket);
    };
    socket.on('close', gone);
    socket.on('error', gone);
  });

  return {
    emit(uri, eventType = 'Update', data = {}) {
      const f = frame(0x1, Buffer.from(JSON.stringify([8, 'OnJsonApiEvent', { data, eventType, uri }])));
      for (const s of subs) s.write(f);
    },
    subscribers: () => subs.size,
    close() {
      for (const s of all) s.destroy();
      all.clear();
      subs.clear();
    },
  };
}
