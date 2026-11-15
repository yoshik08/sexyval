import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { cx } from '../lib/format';
import { showToast } from './ui';

/** Copies "Name#Tag" to the clipboard and confirms with a short toast. */
export async function copyRiotId(name?: string, tag?: string): Promise<void> {
  if (!name) return;
  const id = tag ? `${name}#${tag}` : name;
  try {
    await api.rpc('clipboard:write', id);
    showToast(`Copied ${id}`);
  } catch {
    showToast('Could not copy the name', 'error');
  }
}

/**
 * A Riot ID anywhere in the app: one click copies "Name#Tag". It never opens anything (rows that open a
 * profile do that from the rest of the row), and the click stops here so a row toggle doesn't fire too.
 */
export function PlayerName({ name, tag, className, tagClassName = 'text-faint', fallback = 'Unknown', children }: { name?: string; tag?: string; className?: string; tagClassName?: string; fallback?: ReactNode; children?: ReactNode }) {
  if (!name) return <span className={className}>{fallback}</span>;
  return (
    <span
      role="button"
      tabIndex={0}
      data-no-toggle
      title={`Copy ${name}${tag ? `#${tag}` : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void copyRiotId(name, tag);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation();
          e.preventDefault();
          void copyRiotId(name, tag);
        }
      }}
      className={cx('cursor-copy rounded-[4px] outline-none transition-colors duration-150 hover:text-white hover:underline hover:decoration-white/30 hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-white/30', className)}
    >
      {name}
      {tag && <span className={tagClassName}>#{tag}</span>}
      {children}
    </span>
  );
}
