// Remote art/video URLs -> our main-process protocols (CSP allows only these).
function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function img(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('svasset:') || url.startsWith('svlocal:')) return url;
  return `svasset://img/${b64url(url)}`;
}

/**
 * `preview: true` marks a hover preview: the main process never caches it and runs at most two at once,
 * so skimming a grid cannot flood the connection. Deliberate plays (detail view) stream and may cache.
 */
export function video(url?: string | null, opts: { preview?: boolean } = {}): string | undefined {
  return url ? `svvideo://v/${b64url(url)}${opts.preview ? '?p=1' : ''}` : undefined;
}

/** Only one video plays at a time across the app. */
let current: HTMLVideoElement | null = null;
const playbackSubs = new Set<() => void>();
/** Conservative on purpose (claimed, not necessarily mid-frame): the auto-updater treats "maybe playing" as "don't interrupt". */
export function isVideoPlaying(): boolean {
  return current !== null;
}
export function onPlaybackChange(fn: () => void): () => void {
  playbackSubs.add(fn);
  return () => playbackSubs.delete(fn);
}
export function claimPlayback(el: HTMLVideoElement): void {
  if (current && current !== el) current.pause();
  current = el;
  playbackSubs.forEach((s) => s());
}
export function releasePlayback(el: HTMLVideoElement): void {
  if (current === el) {
    current = null;
    playbackSubs.forEach((s) => s());
  }
}

/** Stops a <video> and drops its connection. Pausing alone leaves the download running. */
export function unloadVideo(el: HTMLVideoElement | null): void {
  if (!el) return;
  el.pause();
  el.removeAttribute('src');
  el.load();
  releasePlayback(el);
}
