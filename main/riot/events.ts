import { WebSocket } from 'undici';
import { localInsecure } from './http';
import { phaseEventUri } from '../../shared/phase';
import { log } from '../log';

export interface LockInfo {
  protocol: string;
  port: number;
  password: string;
}

const CHECK_MS = 2000;
const MAX_RETRY_MS = 30_000;

/**
 * Riot Client local WebSocket (`wss://127.0.0.1:{port}`, Basic riot:{password}). Subscribes to
 * OnJsonApiEvent and calls `onEvent` for party / pregame / core-game events, so a popped queue
 * shows up at once instead of on the next poll. Read-only: it never sends anything but the
 * subscription. Polling keeps running underneath, so losing the socket only costs latency.
 * Self-signed TLS is accepted for 127.0.0.1 only (the same scoped agent as the HTTP calls).
 */
export class RiotEvents {
  state: 'off' | 'connecting' | 'connected' = 'off';
  private ws: WebSocket | null = null;
  private key = '';
  private retry = 0;
  private nextAttempt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly lock: () => LockInfo | null,
    private readonly onEvent: (uri: string) => void,
    private readonly onState?: () => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sync(), CHECK_MS);
    this.sync();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.close();
    this.setState('off');
  }

  /** Connects when a lockfile appears, reconnects when it changes (client restart), backs off on failure. */
  sync(): void {
    const lock = this.lock();
    const key = lock ? `${lock.protocol}:${lock.port}:${lock.password}` : '';
    if (key !== this.key) {
      this.close();
      this.key = key;
      this.retry = 0;
      this.nextAttempt = 0;
    }
    if (!lock) return this.setState('off');
    if (!this.ws && Date.now() >= this.nextAttempt) this.connect(lock);
  }

  private connect(lock: LockInfo): void {
    this.setState('connecting');
    const url = `${lock.protocol === 'https' ? 'wss' : 'ws'}://127.0.0.1:${lock.port}`;
    const auth = `Basic ${Buffer.from(`riot:${lock.password}`).toString('base64')}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { dispatcher: localInsecure, headers: { Authorization: auth } } as any);
    } catch (e) {
      log.warn('riot events: could not open socket', e);
      return this.failed();
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify([5, 'OnJsonApiEvent']));
      this.retry = 0;
      this.setState('connected');
      log.info('riot events: connected');
    });
    ws.addEventListener('message', (ev) => {
      const uri = phaseEventUri(typeof ev.data === 'string' ? ev.data : '');
      if (uri) this.onEvent(uri);
    });
    const down = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failed();
    };
    ws.addEventListener('close', down);
    ws.addEventListener('error', down);
  }

  private failed(): void {
    const wait = Math.min(MAX_RETRY_MS, 1000 * 2 ** this.retry++);
    this.nextAttempt = Date.now() + wait;
    this.setState(this.key ? 'connecting' : 'off');
  }

  private close(): void {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // already closed
    }
  }

  private setState(s: RiotEvents['state']): void {
    if (this.state === s) return;
    this.state = s;
    this.onState?.();
  }
}
