// Mock only: 60 days of shop history for two accounts, with gaps (days the app "wasn't running") and a
// night market, so the Store calendar has something to show. Real data is captured by StoreArchive.
import { ME, rng, uuid } from './data';
import fixtures from './fixtures/collection.json';
import { shopDateAt, type ShopDay } from '../shared/storeArchive';

export const ALT_ACCOUNT = uuid('alt-account');

export function mockShopHistory(now = Date.now()): ShopDay[] {
  const prices = (fixtures as any).prices as Record<string, number>;
  const levels = Object.keys(prices).filter((id) => prices[id] >= 875);
  const today: string[] = (fixtures as any).shop.daily;
  const night: string[] = (fixtures as any).shop.night;
  const out: ShopDay[] = [];
  for (const [account, label] of [
    [ME, 'Vibe#0001'],
    [ALT_ACCOUNT, 'Vibe#ALT'],
  ] as const) {
    const r = rng(`shop-seed-${account}`);
    for (let d = 1; d <= 60; d++) {
      const t = now - d * 86400_000;
      // Gaps: roughly one day in six was never captured.
      if (r() < 0.17) continue;
      // A few skins repeat across the two months, like real rotations do.
      const pick = () => (r() < 0.12 ? today[Math.floor(r() * today.length)] : levels[Math.floor(r() * levels.length)]);
      const daily = Array.from({ length: 4 }, pick).map((levelId) => ({ levelId, vp: prices[levelId] ?? 1775 }));
      const nm = d >= 20 && d <= 33 ? night.map((levelId, i) => ({ levelId, vp: Math.round((prices[levelId] ?? 1775) * (1 - [0.32, 0.18, 0.41, 0.25, 0.12, 0.36][i])), baseVp: prices[levelId] ?? 1775, discountPercent: [32, 18, 41, 25, 12, 36][i] })) : undefined;
      out.push({ account, label, date: shopDateAt(t), daily, night: account === ME ? nm : undefined, firstSeen: t, lastSeen: t });
    }
  }
  return out;
}
