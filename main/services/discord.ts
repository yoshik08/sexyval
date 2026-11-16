import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { buildActivity, discordBackoff, MIN_UPDATE_MS, sameActivity, validClientId, type Activity, type PresenceInput, type PresencePrivacy } from '../../shared/presence';
import { log } from '../log';

/**
 * Discord Rich Presence over Discord's local IPC pipe (\\?\pipe\discord-ipc-N): a 4-byte opcode, a 4-byte
 * length and JSON. Written here (about 150 lines) instead of pulling in discord-rpc, which is unmaintained.
 * Off by default. Turning it on connects at once; turning it off clears the activity and closes the pipe.
 * Nothing blocks the app: every pipe operation is async and failures only change `status`.
 */

export interface DiscordConfig {
  enabled: boolean;
  clientId: string;
  privacy: PresencePrivacy;
}

export type DiscordState = 'off' | 'no-client-id' | 'connecting' | 'connected' | 'discord-closed' | 'error';

export interface DiscordStatus {
  state: DiscordState;
  detail: string;
  /** What Discord is showing right now (null = nothing). */
  activity: Activity | null;
  lastUpdateAt?: number;
}

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 } as const;

export function encodeFrame(op: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

/** Splits a byte stream into frames; returns the frames and the unconsumed rest. */
export function decodeFrames(buf: Buffer): { frames: { op: number; data: any }[]; rest: Buffer } {
  const frames: { op: number; data: any }[] = [];
  let off = 0;
  while (buf.length - off >= 8) {
    const op = buf.readInt32LE(off);
    const len = buf.readInt32LE(off + 4);
    if (len < 0 || len > 1_000_000) throw new Error('bad Discord frame');
    if (buf.length - off - 8 < len) break;
    let data: any = null;
    try {
      data = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
    } catch {
      data = null;
    }
    frames.push({ op, data });
    off += 8 + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export type PipeConnector = (index: number) => net.Socket;
const defaultConnector: PipeConnector = (i) => net.connect(`\\\\?\\pipe\\discord-ipc-${i}`);

export class DiscordPresence {
  status: DiscordStatus = { state: 'off', detail: 'Off', activity: null };
  private sock: net.Socket | null = null;
  private ready = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private sendTimer: NodeJS.Timeout | null = null;
  private lastSentAt = 0;
  private sent: Activity | null = null;
  private wanted: Activity | null = null;
  private input: PresenceInput | null = null;
  private connecting = false;

  constructor(
    private readonly cfg: () => DiscordConfig,
    private readonly onChange: () => void = () => {},
    private readonly connector: PipeConnector = defaultConnector,
    private readonly now: () => number = Date.now,
  ) {}

  private set(state: DiscordState, detail: string): void {
    this.status = { ...this.status, state, detail, activity: this.ready ? this.sent : null };
    this.onChange();
  }

  /** Settings changed (enable, disable, client id, privacy): applies at once, no restart. */
  apply(): void {
    const c = this.cfg();
    if (!c.enabled) return this.shutdown('Off');
    if (!validClientId(c.clientId)) return this.shutdown('Add your Discord application ID to turn this on', 'no-client-id');
    this.attempt = 0;
    if (!this.sock && !this.connecting) this.connect();
    this.recompute();
  }

  /** The game state changed. Cheap: only a changed activity is ever sent, at most every 15 s. */
  update(input: PresenceInput): void {
    this.input = input;
    if (!this.cfg().enabled) return;
    // Discord was closed earlier and the retries ran out: a game-state change is a good moment to look again.
    if (!this.sock && !this.connecting && !this.retryTimer && validClientId(this.cfg().clientId)) {
      this.attempt = 0;
      this.connect();
    }
    this.recompute();
  }

  /** Manual reconnect (health panel). */
  reconnect(): void {
    this.close();
    this.attempt = 0;
    this.apply();
  }

  private recompute(): void {
    this.wanted = this.input ? buildActivity(this.input, this.cfg().privacy) : null;
    this.flush();
  }

  private flush(): void {
    if (!this.ready || sameActivity(this.wanted, this.sent)) return;
    const wait = this.lastSentAt + MIN_UPDATE_MS - this.now();
    // Clearing (Valorant closed, or disabled) is never delayed.
    if (wait > 0 && this.wanted !== null) {
      if (!this.sendTimer) this.sendTimer = setTimeout(() => ((this.sendTimer = null), this.flush()), wait);
      return;
    }
    this.write(this.wanted);
  }

  private write(activity: Activity | null): void {
    if (!this.sock || !this.ready) return;
    this.sock.write(encodeFrame(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: randomUUID() }));
    this.sent = activity;
    this.lastSentAt = this.now();
    this.status = { ...this.status, activity, lastUpdateAt: this.lastSentAt };
    this.onChange();
  }

  private connect(pipe = 0): void {
    const clientId = this.cfg().clientId.trim();
    this.connecting = true;
    if (pipe === 0) this.set('connecting', 'Looking for Discord');
    const sock = this.connector(pipe);
    let buf: Buffer = Buffer.alloc(0);
    let opened = false;
    sock.once('connect', () => {
      opened = true;
      this.sock = sock;
      sock.write(encodeFrame(OP.HANDSHAKE, { v: 1, client_id: clientId }));
    });
    sock.on('data', (chunk) => {
      try {
        const r = decodeFrames(Buffer.concat([buf, chunk]));
        buf = r.rest;
        for (const f of r.frames) this.onFrame(f.op, f.data, sock);
      } catch (e) {
        log.warn('discord: bad frame', e);
        sock.destroy();
      }
    });
    sock.once('error', () => {
      sock.destroy();
      if (!opened) {
        // Discord listens on the first free pipe of 0..9.
        if (pipe < 9) return this.connect(pipe + 1);
        this.connecting = false;
        this.scheduleRetry('Discord isn’t running');
      }
    });
    sock.once('close', () => {
      // A socket we closed on purpose (disable, reconnect) or one already replaced: nothing to do.
      if (!opened || this.sock !== sock) return;
      const wasReady = this.ready;
      this.sock = null;
      this.ready = false;
      this.connecting = false;
      this.sent = null;
      if (!this.cfg().enabled) return;
      this.scheduleRetry(wasReady ? 'Discord closed' : 'Discord refused the connection (check the application ID)');
    });
  }

  private onFrame(op: number, data: any, sock: net.Socket): void {
    if (op === OP.PING) return void sock.write(encodeFrame(OP.PONG, data ?? {}));
    if (op === OP.CLOSE) {
      log.warn('discord: closed by Discord', data?.message ?? '');
      this.set('error', `Discord closed the connection: ${String(data?.message ?? 'unknown reason').slice(0, 120)}`);
      sock.destroy();
      return;
    }
    if (op === OP.FRAME && data?.evt === 'READY') {
      this.ready = true;
      this.connecting = false;
      this.attempt = 0;
      this.sent = null;
      this.lastSentAt = 0;
      this.set('connected', 'Connected to Discord');
      this.flush();
    } else if (op === OP.FRAME && data?.evt === 'ERROR') {
      this.set('error', `Discord: ${String(data?.data?.message ?? 'error').slice(0, 120)}`);
    }
  }

  private scheduleRetry(why: string): void {
    const ms = discordBackoff(this.attempt++);
    if (ms == null) {
      this.set('discord-closed', `${why}. SexyVal looks again when your game state changes, or press Reconnect.`);
      return;
    }
    this.set('discord-closed', `${why}. Trying again in ${Math.round(ms / 1000)} s.`);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.cfg().enabled && validClientId(this.cfg().clientId) && !this.sock && !this.connecting) this.connect();
    }, ms);
  }

  private close(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.retryTimer = this.sendTimer = null;
    const s = this.sock;
    this.sock = null;
    this.ready = false;
    this.connecting = false;
    this.sent = null;
    s?.destroy();
  }

  /** Disable / quit: clear what Discord shows, then close the pipe. */
  shutdown(detail = 'Off', state: DiscordState = 'off'): void {
    if (this.sock && this.ready && this.sent !== null) {
      const s = this.sock;
      s.write(encodeFrame(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: randomUUID() }), () => s.end());
      this.sock = null;
      this.ready = false;
    }
    this.close();
    this.status = { state, detail, activity: null };
    this.onChange();
  }
}
