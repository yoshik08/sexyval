import { describe, expect, it } from 'vitest';
import { enemyStacks, groupParties, partyOfPresence } from '../shared/party';

describe('party brackets', () => {
  it('reads partyId flat or nested', () => {
    expect(partyOfPresence({ partyId: 'p1' })).toBe('p1');
    expect(partyOfPresence({ partyPresenceData: { partyId: 'p2' } })).toBe('p2');
    expect(partyOfPresence({ partyId: '' })).toBeUndefined();
    expect(partyOfPresence(null)).toBeUndefined();
  });

  it('groups 2+ on the same team, lettered per team', () => {
    const rows = [
      { puuid: 'a', teamId: 'Blue' },
      { puuid: 'b', teamId: 'Blue' },
      { puuid: 'c', teamId: 'Blue' },
      { puuid: 'd', teamId: 'Red' },
      { puuid: 'e', teamId: 'Red' },
      { puuid: 'f', teamId: 'Red' },
    ];
    const party: Record<string, string> = { a: 'x', b: 'x', c: 'solo', d: 'y', e: 'y', f: 'x' };
    const g = groupParties(rows, (p) => party[p]);
    expect(g.get('a')).toEqual({ id: 'x', size: 2, index: 0 });
    expect(g.get('b')).toEqual({ id: 'x', size: 2, index: 0 });
    expect(g.has('c')).toBe(false);
    expect(g.get('d')).toEqual({ id: 'y', size: 2, index: 0 });
    expect(g.has('f')).toBe(false); // same id, other team
    expect(enemyStacks([{ partyId: '1' }, { partyId: '1' }, { partyId: '2' }, { partyId: '2' }, { partyId: '2' }])).toBe('2+3');
    expect(enemyStacks([{ partyId: '1' }, { partyId: '2' }])).toBe('solo');
    expect(enemyStacks([{ partyId: '1' }, {}])).toBeUndefined();
  });
});
