import { describe, expect, it } from 'vitest';
import { parseRange } from '../shared/range';

describe('parseRange (what the media element sends)', () => {
  const size = 1000;
  it('open-ended from the start: the first request of every video', () => {
    expect(parseRange('bytes=0-', size)).toEqual({ start: 0, end: 999 });
  });
  it('explicit and open-ended offsets', () => {
    expect(parseRange('bytes=100-199', size)).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=900-', size)).toEqual({ start: 900, end: 999 });
  });
  it('suffix ranges (last n bytes: MP4 files with moov at the end)', () => {
    expect(parseRange('bytes=-100', size)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', size)).toEqual({ start: 0, end: 999 });
  });
  it('clamps an end past the file', () => {
    expect(parseRange('bytes=990-5000', size)).toEqual({ start: 990, end: 999 });
  });
  it('rejects what cannot be satisfied or parsed', () => {
    expect(parseRange('bytes=1000-', size)).toBeNull();
    expect(parseRange('bytes=-', size)).toBeNull();
    expect(parseRange('items=0-5', size)).toBeNull();
    expect(parseRange(null, size)).toBeNull();
    expect(parseRange('bytes=0-5', 0)).toBeNull();
  });
});
