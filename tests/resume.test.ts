import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { ResumeStore } from '../main/services/resume';

describe('ResumeStore', () => {
  const tmp = () => path.join(os.tmpdir(), `sexyval-resume-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

  it('round-trips window bounds, the last reported tab, and the ui flags', async () => {
    const file = tmp();
    const store = new ResumeStore(file);
    store.report({ nav: { view: 'shop', sub: 'bundles', scrollTop: 420, profileQuery: 'me#NA1' }, videoPlaying: true, unsavedLoadoutChanges: false });
    expect(store.getFlags()).toEqual({ videoPlaying: true, unsavedLoadoutChanges: false });

    await store.save({ width: 1280, height: 800, x: 10, y: 20, maximized: false }, true, '1.3.0');
    const fresh = new ResumeStore(file);
    const read = await fresh.consume();
    expect(read).toMatchObject({
      version: '1.3.0',
      window: { width: 1280, height: 800, x: 10, y: 20, maximized: false },
      hiddenInTray: true,
      ui: { view: 'shop', sub: 'bundles', scrollTop: 420, profileQuery: 'me#NA1' },
    });

    // one-shot: consuming again (a normal next start) finds nothing
    expect(await fresh.consume()).toBeNull();
    await expect(fsp.access(file)).rejects.toThrow();
  });

  it('a start with no resume file consumes to null without throwing', async () => {
    const store = new ResumeStore(tmp());
    expect(await store.consume()).toBeNull();
  });

  it('saves null ui when nothing was ever reported', async () => {
    const file = tmp();
    const store = new ResumeStore(file);
    await store.save({ width: 1100, height: 680 }, false, '1.3.0');
    expect((await new ResumeStore(file).consume())?.ui).toBeNull();
  });
});
