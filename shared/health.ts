// Connection health: one place that turns the scattered states (Riot Client, tokens, event socket, saved
// sign-ins, storage) into a state per component plus an overall verdict with an action. Pure.

export type HealthState = 'healthy' | 'connecting' | 'degraded' | 'offline' | 'auth-required' | 'error';

export interface HealthItem {
  id: 'riot-client' | 'auth' | 'events' | 'accounts' | 'storage' | 'vault' | 'store' | 'proxy' | 'discord';
  label: string;
  state: HealthState;
  detail: string;
  /** What the user can do about it, when anything. */
  action?: 'reconnect' | 'sign-in' | 'retry-accounts' | 'start-riot-client' | 'open-vault' | 'open-network' | 'open-integrations';
}

export interface HealthInput {
  riotClient: 'up' | 'down';
  /** A Riot Client lockfile exists (the process is running), whether or not it answered. */
  lockfile: boolean;
  tokenSource: 'riot-client' | 'signin' | 'none';
  connStatus: 'waiting' | 'connecting' | 'connected' | 'error';
  connMessage?: string;
  events: 'off' | 'connecting' | 'connected';
  accounts: { label: string; status: 'ok' | 'expired' | 'pending' | 'error' | 'offline' | 'recovering'; retryAt?: number }[];
  accountsReadOnly: boolean;
  /** The current account came from a pinned saved sign-in. */
  pinned: boolean;
  /** Vault: absent when unavailable (e.g. tests). */
  vault?: { lastSnapshotAt?: number; error?: string; now: number };
  /** Active account's store. */
  store?: { status: 'idle' | 'loading' | 'done' | 'error'; cached?: boolean; fetchedAt?: number; error?: string; blocked?: boolean };
  /** Only when a proxy route is configured. */
  proxy?: { mode: 'fallback' | 'proxy'; state: 'unused' | 'ok' | 'failed'; error?: string };
  /** Only when Rich Presence is on. */
  discord?: { state: 'off' | 'no-client-id' | 'connecting' | 'connected' | 'discord-closed' | 'error'; detail: string };
}

export interface HealthReport {
  overall: HealthState;
  summary: string;
  items: HealthItem[];
}

const RANK: Record<HealthState, number> = { healthy: 0, connecting: 1, degraded: 2, offline: 3, 'auth-required': 4, error: 5 };

