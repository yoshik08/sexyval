// Deterministic fake data with realistic Riot response shapes. IDs for agents/maps/skins are
// real valorant-api.com UUIDs so art resolves in mock mode.

export const AGENTS = [
  'add6443a-41bd-e414-f6ad-e58d267f4e95', // Jett
  '569fdd95-4d10-43ab-ca70-79becc718b46', // Sage
  '8e253930-4c05-31dd-1b6c-968525494517', // Omen
  '320b2a48-4d9b-a075-30f1-1f93a9b638fa', // Sova
  '1e58de9c-4950-5125-93e9-a0aee9f98746', // Killjoy
  'f94c3b30-42be-e959-889c-5aa313dba261', // Raze
  '707eab51-4836-f488-046a-cda6bf494859', // Viper
  '5f8d3a7f-467b-97f3-062c-13acf203c006', // Breach
  'dade69b4-4f5a-8528-247b-219e5a1facd6', // Fade
  'a3bfb853-43b2-7238-a4f1-ad90e9e46bcc', // Reyna
  '22697a3d-45bf-8dd7-4fec-84a9e28c69d7', // Chamber
  '1dbf2edd-4729-0984-3115-daa5eed44993', // Clove
  '0e38b510-41a8-5780-5e8f-568b2a4f2d6c', // Iso
  'efba5359-4016-a1e5-7626-b1ae76895940', // Vyse
  '601dbbe7-43ce-be57-2a40-4abd24953621', // KAY/O
];

export const MAPS = [
  '/Game/Maps/Ascent/Ascent',
  '/Game/Maps/Bonsai/Bonsai',
  '/Game/Maps/Duality/Duality',
  '/Game/Maps/Triad/Triad',
  '/Game/Maps/Port/Port',
  '/Game/Maps/Jam/Jam',
  '/Game/Maps/Juliett/Juliett',
  '/Game/Maps/Pitt/Pitt',
];

export const SKIN_LEVELS = [
  'a00e2e2b-431a-1f84-e6d0-a58f4fe1e56b',
  'a3dba920-44ee-d7c5-5227-99a80aee3bd9',
  '636c1f83-44f7-6bc4-0b24-88a1beb66c2d',
  '40fd5a8c-4900-93fc-62c2-aba5c7d208d2',
  'b6d046a8-44f6-4c5c-2429-f3b63b9a5ae8',
  '64f5eaef-434b-69c5-5014-36a58ec1de20',
  '8f254346-439f-0e98-2428-62b0c669d2ae',
  'fe32e4bd-420f-b4cc-de37-febb78df9e16',
  'a2045403-40f7-2926-f955-028b6867c79a',
  '2ab2293c-4e55-933f-1612-a0a2131384d9',
];

export const BOMB_MODE = '/Game/GameModes/Bomb/BombGameMode.BombGameMode_C';
export const DM_MODE = '/Game/GameModes/Deathmatch/DeathmatchGameMode.DeathmatchGameMode_C';

const NAMES = [
  'nightowl', 'Kestrel', 'wasabi', 'tofu enjoyer', 'Pilot', 'mintleaf', 'Vortex', 'sundial', 'Ember', 'quietstorm',
  'Rook', 'lumen', 'Arcadia', 'zeroping', 'bricks', 'Halcyon', 'oolong', 'cinder', 'Mosaic', 'driftwood',
];

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: string): () => number {
  let a = hash(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Warm up: first outputs of similar seeds are correlated.
  for (let i = 0; i < 4; i++) next();
  return next;
}

export function uuid(seed: string): string {
  const r = rng(seed);
  const hex = () => Math.floor(r() * 16).toString(16);
  const part = (n: number) => Array.from({ length: n }, hex).join('');
  return `${part(8)}-${part(4)}-4${part(3)}-a${part(3)}-${part(12)}`;
}

export function pick<T>(r: () => number, arr: T[]): T {
  return arr[Math.floor(r() * arr.length)];
}

export function nameFor(puuid: string): { GameName: string; TagLine: string } {
  const fixed = SQUAD_NAMES.get(puuid);
  if (fixed) return fixed;
  const r = rng('name' + puuid);
  return { GameName: pick(r, NAMES), TagLine: String(1000 + Math.floor(r() * 8999)) };
}

export const ME = 'a1b2c3d4-5e6f-4a1b-8c2d-0000000000aa';

/** The mock squad you queue with (MOCK_SQUAD, mock/career.ts). Fixed names so screenshots read the same. */
export const SQUAD = {
  drain: uuid('squad-drain'),
  carry: uuid('squad-carry'),
  neutral: uuid('squad-neutral'),
  rare: uuid('squad-rare'),
  five: uuid('squad-five'),
} as const;
/** MOCK_SQUAD=many: seven more regulars (12 premades in all). */
export const SQUAD_EXTRA = Array.from({ length: 7 }, (_, i) => uuid(`squad-extra-${i}`));
const SQUAD_NAMES = new Map<string, { GameName: string; TagLine: string }>([
  [SQUAD.drain, { GameName: 'Rahul', TagLine: 'drain' }],
  [SQUAD.carry, { GameName: 'Arjun', TagLine: 'carry' }],
  [SQUAD.neutral, { GameName: 'Kabir', TagLine: 'mid' }],
  [SQUAD.rare, { GameName: 'Dev', TagLine: 'rare' }],
  [SQUAD.five, { GameName: 'Zoya', TagLine: 'five' }],
  ...['Mira', 'Ishaan', 'Tara', 'Neel', 'Anya', 'Rohan', 'Sana'].map((n, i) => [SQUAD_EXTRA[i], { GameName: n, TagLine: 'crew' }] as [string, { GameName: string; TagLine: string }]),
]);
