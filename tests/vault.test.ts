import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeVault, encodeVault, VaultService } from '../main/services/vault';
import { checkEnvelope, keepSnapshots, sanitizePayload, VAULT_HEADER, VAULT_MAGIC, VAULT_SCHEMA } from '../shared/vault';
import crypto from 'node:crypto';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-vault-'));
  const data = path.join(base, 'data');
  const root = path.join(base, 'vault');
  await fs.mkdir(path.join(data, 'mmr-updates'), { recursive: true });
  await fs.mkdir(path.join(data, 'matches'), { recursive: true });
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ autoUpdate: true, henrikKey: 'SECRET', window: { w: 1 } }));
  await fs.writeFile(path.join(data, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'a1', puuid: 'p', name: 'Yoshi' }], activeId: 'a1' }));
  await fs.writeFile(path.join(data, 'wishlist.json'), JSON.stringify({ skinIds: ['s1'] }));
  await fs.writeFile(path.join(data, 'mmr-updates', 'bb6e6667-a433-5f80-8d76-bb074fd8a482.json'), JSON.stringify({ v: 1, updates: [1] }));
  await fs.writeFile(path.join(data, 'matches', '78ed339b-8afa-4cd6-a4e4-9baecc04f1b5.v2.json'), JSON.stringify({ matchId: 'm' }));
  const v = new VaultService((...p: string[]) => path.join(data, ...p), '9.9.9', root);
  await v.init();
  return { data, root, v };
}

