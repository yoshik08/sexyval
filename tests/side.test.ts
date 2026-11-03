import { describe, expect, it } from 'vitest';
import { getStartSide, isStartSideVerified, SPIKE_QUEUES } from '../shared/side';

const BOMB = '/Game/GameModes/Bomb/BombGameMode.BombGameMode_C';
const SWIFT = '/Game/GameModes/_Development/Swiftplay_EndOfRoundCredits/Swiftplay_EoRCredits_GameMode.Swiftplay_EoRCredits_GameMode_C';
const DM = '/Game/GameModes/Deathmatch/DeathmatchGameMode.DeathmatchGameMode_C';

describe('getStartSide', () => {
  it('Red attacks first, Blue defends first', () => {
    expect(getStartSide('Red', 'competitive', BOMB)).toBe('ATK');
    expect(getStartSide('Blue', 'competitive', BOMB)).toBe('DEF');
  });
  it('every spike queue gets a side', () => {
    for (const q of SPIKE_QUEUES) expect(getStartSide('Red', q, BOMB)).toBe('ATK');
  });
  it('Swiftplay counts although its mode has no "Bomb" in the name', () => {
    expect(getStartSide('Blue', 'swiftplay', SWIFT)).toBe('DEF');
  });
  it('null for non-spike queues, blank/custom queues and non-spike modes', () => {
    expect(getStartSide('Red', 'deathmatch', DM)).toBeNull();
    expect(getStartSide('Red', 'ggteam', '/Game/GameModes/GunGame/GunGameTeamsGameMode.GunGameTeamsGameMode_C')).toBeNull();
    expect(getStartSide('Red', '', BOMB)).toBeNull();
    expect(getStartSide('Red', undefined, BOMB)).toBeNull();
    expect(getStartSide('Red', 'competitive', DM)).toBeNull();
  });
  it('null for unknown team ids (deathmatch uses the player id as team)', () => {
    expect(getStartSide('a1b2c3d4-0000-0000-0000-000000000000', 'competitive', BOMB)).toBeNull();
    expect(getStartSide('', 'competitive', BOMB)).toBeNull();
    expect(getStartSide(null, 'competitive', BOMB)).toBeNull();
  });
  it('only competitive is verified', () => {
    expect(isStartSideVerified('competitive')).toBe(true);
    expect(isStartSideVerified('unrated')).toBe(false);
    expect(isStartSideVerified('swiftplay')).toBe(false);
  });
});
