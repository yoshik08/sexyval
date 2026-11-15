import { useEffect, useMemo, useState } from 'react';
import type { SpendingState } from '../../../shared/features';
import { isSkinOwned } from '../../../shared/collection';
import { accountValue, collectionVp, convert, defaultCurrency, fmtMoney, summarize, VP_PRICE, type Currency, type VpPurchase } from '../../../shared/spending';
import { api } from '../lib/api';
import { cx, fmtNum } from '../lib/format';
import { ArrowSquareOut, ClipboardText, Info, MagnifyingGlass, Plus, Receipt, Trash, X } from '../lib/icons';
import { ownedSets, useCatalog, useOwned, usePrices } from '../lib/store';
import { Panel, Segmented, Skeleton, showToast } from '../components/ui';
import { act, Btn, ErrorNote, Note } from '../components/kit';

const CUR_KEY = 'sexyval.spending.currency';
const readCur = (): Currency | null => {
  try {
    const v = localStorage.getItem(CUR_KEY);
    return v === 'USD' || v === 'INR' ? v : null;
  } catch {
    return null;
  }
};
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'PHP', 'IDR', 'MYR', 'THB', 'JPY', 'KRW', 'BRL', 'TRY', 'MXN'];

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: string }) {
  return (
    <Panel className="flex flex-col gap-1 p-5">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={cx('t-num text-[30px] leading-tight', tone ?? 'text-ink')}>{value}</div>
      {sub && <div className="text-xs text-faint">{sub}</div>}
    </Panel>
  );
}

