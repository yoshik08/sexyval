import { describe, expect, it } from 'vitest';
import { blitzKey, parseTips } from '../main/services/lineupLibrary';

describe('lineup library', () => {
  it('keys match Blitz', () => {
    expect(blitzKey('KAY/O')).toBe('kayo');
    expect(blitzKey('Ascent')).toBe('ascent');
  });
  it('keeps only this agent and map, maps sides, and drops off-site media', () => {
    const json = {
      0: { id: 1, title: 'Mid dart', agentKey: 'sova', mapKey: 'ascent', abilityKey: 'reconbolt', side: 'attacking', difficulty: 'easy', video: 'https://blitz-cdn-videos.blitz.gg/x.mp4', thumbnail: 'https://evil.example/x.jpg', locationX: 49.1, locationY: 18.7, related: { agent: [{ id: 9, agentKey: 'sova', mapKey: 'corrode', title: 'x' }] } },
      1: { id: 2, title: 'Other map', agentKey: 'sova', mapKey: 'corrode' },
      2: { id: 3, title: 'B site', agentKey: 'sova', mapKey: 'ascent', side: 'defending' },
    };
    const out = parseTips(json, 'sova', 'ascent');
    expect(out.map((l) => l.id)).toEqual(['1', '3']);
    expect(out[0]).toMatchObject({ side: 'attack', video: 'https://blitz-cdn-videos.blitz.gg/x.mp4', thumbnail: undefined, x: 49.1 });
    expect(out[1].side).toBe('defense');
  });
});
