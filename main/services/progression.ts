import type { ContractView, MissionView, ProgressionView } from '../../shared/features';
import type { RiotApi } from '../riot/api';
import type { CatalogService } from './catalog';
import type { AssetService } from './assets';
import { log } from '../log';

const WEEK = 7 * 24 * 3600 * 1000;

/**
 * Pure: the weekly batch that unlocks in the week containing `at`. Every weekly in the public catalog
 * stays valid until the act ends, so "valid at" would list every earlier week too; the week a batch
 * belongs to is its activation date plus seven days.
 */
export function weekliesActiveAt(missions: any[], at: number): MissionView[] {
  return missions
    .filter((m) => m.type === 'Weekly' && m.activation && m.expiration && Date.parse(m.activation) <= at && at < Math.min(Date.parse(m.activation) + WEEK, Date.parse(m.expiration)))
    .map((m) => ({ id: m.id, title: m.title, type: 'Weekly', xp: m.xp, progress: 0, target: m.target, complete: false, activation: m.activation, expiration: m.expiration }));
}

/** Pure: contract level progress from a contracts entry and its catalog definition. */
export function contractProgress(c: any, def: any): { level: number; maxLevel: number; xpIntoLevel: number; xpForNext: number; next?: { type: string; id: string } } {
  const levels: { xp: number; rewardType: string; rewardId: string }[] = def?.levels ?? [];
  const level = Number(c?.ProgressionLevelReached) || 0;
  const into = Number(c?.ProgressionTowardsNextLevel) || 0;
  const nextDef = levels[level];
  return {
    level,
    maxLevel: levels.length,
    xpIntoLevel: into,
    xpForNext: nextDef ? nextDef.xp : 0,
    next: nextDef ? { type: nextDef.rewardType, id: nextDef.rewardId } : undefined,
  };
}

export class ProgressionService {
  view: ProgressionView = { status: 'idle', dailies: [], weeklies: [], queuedWeeklies: [], agentContracts: [] };

  constructor(
    private readonly api: RiotApi,
    private readonly catalog: CatalogService,
    private readonly assets: AssetService,
  ) {}

  async refresh(): Promise<ProgressionView> {
    this.view = { ...this.view, status: 'loading', error: undefined };
    try {
      await this.catalog.load();
      const [contractsRes, xpRes] = await Promise.all([this.api.contracts(), this.api.accountXp().catch((e) => (log.warn('account-xp failed', e), null))]);
      const cj = contractsRes.json ?? {};
      const missionDefs = new Map(this.catalog.browse.missions.map((m: any) => [m.id, m]));
      const contractDefs = new Map(this.catalog.browse.contracts.map((c: any) => [c.id, c]));

      const missions: MissionView[] = (Array.isArray(cj.Missions) ? cj.Missions : []).map((m: any) => {
        const def = missionDefs.get(String(m.ID).toLowerCase());
        const progress = Object.values(m.Objectives ?? {}).reduce<number>((a, v) => a + (Number(v) || 0), 0);
        return {
          id: m.ID,
          title: def?.title ?? 'Unknown mission',
          type: def?.type ?? 'Unknown',
          xp: def?.xp ?? 0,
          progress,
          target: def?.target ?? def?.objectives?.[0]?.value ?? 0,
          complete: m.Complete === true,
          expiration: m.ExpirationTime,
          activation: def?.activation,
        };
      });
      const currentWeeklyIds = new Set(missions.filter((m) => m.type === 'Weekly').map((m) => m.id));
      const latestExpiry = Math.max(0, ...missions.filter((m) => m.type === 'Weekly' && m.expiration).map((m) => Date.parse(m.expiration!)));
      const queued = this.catalog.browse.missions
        .filter((m: any) => m.type === 'Weekly' && m.activation && !currentWeeklyIds.has(m.id) && Date.parse(m.activation) > Date.now() && (!latestExpiry || Date.parse(m.activation) <= latestExpiry + 7 * 86400000))
        .sort((a: any, b: any) => Date.parse(a.activation) - Date.parse(b.activation))
        .slice(0, 12)
        .map((m: any) => ({ id: m.id, title: m.title, type: 'Weekly', xp: m.xp, progress: 0, target: m.target, complete: false, activation: m.activation, expiration: m.expiration }));

      const now = Date.now();
      const contracts: ContractView[] = (Array.isArray(cj.Contracts) ? cj.Contracts : []).map((c: any) => {
        const id = String(c.ContractDefinitionID).toLowerCase();
        const def = contractDefs.get(id);
        const p = contractProgress(c, def);
        const agent = def?.relationType === 'Agent' ? this.assets.agent(def.relationId) : undefined;
        const reward = p.next ? this.catalog.rewardName(p.next.type, p.next.id) : undefined;
        return {
          id,
          name: def?.name ?? 'Contract',
          kind: def?.relationType ?? 'Unknown',
          relationId: def?.relationId,
          agentName: agent?.name,
          agentIcon: agent?.icon,
          level: p.level,
          maxLevel: p.maxLevel,
          xpIntoLevel: p.xpIntoLevel,
          xpForNext: p.xpForNext,
          nextReward: reward ? { type: p.next!.type, name: reward.name, icon: reward.icon } : undefined,
          active: String(cj.ActiveSpecialContract ?? '').toLowerCase() === id,
          isCurrent: false,
        };
      });
      // Current battle pass / event pass: the season/event whose catalog window contains now.
      const seasonActive = (relId?: string) => {
        const s = this.catalog.browse.seasons.find((x: any) => x.id === relId);
        return s ? Date.parse(s.start) <= now && now < Date.parse(s.end) : false;
      };
      const pick = (kind: string) => {
        const list = contracts.filter((c) => c.kind === kind);
        const cur = list.find((c) => seasonActive(c.relationId)) ?? list[list.length - 1];
        if (cur) cur.isCurrent = true;
        return cur;
      };
      const xp = xpRes?.json?.Progress;
      this.view = {
        status: 'ready',
        accountLevel: Number(xp?.Level) || undefined,
        accountXp: Number(xp?.XP) || undefined,
        dailies: missions.filter((m) => m.type === 'Daily'),
        weeklies: missions.filter((m) => m.type === 'Weekly'),
        queuedWeeklies: queued,
        weeklyCheckpoint: cj.MissionMetadata?.WeeklyCheckpoint,
        weeklyRefill: cj.MissionMetadata?.WeeklyRefillTime,
        battlepass: pick('Season'),
        eventpass: pick('Event'),
        agentContracts: contracts.filter((c) => c.kind === 'Agent').sort((a, b) => b.level - a.level || (a.agentName ?? '').localeCompare(b.agentName ?? '')),
        activeSpecialContract: cj.ActiveSpecialContract,
      };
    } catch (e) {
      this.view = { ...this.view, status: 'error', error: (e as Error).message };
    }
    return this.view;
  }

  futureWeeklies(dateMs: number): MissionView[] {
    return weekliesActiveAt(this.catalog.browse.missions, dateMs);
  }

  async activate(contractId: string): Promise<ProgressionView> {
    await this.api.activateContract(contractId);
    return this.refresh();
  }
}