function PreviewSheet({ rows, onClose, onAdd }: { rows: VpPurchase[]; onClose: () => void; onAdd: (rows: VpPurchase[]) => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-8" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet-in flex max-h-full w-full max-w-[640px] flex-col rounded-[24px] bg-[#101012] ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div>
            <h2 className="t-head text-lg text-ink">{rows.length ? `Found ${rows.length} purchase${rows.length === 1 ? '' : 's'}` : 'No purchases found'}</h2>
            <p className="text-xs text-muted">Check them before adding. Ones already in your list are skipped.</p>
          </div>
          <button className="press text-faint hover:text-ink" aria-label="Close" onClick={onClose}>
            <X size={16} weight="bold" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((r) => (
            <div key={r.id} className={cx('grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-line px-6 py-2.5 text-sm last:border-b-0', r.refunded && 'opacity-50')}>
              <span className="text-muted">{day(r.at)}{r.refunded ? ' · refunded' : ''}</span>
              <span className="num text-ink">{fmtNum(r.vp)} VP</span>
              <span className="num w-28 text-right text-muted">{r.amount != null && r.currency ? fmtMoney(r.amount, r.currency) : '—'}</span>
            </div>
          ))}
          {!rows.length && (
            <div className="px-6 py-6 text-sm text-muted">
              Nothing that looks like a VP purchase (a date and a VP amount). On Riot’s page, sign in and press “Get my purchase history” first, then scan again once the list shows.
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-6 py-4">
          <Btn tone="ghost" onClick={onClose}>Cancel</Btn>
          <Btn tone="primary" disabled={!rows.length} onClick={() => onAdd(rows)}>Add {rows.length || ''}</Btn>
        </div>
      </div>
    </div>
  );
}

export function SpendingPanel({ wallet }: { wallet?: number }) {
  const [s, setS] = useState<SpendingState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cur, setCur] = useState<Currency | null>(readCur());
  const [dayFirst, setDayFirst] = useState(false);
  const [preview, setPreview] = useState<VpPurchase[] | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ date: string; vp: string; amount: string; currency: string }>({ date: new Date().toISOString().slice(0, 10), vp: '', amount: '', currency: '' });
  const [bpEdit, setBpEdit] = useState<string | null>(null);
  const catalog = useCatalog();
  const owned = useOwned();
  const prices = usePrices();

  const load = () => void act<SpendingState>('spending:get').then((r) => (r.ok ? setS(r.data) : setErr(r.error)));
  useEffect(() => {
    load();
    return api.on('spending', load);
  }, []);
  const currency: Currency = cur ?? defaultCurrency(s?.region);
  const pick = (c: Currency) => {
    setCur(c);
    try {
      localStorage.setItem(CUR_KEY, c);
    } catch {
      // private mode: the default still works
    }
  };

  const sum = useMemo(() => (s ? summarize(s.purchases, currency, s.fx) : null), [s, currency]);
  const coll = useMemo(() => {
    if (owned.status !== 'ready') return null;
    const sets = ownedSets(owned);
    const list = catalog.skins
      .filter((k) => k.tierId && isSkinOwned(k, sets))
      .map((k) => {
        const q = prices[k.id];
        return { id: k.id, reward: !!k.source, vp: q?.kind === 'exact' || q?.kind === 'approx' ? q.vp : undefined };
      });
    return collectionVp(list);
  }, [owned, catalog.skins, prices]);
  const perVp = VP_PRICE[currency].perVp;
  const collMoney = coll ? coll.vp * perVp : 0;
  const bp = s?.battlePasses ?? 0;
  const fromPurchases = !!sum?.count;
  const av = fromPurchases ? accountValue(sum!.spent, bp, currency, 'purchases') : coll ? accountValue(collMoney + (wallet ?? 0) * perVp, 0, currency, 'collection') : null;

  const commit = async (rows: VpPurchase[]) => {
    const r = await act<{ state: SpendingState; added: number }>('spending:commit', rows);
    setPreview(null);
    setPaste(null);
    if (r.ok) {
      setS(r.data.state);
      showToast(r.data.added ? `Added ${r.data.added} purchase${r.data.added === 1 ? '' : 's'}` : 'All of them were already in your list', 'info');
    } else showToast(r.error, 'error');
  };
  const scan = async () => {
    const r = await act<VpPurchase[]>('spending:scanRiot', dayFirst);
    if (r.ok) setPreview(r.data);
    else showToast(r.error, 'error');
  };
  const addManual = async () => {
    const r = await act<SpendingState>('spending:add', { at: new Date(draft.date + 'T12:00:00').getTime(), vp: Number(draft.vp), amount: draft.amount === '' ? undefined : Number(draft.amount), currency: draft.currency || currency });
    if (r.ok) {
      setS(r.data);
      setDraft((d) => ({ ...d, vp: '', amount: '' }));
    } else showToast(r.error, 'error');
  };

  if (err) return <ErrorNote>{err}</ErrorNote>;
  if (!s || !sum) return <Skeleton className="h-72" />;
  const maxYear = Math.max(1, ...sum.byYear.map((y) => y.spent));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[640px] text-sm text-muted">
          Riot doesn’t expose VP purchases to apps. Pull them from Riot’s own purchase history (you sign in there, SexyVal only reads the list), paste them, or add them by hand. Everything stays on this PC.
        </p>
        <Segmented<Currency> value={currency} onChange={pick} options={[['USD', 'US $'], ['INR', 'India ₹']]} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Stat
          label="Spent on VP"
          value={fromPurchases ? fmtMoney(sum.spent, currency) : '—'}
          sub={fromPurchases ? <>{fmtNum(sum.vp)} VP over {sum.count} purchase{sum.count === 1 ? '' : 's'}{sum.converted ? ` · ${sum.converted} converted` : ''}{sum.pricedFromVp ? ` · ${sum.pricedFromVp} priced from VP` : ''}</> : 'Add your purchases to see this'}
        />
        <Stat
          label="Estimated spend from your collection"
          value={coll ? fmtMoney(collMoney + (wallet ?? 0) * perVp, currency) : '—'}
          sub={coll ? <>{fmtNum(coll.vp)} VP of skins{wallet ? ` + ${fmtNum(wallet)} VP unspent` : ''} · {VP_PRICE[currency].pack}{coll.unpriced ? ` · ${coll.unpriced} owned skins have no price` : ''}</> : owned.status === 'loading' ? 'Reading what you own…' : 'Needs the Riot Client to read what you own'}
        />
        <Stat
          label="Estimated account value"
          tone="text-win"
          value={av ? fmtMoney(av.value, currency) : '—'}
          sub={
            av ? (
              <>
                ({fmtMoney(av.base, currency)}
                {av.basis === 'purchases' && bp ? ` after ${bp} Battle Pass${bp === 1 ? '' : 'es'}` : ''}) ÷ 3 · from {av.basis === 'purchases' ? 'your purchases' : 'your collection'}
              </>
            ) : undefined
          }
        />
      </div>

      <Panel className="flex flex-wrap items-center gap-3 px-5 py-4">
        <Receipt size={18} className="text-muted" />
        <span className="text-sm text-ink">Import</span>
        <Btn size="sm" onClick={() => void act('spending:openRiot')}>
          Open Riot purchase history <ArrowSquareOut size={12} weight="bold" />
        </Btn>
        <Btn size="sm" tone={s.riotWindowOpen ? 'primary' : 'default'} disabled={!s.riotWindowOpen} onClick={() => void scan()} title={s.riotWindowOpen ? 'Read the purchases shown in Riot’s window' : 'Open Riot’s purchase history first'}>
          <MagnifyingGlass size={13} weight="bold" /> Scan the page
        </Btn>
        <Btn size="sm" tone="ghost" onClick={() => setPaste('')}>
          <ClipboardText size={14} /> Paste text
        </Btn>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted" title="How dates like 03/04/2025 are read">
          Dates
          <Segmented<'md' | 'dm'> size="sm" value={dayFirst ? 'dm' : 'md'} onChange={(v) => setDayFirst(v === 'dm')} options={[['md', 'M/D/Y'], ['dm', 'D/M/Y']]} />
        </label>
      </Panel>

      <div className="grid grid-cols-[minmax(0,1fr)_clamp(280px,26vw,340px)] gap-5">
        <Panel>
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <span className="label">Purchases · {s.purchases.length}</span>
            {s.purchases.length > 0 && (
              <button
                className="ml-auto mr-4 text-xs text-muted hover:text-ink"
                onClick={async () => {
                  const esc = (v: unknown) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
                  const rows = [['Date', 'VP', 'Paid', 'Currency', `Paid (${currency})`, 'Source', 'Refunded'], ...s.purchases.map((p) => {
                    const conv = p.amount != null && p.currency ? (p.currency === currency ? p.amount : convert(p.amount, p.currency, currency, s.fx)) : p.vp * perVp;
                    return [new Date(p.at).toISOString().slice(0, 10), p.vp, p.amount ?? '', p.currency ?? '', conv != null ? conv.toFixed(2) : '', p.source, p.refunded ? 'yes' : ''];
                  })];
                  const r = await act<string | null>('spending:csv', rows.map((r) => r.map(esc).join(',')).join('\r\n'));
                  if (r.ok && r.data) showToast('Purchases exported');
                  else if (!r.ok) showToast(r.error, 'error');
                }}
              >
                Export CSV
              </button>
            )}
            {s.purchases.length > 0 && (
              <button
                className="text-xs text-faint hover:text-loss"
                onClick={async () => {
                  if (!window.confirm('Remove every purchase from this list?')) return;
                  const r = await act<SpendingState>('spending:clear');
                  if (r.ok) setS(r.data);
                }}
              >
                Clear all
              </button>
            )}
          </div>
          {s.purchases.map((p) => {
            const conv = p.amount != null && p.currency && p.currency !== currency ? convert(p.amount, p.currency, currency, s.fx) : undefined;
            return (
              <div key={p.id} className={cx('group grid grid-cols-[110px_1fr_auto_auto] items-center gap-4 border-b border-line px-5 py-2.5 text-sm last:border-b-0', p.refunded && 'opacity-45')}>
                <span className="text-muted">{day(p.at)}</span>
                <span className="num text-ink">
                  {fmtNum(p.vp)} VP
                  {p.refunded && <span className="ml-2 text-2xs font-semibold uppercase text-loss">refunded</span>}
                  <span className="ml-2 text-2xs text-faint">{p.source === 'riot' ? 'Riot' : p.source === 'paste' ? 'pasted' : 'manual'}</span>
                </span>
                <span className="num text-right">
                  {p.amount != null && p.currency ? (
                    <>
                      <span className="text-ink">{fmtMoney(p.amount, p.currency)}</span>
                      {conv != null && <span className="ml-1.5 text-xs text-faint">≈ {fmtMoney(conv, currency)}</span>}
                    </>
                  ) : (
                    <span className="text-faint" title={`No price recorded: counted at ${VP_PRICE[currency].pack}`}>≈ {fmtMoney(p.vp * perVp, currency)}</span>
                  )}
                </span>
                <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button className="rounded-full px-2 py-1 text-2xs text-muted hover:bg-white/[0.08] hover:text-ink" onClick={async () => { const r = await act<SpendingState>('spending:refunded', p.id, !p.refunded); if (r.ok) setS(r.data); }}>
                    {p.refunded ? 'Not refunded' : 'Refunded'}
                  </button>
                  <button className="rounded-full p-1.5 text-faint hover:bg-loss/[0.15] hover:text-loss" aria-label="Delete" onClick={async () => { const r = await act<SpendingState>('spending:remove', p.id); if (r.ok) setS(r.data); }}>
                    <Trash size={13} />
                  </button>
                </span>
              </div>
            );
          })}
          {!s.purchases.length && <div className="px-5 py-6 text-sm text-muted">No purchases yet. Import them from Riot’s purchase history, or add one on the right.</div>}
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel className="flex flex-col gap-3 p-5">
            <div className="label">Add a purchase</div>
            <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} className="field" />
            <div className="flex gap-2">
              <input inputMode="numeric" value={draft.vp} onChange={(e) => setDraft({ ...draft, vp: e.target.value.replace(/[^\d]/g, '') })} placeholder="VP (e.g. 1000)" className="field min-w-0 flex-1" />
            </div>
            <div className="flex gap-2">
              <input inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value.replace(/[^\d.]/g, '') })} placeholder="Paid (optional)" className="field min-w-0 flex-1" />
              <select value={draft.currency || currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} className="field w-24">
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <p className="text-2xs text-faint">A US VP card on an Indian account? Pick USD: it’s converted at today’s rate.</p>
            <Btn tone="primary" disabled={!draft.vp || !draft.date} onClick={() => void addManual()}>
              <Plus size={14} weight="bold" /> Add
            </Btn>
          </Panel>

          <Panel className="flex flex-col gap-2 p-5">
            <div className="label">Battle Passes</div>
            <div className="flex items-center gap-2 text-sm text-muted">
              {bpEdit == null ? (
                <>
                  <span className="t-num text-xl text-ink">{s.battlePasses ?? '—'}</span>
                  <span>× 1,000 VP, left out of the account value</span>
                  <button className="ml-auto text-xs text-muted hover:text-ink" onClick={() => setBpEdit(String(s.battlePasses ?? 0))}>Edit</button>
                </>
              ) : (
                <form
                  className="flex w-full items-center gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const r = await act<SpendingState>('spending:battlePasses', bpEdit === '' ? null : Number(bpEdit));
                    if (r.ok) setS(r.data);
                    setBpEdit(null);
                  }}
                >
                  <input autoFocus inputMode="numeric" value={bpEdit} onChange={(e) => setBpEdit(e.target.value.replace(/[^\d]/g, ''))} className="field w-20" />
                  <Btn size="sm" type="submit">Save</Btn>
                  {s.battlePassOverride != null && (
                    <Btn size="sm" tone="ghost" onClick={async () => { const r = await act<SpendingState>('spending:battlePasses', null); if (r.ok) setS(r.data); setBpEdit(null); }}>
                      Use detected
                    </Btn>
                  )}
                </form>
              )}
            </div>
            <p className="text-2xs text-faint">
              {s.battlePassError ? `Couldn’t read them: ${s.battlePassError}.` : s.battlePassOverride != null ? `Set by you (detected: ${s.battlePassesDetected ?? '—'}).` : 'Detected from the premium passes on your account.'}
            </p>
          </Panel>

          {sum.byYear.length > 0 && (
            <Panel className="flex flex-col gap-2.5 p-5">
              <div className="label">By year</div>
              {sum.byYear.map((y) => (
                <div key={y.year} className="grid grid-cols-[44px_1fr_auto] items-center gap-3 text-sm">
                  <span className="num text-muted">{y.year}</span>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                    <div className="h-full rounded-full bg-white" style={{ width: `${(y.spent / maxYear) * 100}%` }} />
                  </div>
                  <span className="num text-ink">{fmtMoney(y.spent, currency)}</span>
                </div>
              ))}
            </Panel>
          )}
        </div>
      </div>

      <Note>
        <span className="inline-flex items-start gap-2">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>
            Other currencies are converted with ECB reference rates{s.fx.fallback ? ' (built-in rates: live ones couldn’t load)' : ` from ${s.fx.date}`}. Account value is a rule of thumb: what went into the account, minus Battle Passes, divided by 3. The collection estimate prices owned skins at their store price (Battle Pass and other rewards left out) and doesn’t see bundle discounts or Night Market deals.
          </span>
        </span>
      </Note>

      {paste != null && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-8" role="dialog" aria-modal="true" onClick={() => setPaste(null)}>
          <div className="sheet-in flex w-full max-w-[640px] flex-col gap-3 rounded-[24px] bg-[#101012] p-6 ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
            <h2 className="t-head text-lg text-ink">Paste your purchase history</h2>
            <p className="text-sm text-muted">Select the list on Riot’s purchase-history page (or a receipt email), copy, and paste it here. Each purchase needs a date and a VP amount; the price and currency are read when they’re there.</p>
            <textarea autoFocus rows={10} value={paste} onChange={(e) => setPaste(e.target.value)} className="field-area font-mono text-xs" placeholder={'Nov 14, 2026   1,000 VP   $9.99\n2026-10-02   5,350 VP   ₹3,999'} />
            <div className="flex justify-end gap-2">
              <Btn tone="ghost" onClick={() => setPaste(null)}>Cancel</Btn>
              <Btn
                tone="primary"
                disabled={!paste.trim()}
                onClick={async () => {
                  const r = await act<VpPurchase[]>('spending:preview', paste, dayFirst);
                  if (r.ok) {
                    setPaste(null);
                    setPreview(r.data);
                  }
                  else showToast(r.error, 'error');
                }}
              >
                Read purchases
              </Btn>
            </div>
          </div>
        </div>
      )}
      {preview && <PreviewSheet rows={preview} onClose={() => setPreview(null)} onAdd={(rows) => void commit(rows)} />}
    </div>
  );
}
