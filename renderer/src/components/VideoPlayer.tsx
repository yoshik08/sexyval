import { useCallback, useEffect, useRef, useState } from 'react';
import { claimPlayback, img, releasePlayback, unloadVideo, video } from '../lib/media';
import { clock, cx } from '../lib/format';
import { ArrowClockwise, ArrowsIn, ArrowsOut, Pause, Play, SpeakerHigh, SpeakerSlash, WarningCircle } from '../lib/icons';
import { Img } from './ui';

type State = 'loading' | 'playing' | 'paused' | 'ended' | 'error';

/**
 * Skin video player (the parent positions it: it must be `relative` or `absolute`). The still render is always underneath and the video fades in on its first frame,
 * so there is never an empty box. Controls are our own (the browser's would break the design) and
 * auto-hide while playing. Space / arrows / M / F work while the player has focus.
 */
export function VideoPlayer({
  src,
  poster,
  alt,
  autoPlay,
  sound,
  onSoundChange,
  onEnded,
  className,
}: {
  src: string;
  poster?: string;
  alt: string;
  autoPlay?: boolean;
  sound: boolean;
  onSoundChange: (on: boolean) => void;
  onEnded?: () => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const scrub = useRef<HTMLInputElement>(null);
  const timeText = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const [state, setState] = useState<State>('loading');
  const [started, setStarted] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [uiVisible, setUiVisible] = useState(true);
  const [full, setFull] = useState(false);
  const [nonce, setNonce] = useState(0);
  const url = video(src);

  useEffect(() => {
    const el = vid.current;
    if (!el) return;
    el.muted = !sound;
    if (autoPlay) {
      claimPlayback(el);
      void el.play().catch((e: Error) => {
        // Unmuted autoplay can be refused; fall back to muted so the clip still starts.
        if (e.name === 'NotAllowedError') {
          el.muted = true;
          void el.play().catch(() => undefined);
        }
      });
    }
    return () => unloadVideo(el);
    // sound is applied separately below so toggling it never restarts the clip
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce, autoPlay]);
  useEffect(() => {
    if (vid.current) vid.current.muted = !sound;
  }, [sound]);

  // Smooth progress: read currentTime every frame while playing, write straight to the DOM.
  useEffect(() => {
    if (state !== 'playing') return;
    let raf = 0;
    const tick = () => {
      const el = vid.current;
      if (el && !dragging.current && Number.isFinite(el.duration) && el.duration > 0) {
        const p = (el.currentTime / el.duration) * 100;
        if (scrub.current) {
          scrub.current.value = String(el.currentTime);
          scrub.current.style.setProperty('--p', `${p}%`);
        }
        if (timeText.current) timeText.current.textContent = `${clock(el.currentTime)} / ${clock(el.duration)}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const poke = useCallback(() => {
    setUiVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setUiVisible(false), 2400);
  }, []);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const toggle = useCallback(() => {
    const el = vid.current;
    if (!el) return;
    if (el.ended) el.currentTime = 0;
    if (el.paused) {
      claimPlayback(el);
      void el.play().catch(() => undefined);
    } else el.pause();
  }, []);
  const seekBy = (d: number) => {
    const el = vid.current;
    if (el && Number.isFinite(el.duration)) el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + d));
  };
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen();
  };

  const showUi = uiVisible || state !== 'playing';
  const dur = vid.current?.duration;

  return (
    <div
      ref={box}
      tabIndex={0}
      onPointerMove={poke}
      onKeyDown={(e) => {
        const keys: Record<string, () => void> = {
          ' ': toggle,
          k: toggle,
          ArrowRight: () => seekBy(5),
          ArrowLeft: () => seekBy(-5),
          m: () => onSoundChange(!sound),
          f: toggleFull,
        };
        const run = keys[e.key];
        if (run) {
          e.preventDefault();
          run();
        }
      }}
      className={cx('group/player overflow-hidden outline-none transition-colors duration-[420ms] ease-out', started ? 'bg-[#050506]' : 'bg-transparent', !showUi && state === 'playing' && 'cursor-none', className)}
    >
      {poster && <Img src={img(poster)} alt={alt} className={cx('absolute inset-0 h-full w-full object-contain p-[7%] transition-opacity duration-[420ms] ease-out', started && state !== 'ended' ? 'opacity-0' : 'opacity-100')} />}

      {state !== 'error' && (
        <video
          key={`${url}-${nonce}`}
          ref={vid}
          src={url}
          playsInline
          preload="auto"
          autoPlay={autoPlay}
          muted={!sound}
          onClick={toggle}
          onPlay={(e) => {
            claimPlayback(e.currentTarget);
            setState('playing');
            poke();
          }}
          onPlaying={() => {
            setStarted(true);
            setBuffering(false);
            setState('playing');
          }}
          onPause={(e) => !e.currentTarget.ended && setState('paused')}
          onWaiting={() => setBuffering(true)}
          onCanPlay={() => setBuffering(false)}
          onLoadedMetadata={(e) => {
            if (scrub.current) {
              scrub.current.max = String(e.currentTarget.duration);
              scrub.current.value = '0';
              scrub.current.style.setProperty('--p', '0%');
            }
          }}
          onEnded={() => {
            setState('ended');
            releasePlayback(vid.current!);
            onEnded?.();
          }}
          onError={() => setState('error')}
          className={cx('absolute inset-0 h-full w-full object-contain transition-opacity duration-[420ms] ease-out', started ? 'opacity-100' : 'opacity-0')}
        />
      )}

      {/* waiting for the first frame / rebuffering: a quick ring, not a blocking overlay */}
      {state !== 'error' && (!started || buffering) && state !== 'paused' && state !== 'ended' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <svg viewBox="0 0 24 24" className="h-8 w-8 animate-[spin_0.8s_linear_infinite] text-white/80" fill="none" aria-label="Loading video">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </div>
      )}

      {state === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-center">
          <WarningCircle size={26} weight="fill" className="text-warn" />
          <p className="max-w-[260px] text-sm text-ink/90">This video could not be loaded. Check your connection and try again.</p>
          <button
            onClick={() => {
              setState('loading');
              setStarted(false);
              setBuffering(false);
              setNonce((n) => n + 1);
            }}
            className="press inline-flex h-9 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-medium text-black">
            <ArrowClockwise size={15} weight="bold" /> Retry
          </button>
        </div>
      )}

      {/* centre affordance only before the first play / after the end */}
      {state === 'ended' && (
        <button onClick={toggle} className="press absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-black" aria-label="Replay">
          <ArrowClockwise size={22} weight="bold" />
        </button>
      )}

      {/* controls: a gradient exists only to keep the white controls legible over bright footage */}
      {state !== 'error' && (
        <div
          className={cx('absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/75 via-black/35 to-transparent px-4 pb-3.5 pt-10 transition-opacity duration-[240ms] ease-out', showUi ? 'opacity-100' : 'pointer-events-none opacity-0')}
        >
          <button onClick={toggle} className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white hover:bg-white/15" aria-label={state === 'playing' ? 'Pause' : 'Play'}>
            {state === 'playing' ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
          </button>
          <input
            ref={scrub}
            type="range"
            className="scrub min-w-0 flex-1"
            min={0}
            max={Number.isFinite(dur) ? dur : 100}
            step="any"
            defaultValue={0}
            aria-label="Seek"
            onPointerDown={() => (dragging.current = true)}
            onPointerUp={() => (dragging.current = false)}
            onChange={(e) => {
              const el = vid.current;
              if (!el) return;
              el.currentTime = Number(e.target.value);
              e.target.style.setProperty('--p', `${(Number(e.target.value) / (el.duration || 1)) * 100}%`);
            }}
          />
          <span ref={timeText} className="num w-[78px] shrink-0 text-right text-xs text-white/80">
            0:00 / 0:00
          </span>
          <button onClick={() => onSoundChange(!sound)} className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white hover:bg-white/15" aria-label={sound ? 'Mute' : 'Unmute'}>
            {sound ? <SpeakerHigh size={18} weight="fill" /> : <SpeakerSlash size={18} weight="fill" />}
          </button>
          <button onClick={toggleFull} className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white hover:bg-white/15" aria-label={full ? 'Exit full screen' : 'Full screen'}>
            {full ? <ArrowsIn size={18} weight="bold" /> : <ArrowsOut size={18} weight="bold" />}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Tile hover preview: muted, loops, plays only while the pointer rests on the tile and the tile is on
 * screen. On leave it drops its connection (pausing alone would keep downloading).
 */
export function HoverPreview({ src, active }: { src?: string; active: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const url = video(src, { preview: true });
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    claimPlayback(el);
    void el.play().catch(() => undefined);
    const io = new IntersectionObserver(([e]) => !e.isIntersecting && el.pause());
    io.observe(el);
    return () => {
      io.disconnect();
      unloadVideo(el);
      setReady(false);
    };
  }, [active, url]);
  if (!url || !active) return null;
  return (
    <video
      ref={ref}
      src={url}
      muted
      playsInline
      loop
      preload="none"
      onPlaying={() => setReady(true)}
      onError={() => setReady(false)}
      className={cx('pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-[240ms] ease-out', ready ? 'opacity-100' : 'opacity-0')}
    />
  );
}