describe('SexyVal vault', () => {
  it('snapshots are valid, secrets stay out, and the previous one moves to history', async () => {
    const { root, v } = await setup();
    await v.snapshot('auto');
    const first = decodeVault(await fs.readFile(path.join(root, 'sexyval.sxyval')));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.payload.files['wishlist.json']).toEqual({ skinIds: ['s1'] });
    expect(first.payload.files['settings.json']).toEqual({ autoUpdate: true });
    expect(Object.keys(first.payload.mmrUpdates)).toHaveLength(1);
    expect(first.envelope.payloadText).not.toContain('SECRET');
    await new Promise((r) => setTimeout(r, 5));
    await v.snapshot('auto');
    expect((await fs.readdir(path.join(root, 'history'))).length).toBe(1);
    expect((await fs.readdir(path.join(root, 'matches'))).length).toBe(1);
    const st = await v.status();
    expect(st.health).toBe('ok');
    expect(st.versions.filter((x) => x.ok)).toHaveLength(2);
  });

  it('an interrupted write (leftover temp file) never replaces the valid snapshot', async () => {
    const { root, v } = await setup();
    await v.snapshot('auto');
    await fs.writeFile(path.join(root, 'sexyval.sxyval.123.tmp'), 'half a file');
    await v.init();
    expect((await fs.readdir(root)).some((f) => f.endsWith('.tmp'))).toBe(false);
    expect((await v.best())?.file).toBe(path.join(root, 'sexyval.sxyval'));
  });

  it('a corrupted current snapshot falls back to the newest valid history copy', async () => {
    const { root, data, v } = await setup();
    await v.snapshot('auto');
    await new Promise((r) => setTimeout(r, 5));
    await v.snapshot('auto');
    const cur = await fs.readFile(path.join(root, 'sexyval.sxyval'));
    cur[cur.length - 5] ^= 0xff; // flip bits inside the gzip stream
    await fs.writeFile(path.join(root, 'sexyval.sxyval'), cur);
    expect(decodeVault(cur).ok).toBe(false);
    await fs.rm(path.join(data, 'wishlist.json'));
    const r = await v.recoverMissing();
    expect(r.restored).toContain('wishlist.json');
    expect((await fs.readdir(root)).some((f) => f.includes('.corrupt-'))).toBe(true);
    expect(decodeVault(await fs.readFile(path.join(root, 'sexyval.sxyval'))).ok).toBe(true);
  });

  it('reinstall: missing files come back, existing (newer) files are never overwritten', async () => {
    const { data, v } = await setup();
    await v.snapshot('auto');
    await fs.rm(path.join(data, 'accounts.json'));
    await fs.rm(path.join(data, 'matches'), { recursive: true });
    await fs.rm(path.join(data, 'mmr-updates'), { recursive: true });
    await fs.writeFile(path.join(data, 'wishlist.json'), JSON.stringify({ skinIds: ['newer'] }));
    const r = await v.recoverMissing();
    expect(r.restored).toEqual(expect.arrayContaining(['accounts.json', 'mmr-updates/bb6e6667-a433-5f80-8d76-bb074fd8a482.json', '1 cached matches']));
    expect(JSON.parse(await fs.readFile(path.join(data, 'wishlist.json'), 'utf8'))).toEqual({ skinIds: ['newer'] });
    expect(JSON.parse(await fs.readFile(path.join(data, 'accounts.json'), 'utf8')).accounts[0].name).toBe('Yoshi');
    // Nothing missing: nothing written.
    expect((await v.recoverMissing()).restored).toEqual([]);
  });

  it('restore keeps this PC’s HenrikDev key and window; full exports carry matches', async () => {
    const { data, v, root } = await setup();
    const out = path.join(root, 'export.sxyval');
    await v.exportTo(out, true);
    const ex = decodeVault(await fs.readFile(out));
    expect(ex.ok && Object.keys(ex.payload.matches ?? {})).toHaveLength(1);
    await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ autoUpdate: false, henrikKey: 'MINE', window: { w: 2 } }));
    await fs.rm(path.join(data, 'matches'), { recursive: true });
    await v.importFile(out);
    expect(JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8'))).toEqual({ autoUpdate: true, henrikKey: 'MINE', window: { w: 2 } });
    expect(await fs.readdir(path.join(data, 'matches'))).toHaveLength(1);
  });

  it('migrates a 1.6 backup .json (schema 0)', () => {
    const legacy = { app: 'SexyVal', version: '1.6.0', exportedAt: 5, settings: { autoUpdate: false, henrikKey: 'x' }, files: { 'wishlist.json': { skinIds: ['a'] }, 'evil.json': 1 } };
    const r = decodeVault(Buffer.from(JSON.stringify(legacy)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.files['wishlist.json']).toEqual({ skinIds: ['a'] });
    expect(r.payload.files['settings.json']).toEqual({ autoUpdate: false });
    expect(Object.keys(r.payload.files)).not.toContain('evil.json');
  });

  it('refuses tampered, foreign and newer-version files; strips unsafe names', () => {
    const payloadText = JSON.stringify({ files: {}, mmrUpdates: { '../../evil.json': 1 }, matches: { '..\\x.v2.json': 1 }, matchCount: 0 });
    const env = { magic: VAULT_MAGIC, schema: VAULT_SCHEMA, createdAt: 1, appVersion: '1', reason: 'export', sha256: sha(payloadText), payloadText };
    const ok = decodeVault(encodeVault(env as any));
    expect(ok.ok && ok.payload).toMatchObject({ mmrUpdates: {}, matches: {} });
    expect(checkEnvelope({ ...env, payloadText: payloadText.replace('0', '1') }, sha)).toMatchObject({ ok: false, error: expect.stringContaining('Checksum') });
    expect(checkEnvelope({ ...env, schema: VAULT_SCHEMA + 1 }, sha)).toMatchObject({ ok: false, error: expect.stringContaining('newer') });
    expect(decodeVault(Buffer.concat([Buffer.from(VAULT_HEADER), zlib.gzipSync('{"magic":"other"}')])).ok).toBe(false);
    expect(decodeVault(Buffer.from('not json')).ok).toBe(false);
    expect(() => sanitizePayload(null)).toThrow();
  });

  it('keeps the newest 6 snapshots plus one per day for 14 days', () => {
    const day = 24 * 3_600_000;
    const now = Date.UTC(2026, 10, 16, 12);
    const times = [...Array.from({ length: 10 }, (_, i) => now - i * 60_000), ...Array.from({ length: 30 }, (_, i) => now - (i + 1) * day)];
    const keep = keepSnapshots(times);
    expect(keep.size).toBe(6 + 13); // today's day is already covered by the recent ones
    expect(keep.has(now - 30 * day)).toBe(false);
  });
});
