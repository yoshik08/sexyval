import { fmtMoney, VP_PRICE, type Currency } from '../../../shared/spending';

/** The display currency: the Spending tab's choice, else ₹ when this PC's time zone is in Asia, else $. */
export function currency(): Currency {
  try {
    const v = localStorage.getItem('sexyval.spending.currency');
    if (v === 'USD' || v === 'INR') return v;
  } catch {
    // storage blocked: fall through
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone.startsWith('Asia/') ? 'INR' : 'USD';
  } catch {
    return 'USD';
  }
}

/** "≈ ₹1,420" for a VP amount, at the 1,000 VP pack price (see shared/spending VP_PRICE). */
export function vpMoney(vp: number | undefined | null): string | null {
  if (!vp || vp <= 0) return null;
  const c = currency();
  return `≈ ${fmtMoney(vp * VP_PRICE[c].perVp, c)}`;
}
