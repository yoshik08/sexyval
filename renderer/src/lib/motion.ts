import { gsap } from 'gsap';
import { flushSync } from 'react-dom';

// Motion rules (see the design skills): UI motion 120-280 ms with one exponential ease-out, nothing on
// high-frequency or keyboard-driven actions, one authored moment (a skin's render travelling from its
// tile into the detail sheet), reduced motion respected everywhere.

export const EASE_OUT = 'expo.out';

export function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type VT = { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };

/** Screen change via the View Transitions API, falling back to an instant swap. */
export function withViewTransition(update: () => void): void {
  const doc = document as Document & VT;
  if (!doc.startViewTransition || reducedMotion()) {
    update();
    return;
  }
  doc.startViewTransition(() => flushSync(update));
}

/**
 * Shared-element transition: `from` (a tile's art) and the destination element share the name
 * "skin-art"; the browser morphs one into the other. The name lives on exactly one element in each
 * snapshot (old state: the tile; new state: whatever `after` returns), which the API requires.
 */
export function morphArt(from: HTMLElement | null, update: () => void, after?: () => HTMLElement | null): void {
  const doc = document as Document & VT;
  if (!doc.startViewTransition || reducedMotion() || !from) {
    update();
    return;
  }
  from.style.viewTransitionName = 'skin-art';
  document.documentElement.dataset.vt = 'sheet'; // CSS: fade the sheet, do not slide the page
  const t = doc.startViewTransition(() => {
    from.style.viewTransitionName = '';
    flushSync(update);
    const dest = after?.();
    if (dest) dest.style.viewTransitionName = 'skin-art';
  });
  void t.finished.finally(() => {
    delete document.documentElement.dataset.vt;
    from.style.viewTransitionName = '';
    const dest = after?.();
    if (dest) dest.style.viewTransitionName = '';
  });
}

/** Stagger rows in when a roster first appears (phase change only, not on every update). */
export function staggerIn(container: HTMLElement | null, selector = '[data-row]'): void {
  if (!container || reducedMotion()) return;
  const items = container.querySelectorAll(selector);
  if (!items.length) return;
  gsap.fromTo(items, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.42, ease: EASE_OUT, stagger: 0.035, clearProps: 'opacity,transform' });
}

/** Agent lock-in: brief flash + settle. Rare event, so it may be a little expressive. */
export function lockIn(card: HTMLElement | null): void {
  if (!card || reducedMotion()) return;
  const flash = card.querySelector('[data-flash]');
  const portrait = card.querySelector('[data-portrait]');
  const tl = gsap.timeline();
  if (flash) tl.fromTo(flash, { opacity: 0.55 }, { opacity: 0, duration: 0.5, ease: 'power2.out' }, 0);
  if (portrait) tl.fromTo(portrait, { scale: 1.06 }, { scale: 1, duration: 0.5, ease: EASE_OUT, clearProps: 'transform' }, 0);
  tl.fromTo(card, { y: -2 }, { y: 0, duration: 0.3, ease: EASE_OUT, clearProps: 'transform' }, 0);
}

/** Side badge reveal when the side changes. */
export function reveal(el: HTMLElement | null): void {
  if (!el || reducedMotion()) return;
  gsap.fromTo(el, { opacity: 0, scale: 0.94, filter: 'blur(3px)' }, { opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.3, ease: EASE_OUT, clearProps: 'opacity,transform,filter' });
}

/** Number that eases to its new value (wallet, owned count). Skips the tween for tiny changes. */
export function countTo(el: HTMLElement | null, to: number, fmt: (n: number) => string = (n) => Math.round(n).toLocaleString('en-US')): void {
  if (!el) return;
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = String(to);
  if (reducedMotion() || from === to || Math.abs(to - from) < 2) {
    el.textContent = fmt(to);
    return;
  }
  const o = { v: from };
  gsap.to(o, { v: to, duration: 0.9, ease: 'expo.out', onUpdate: () => (el.textContent = fmt(o.v)) });
}

/** Row expand timings (animate / transitions-dev skills: accordion 200-250 ms open, a bit faster to close). */
export const EXPAND = { open: 0.22, close: 0.17, fadeDelay: 0.06, fadeIn: 0.16, fadeOut: 0.1 } as const;

/**
 * Measured-height expand/collapse. `outer` clips, `inner` is the content (always mounted, so it can be
 * measured). Height tweens from wherever it is now, so a toggle mid-animation reverses smoothly, and
 * rows below slide with it. Ends on `height: auto` so later content changes never get clipped.
 */
export function expandTo(outer: HTMLElement | null, inner: HTMLElement | null, open: boolean): void {
  if (!outer || !inner) return;
  gsap.killTweensOf([outer, inner]);
  if (reducedMotion()) {
    outer.style.height = open ? 'auto' : '0px';
    inner.style.opacity = open ? '1' : '0';
    return;
  }
  const from = outer.getBoundingClientRect().height;
  if (open) {
    gsap.fromTo(outer, { height: from }, { height: inner.offsetHeight, duration: EXPAND.open, ease: EASE_OUT, onComplete: () => void (outer.style.height = 'auto') });
    gsap.fromTo(inner, { opacity: 0 }, { opacity: 1, duration: EXPAND.fadeIn, delay: EXPAND.fadeDelay, ease: 'power1.out' });
  } else {
    gsap.to(inner, { opacity: 0, duration: EXPAND.fadeOut, ease: 'power1.out' });
    gsap.fromTo(outer, { height: from }, { height: 0, duration: EXPAND.close, ease: EASE_OUT });
  }
}
