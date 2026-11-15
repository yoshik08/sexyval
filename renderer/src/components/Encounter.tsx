import { useEffect, useState } from 'react';
import type { Encounter } from '../../../shared/features';
import { api } from '../lib/api';

// Batched, cached lookups: a 10-player lobby asks once.
const cache = new Map<string, Encounter | null>();
const subs = new Set<() => void>();
let queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function request(p: string) {
  if (cache.has(p) || queue.has(p)) return;
  queue.add(p);
  timer ??= setTimeout(async () => {
    const batch = [...queue].slice(0, 40);
    queue = new Set([...queue].slice(40));
    timer = null;
    try {
      const got = await api.rpc<Record<string, Encounter>>('encounters:get', batch);
      for (const id of batch) cache.set(id, got[id] ?? null);
    } catch {
      for (const id of batch) cache.set(id, null);
    }
    subs.forEach((s) => s());
    if (queue.size) request([...queue][0]);
  }, 60);
}

export function useEncounter(puuid?: string, skip?: boolean): Encounter | null | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!puuid || skip) return;
    const s = () => bump((n) => n + 1);
    subs.add(s);
    request(puuid);
    return () => void subs.delete(s);
  }, [puuid, skip]);
  return puuid ? cache.get(puuid) : undefined;
}

/** "3× with · 2–1": games together (your W–L), and against. Nothing for strangers. */
export function EncounterChip({ puuid, skip, className }: { puuid?: string; skip?: boolean; className?: string }) {
  const e = useEncounter(puuid, skip);
  if (!e || e.with + e.against === 0) return null;
  const parts: string[] = [];
  if (e.with) parts.push(`${e.with}× with`);
  if (e.against) parts.push(`${e.against}× vs`);
  const title = [
    e.with ? `Teammates ${e.with}×: you went ${e.winsWith}–${e.with - e.winsWith}` : '',
    e.against ? `Opponents ${e.against}×: you went ${e.winsAgainst}–${e.against - e.winsAgainst}` : '',
    `Last: ${new Date(e.lastAt).toLocaleDateString()}`,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span title={title} className={'num inline-flex shrink-0 items-center rounded-full bg-[#5ab0ff]/[0.13] px-1.5 py-px text-[10px] font-semibold text-[#8cc8ff] ' + (className ?? '')}>
      Met {parts.join(' · ')}
    </span>
  );
}