export function computeHealth(h: HealthInput): HealthReport {
  const items: HealthItem[] = [];
  items.push(
    h.riotClient === 'up'
      ? { id: 'riot-client', label: 'Riot Client', state: 'healthy', detail: 'Running and answering' }
      : h.lockfile
        ? { id: 'riot-client', label: 'Riot Client', state: 'connecting', detail: 'Running but not answering yet (starting, or not signed in)', action: 'reconnect' }
        : { id: 'riot-client', label: 'Riot Client', state: h.tokenSource === 'signin' ? 'degraded' : 'offline', detail: 'Not running. Live, friends and party need it.', action: 'start-riot-client' },
  );
  const anyOk = h.accounts.some((a) => a.status === 'ok');
  items.push(
    h.tokenSource !== 'none' && h.connStatus === 'connected'
      ? { id: 'auth', label: 'Riot sign-in', state: 'healthy', detail: h.tokenSource === 'riot-client' ? 'Using the Riot Client’s account' : `Using a saved sign-in${h.pinned ? ' (pinned)' : ''}` }
      : h.connStatus === 'error'
        ? { id: 'auth', label: 'Riot sign-in', state: 'error', detail: h.connMessage || 'Riot answered with an error', action: 'reconnect' }
        : h.accounts.some((a) => a.status === 'expired') && !anyOk && h.riotClient === 'down'
          ? { id: 'auth', label: 'Riot sign-in', state: 'auth-required', detail: 'Your saved sign-in needs a new login. Your data is kept.', action: 'sign-in' }
          : { id: 'auth', label: 'Riot sign-in', state: h.connStatus === 'connecting' ? 'connecting' : 'offline', detail: h.connMessage || 'No Riot tokens yet', action: 'reconnect' },
  );
  if (h.riotClient === 'up' || h.events !== 'off')
    items.push(
      h.events === 'connected'
        ? { id: 'events', label: 'Instant updates', state: 'healthy', detail: 'Riot Client event socket connected' }
        : { id: 'events', label: 'Instant updates', state: h.events === 'connecting' ? 'connecting' : 'degraded', detail: 'Event socket down: polling instead (a second or two slower)', action: 'reconnect' },
    );
  if (h.accounts.length) {
    const worst = h.accounts.reduce((w, a) => {
      // pending = not needed yet this run (the Riot Client is being used): nothing wrong.
      const s: HealthState = a.status === 'ok' || a.status === 'pending' ? 'healthy' : a.status === 'expired' ? 'auth-required' : a.status === 'offline' ? 'offline' : a.status === 'error' ? 'degraded' : 'connecting';
      return RANK[s] > RANK[w] ? s : w;
    }, 'healthy' as HealthState);
    const bad = h.accounts.filter((a) => a.status !== 'ok' && a.status !== 'pending');
    items.push({
      id: 'accounts',
      label: 'Saved sign-ins',
      // A saved account that can't log in only matters as much as the app depends on it.
      state: worst === 'healthy' ? 'healthy' : h.tokenSource === 'riot-client' && !h.pinned && RANK[worst] > RANK.degraded ? 'degraded' : worst,
      detail: bad.length
        ? bad.map((a) => `${a.label}: ${a.status === 'expired' ? 'needs a new login' : a.status === 'offline' ? 'Riot unreachable, retrying' : a.status === 'recovering' ? 'reconnecting' : 'Riot returned an error'}`).join(' · ')
        : `${h.accounts.length} saved${h.accounts.some((a) => a.status === 'pending') ? ', used when the Riot Client is closed' : ''}`,
      action: bad.some((a) => a.status === 'expired') ? 'sign-in' : bad.length ? 'retry-accounts' : undefined,
    });
  }
  items.push(h.accountsReadOnly ? { id: 'storage', label: 'Account storage', state: 'error', detail: 'accounts.json couldn’t be read, so SexyVal won’t overwrite it. Restart SexyVal; if it persists, restore a backup.' } : { id: 'storage', label: 'Account storage', state: 'healthy', detail: 'Saved' });

  if (h.vault) {
    const v = h.vault;
    const age = v.lastSnapshotAt ? v.now - v.lastSnapshotAt : Infinity;
    items.push(
      v.error
        ? { id: 'vault', label: 'Data vault', state: 'degraded', detail: `Last snapshot failed: ${v.error}. Your previous snapshot is kept.`, action: 'open-vault' }
        : !v.lastSnapshotAt
          ? { id: 'vault', label: 'Data vault', state: 'connecting', detail: 'First snapshot is taken shortly after start' }
          : { id: 'vault', label: 'Data vault', state: age > 3 * 24 * 60 * 60_000 ? 'degraded' : 'healthy', detail: `Last snapshot ${Math.max(1, Math.round(age / 60_000)) < 120 ? `${Math.max(1, Math.round(age / 60_000))} min` : `${Math.round(age / 3_600_000)} h`} ago` },
    );
  }
  if (h.store && h.store.status !== 'idle') {
    const st = h.store;
    const when = st.fetchedAt && h.vault ? `${Math.max(1, Math.round((h.vault.now - st.fetchedAt) / 60_000))} min ago` : 'earlier';
    items.push(
      st.status === 'error'
        ? { id: 'store', label: 'Store sync', state: st.blocked ? 'offline' : 'degraded', detail: `${st.cached ? `Showing the store from ${when}. ` : ''}${st.blocked ? 'Riot’s store servers can’t be reached from this network.' : (st.error ?? 'Refresh failed').slice(0, 140)}`, action: st.blocked ? 'open-network' : 'reconnect' }
        : st.status === 'loading'
          ? { id: 'store', label: 'Store sync', state: 'connecting', detail: 'Refreshing' }
          : { id: 'store', label: 'Store sync', state: 'healthy', detail: 'Up to date' },
    );
  }
  if (h.proxy)
    items.push(
      h.proxy.state === 'failed'
        ? { id: 'proxy', label: 'Store proxy', state: h.proxy.mode === 'proxy' ? 'error' : 'degraded', detail: h.proxy.error ?? 'The proxy didn’t answer', action: 'open-network' }
        : { id: 'proxy', label: 'Store proxy', state: 'healthy', detail: h.proxy.state === 'ok' ? 'Working' : h.proxy.mode === 'fallback' ? 'Standing by (used only if the direct route fails)' : 'Ready' },
    );
  if (h.discord && h.discord.state !== 'off') {
    const d = h.discord;
    // Discord is optional: a closed Discord is never worse than "degraded".
    const state: HealthState = d.state === 'connected' ? 'healthy' : d.state === 'connecting' ? 'connecting' : 'degraded';
    items.push({ id: 'discord', label: 'Discord presence', state, detail: d.detail, action: d.state === 'no-client-id' ? 'open-integrations' : d.state === 'connected' || d.state === 'connecting' ? undefined : 'reconnect' });
  }
  // Overall: what the user is actually blocked by.
  const core = items.filter((i) => i.id === 'auth' || i.id === 'storage');
  let overall = core.reduce((w, i) => (RANK[i.state] > RANK[w] ? i.state : w), 'healthy' as HealthState);
  if (overall === 'healthy' && items.some((i) => i.state !== 'healthy')) overall = 'degraded';
  const top = [...items].sort((a, b) => RANK[b.state] - RANK[a.state])[0];
  const summary = overall === 'healthy' ? 'Everything is connected' : `${top.label}: ${top.detail}`;
  return { overall, summary, items };
}
