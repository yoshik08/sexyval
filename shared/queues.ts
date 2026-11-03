const TAGS: Record<string, string> = {
  competitive: 'COMP',
  unrated: 'UNR',
  swiftplay: 'SWIFT',
  spikerush: 'SPIKE',
  deathmatch: 'DM',
  hurm: 'TDM',
  ggteam: 'ESC',
  onefa: 'REPL',
  snowball: 'SNOW',
  premier: 'PREM',
  newmap: 'NEW',
  '': 'CUSTOM',
};

const NAMES: Record<string, string> = {
  competitive: 'Competitive',
  unrated: 'Unrated',
  swiftplay: 'Swiftplay',
  spikerush: 'Spike Rush',
  deathmatch: 'Deathmatch',
  hurm: 'Team Deathmatch',
  ggteam: 'Escalation',
  onefa: 'Replication',
  premier: 'Premier',
  newmap: 'New Map',
  snowball: 'Snowball Fight',
  '': 'Custom',
};

/** "competitive" -> "Competitive"; unknown ids are shown as they come. */
export function queueName(queueId: string | null | undefined): string {
  const q = String(queueId ?? '').toLowerCase();
  return NAMES[q] ?? String(queueId ?? '');
}

export function queueTag(queueId: string | null | undefined): string {
  if (queueId == null) return '—';
  const q = String(queueId).toLowerCase();
  return TAGS[q] ?? q.slice(0, 6).toUpperCase();
}

/** "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C" -> "Bomb" */
export function modeName(mode: string | null | undefined): string {
  if (!mode) return 'Unknown';
  const m = /GameModes\/([^/]+)\//.exec(mode);
  const raw = m ? m[1] : mode;
  const pretty: Record<string, string> = {
    Bomb: 'Standard',
    QuickBomb: 'Spike Rush',
    Deathmatch: 'Deathmatch',
    GunGame: 'Escalation',
    OneForAll: 'Replication',
    HURM: 'Team Deathmatch',
    SnowballFight: 'Snowball Fight',
    NewPlayerExperience: 'Tutorial',
  };
  return pretty[raw] ?? raw;
}

export function isBombMode(mode: string | null | undefined): boolean {
  return typeof mode === 'string' && mode.includes('Bomb');
}
