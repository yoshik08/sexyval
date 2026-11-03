import { redact } from '../../shared/redact';
import type { DebugDump } from '../../shared/types';
import { log } from '../log';

// Fields we already parse/know. Anything else in pregame/core-game shows up as "unparsed"
// so new fields Riot adds are easy to spot.
const KNOWN: Record<string, Set<string>> = {
  pregameMatch: new Set([
    'ID', 'Version', 'Teams', 'AllyTeam', 'EnemyTeam', 'ObserverSubjects', 'MatchCoaches', 'EnemyTeamSize',
    'EnemyTeamLockCount', 'PregameState', 'LastUpdated', 'MapID', 'MapSelectPool', 'BannedMapIDs', 'CastedVotes',
    'MapSelectSteps', 'MapSelectStep', 'Team1', 'GamePodID', 'Mode', 'VoiceSessionID', 'MUCName', 'TeamMatchToken',
    'QueueID', 'ProvisioningFlowID', 'IsRanked', 'PhaseTimeRemainingNS', 'StepTimeRemainingNS',
  ]),
  coreGameMatch: new Set([
    'MatchID', 'Version', 'State', 'MapID', 'ModeID', 'ProvisioningFlow', 'GamePodID', 'AllMUCName', 'TeamMUCName',
    'TeamVoiceID', 'TeamMatchToken', 'IsReconnectable', 'ConnectionDetails', 'PostGameDetails', 'Players',
    'MatchmakingData', 'QueueID',
  ]),
};

export class DebugStore {
  private raw: Record<string, { at: number; data: unknown }> = {};
  private unknown: Record<string, string[]> = {};

  put(key: string, data: unknown): void {
    try {
      this.raw[key] = { at: Date.now(), data: redact(data) };
      const known = KNOWN[key];
      const body = (data as any)?.body ?? data;
      if (known && body && typeof body === 'object') {
        const extra = Object.keys(body).filter((k) => !known.has(k));
        const prev = new Set(this.unknown[key] ?? []);
        for (const k of extra) {
          if (!prev.has(k)) log.info(`debug: unparsed field ${key}.${k}`);
          prev.add(k);
        }
        this.unknown[key] = [...prev];
      }
    } catch (e) {
      log.warn('debug store failed', e);
    }
  }

  dump(): DebugDump {
    return { raw: this.raw, unknownKeys: this.unknown, logs: log.tail(300) };
  }
}
