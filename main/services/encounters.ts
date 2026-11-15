import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { TrimmedDetails } from '../../shared/last5';
import type { Encounter } from '../../shared/features';
import { log } from '../log';

const REBUILD_MS = 5 * 60 * 1000;

/**
 * "Played with you before": every cached match (the on-disk match-details cache, all queues) that has you
 * in it, indexed by the other players. Pure local data: no Riot calls. Rebuilt at most every 5 minutes.
 */
export class EncounterService {
  private index = new Map<string, Encounter>();
  private builtFor: string | null = null;
  private builtAt = 0;
  private building: Promise<void> | null = null;

  constructor(
    private readonly dir: string,
    private readonly me: () => string | null,
  ) {}

  private async build(me: string): Promise<void> {
    const idx = new Map<string, Encounter>();
    let files: string[] = [];
    try {
      files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.v2.json'));
    } catch {
      // no cache yet
    }
    for (const f of files) {
      let d: TrimmedDetails;
      try {
        d = JSON.parse(await fs.readFile(path.join(this.dir, f), 'utf8'));
      } catch {
        continue;
      }
      const mine = d.players?.find((p) => p.subject === me);
      if (!mine) continue;
      const myTeam = d.teams?.find((t) => t.teamId === mine.teamId);
      const won = myTeam?.won ?? false;
      const teamMode = mine.teamId === 'Blue' || mine.teamId === 'Red';
      for (const p of d.players) {
        if (p.subject === me) continue;
        const e = idx.get(p.subject) ?? { puuid: p.subject, with: 0, against: 0, winsWith: 0, winsAgainst: 0, lastAt: 0, lastMatchId: '' };
        const same = teamMode && p.teamId === mine.teamId;
        if (same) {
          e.with++;
          if (won) e.winsWith++;
        } else {
          e.against++;
          if (won) e.winsAgainst++;
        }
        if (d.startTime > e.lastAt) {
          e.lastAt = d.startTime;
          e.lastMatchId = d.matchId;
          e.lastAgent = p.characterId;
          e.lastMap = d.mapId;
        }
        idx.set(p.subject, e);
      }
    }
    this.index = idx;
    this.builtFor = me;
    this.builtAt = Date.now();
    log.info(`encounters: ${idx.size} players from ${files.length} cached matches`);
  }

  private async ready(): Promise<string | null> {
    const me = this.me();
    if (!me) return null;
    if (this.builtFor !== me || Date.now() - this.builtAt > REBUILD_MS) {
      this.building ??= this.build(me).finally(() => (this.building = null));
      await this.building;
    }
    return me;
  }

  async get(puuids: string[]): Promise<Record<string, Encounter>> {
    if (!(await this.ready())) return {};
    const out: Record<string, Encounter> = {};
    for (const p of puuids) {
      const e = this.index.get(p);
      if (e) out[p] = e;
    }
    return out;
  }

  /** Players you've shared the most recent matches with (min. 2 games), newest first. */
  async recent(limit = 40): Promise<Encounter[]> {
    if (!(await this.ready())) return [];
    return [...this.index.values()]
      .filter((e) => e.with + e.against >= 2)
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, limit);
  }
}
