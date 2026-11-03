import { describe, expect, it } from 'vitest';
import { parseLockfile } from '../shared/lockfile';

describe('parseLockfile', () => {
  it('parses a normal lockfile', () => {
    expect(parseLockfile('Riot Client:12345:54321:s3cr3t-Pass_word:https')).toEqual({
      name: 'Riot Client',
      pid: 12345,
      port: 54321,
      password: 's3cr3t-Pass_word',
      protocol: 'https',
    });
  });
  it('tolerates whitespace/newline and names containing colons', () => {
    expect(parseLockfile('Weird:Name:1:2:pw:http\r\n')).toMatchObject({ name: 'Weird:Name', pid: 1, port: 2, password: 'pw', protocol: 'http' });
  });
  it.each([null, undefined, '', 'a:b:c', 'Riot Client:1:notaport:pw:https', 'Riot Client:1:70000:pw:https', 'Riot Client:1:5:pw:ftp', 'Riot Client:1:5::https'])(
    'rejects %s',
    (raw) => expect(parseLockfile(raw as any)).toBeNull(),
  );
});
