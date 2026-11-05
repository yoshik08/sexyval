import { BrowserWindow, screen } from 'electron';
import type { AppState, Settings } from '../shared/types';
import { UNVERIFIED_NOTE } from '../shared/side';
import { log } from './log';

/**
 * Agent-select overlay: a small always-on-top black panel with the map and your starting side.
 *
 * It is an ordinary window: no injection, hooks, memory reading or screen capture. It never takes
 * focus (focusable: false, showInactive) and lets every click through. It shows only during agent
 * select and only the map and your starting side (never enemy info), and hides the moment the phase
 * changes. Windows can draw it over Valorant in Windowed or Windowed Fullscreen, not over exclusive
 * Fullscreen (an OS limit; nothing here tries to get around it).
 */

/**
 * The window is exactly as tall as the panel and wider than it: the panel sizes to its content and
 * hugs the chosen edge, the rest stays transparent and click-through. Widths fit the longest map name
 * in the game ("Fracture", "Corrode") with "Defense first" at each size, measured from the rendered
 * panel (see README). No shadow, so nothing is drawn outside the panel.
 */
const SIZES = { small: { width: 330, height: 50 }, medium: { width: 400, height: 62 } } as const;
const MARGIN = 16;
export const FADE_MS = 200;
/** How long "Match found" shows after the queue pops (until the map is known). */
const FOUND_MS = 3500;

export interface OverlayContent {
  map?: string;
  mapIcon?: string;
  side?: 'ATK' | 'DEF' | null;
  found?: boolean;
}

/**
 * Minimal AMOLED panel: solid black rectangle, 1 px hairline border, the map image and two lines of
 * text per half. No gradients, glow or shadow. Motion: fade + 4 px drop, 200 ms strong ease-out.
 */
export const OVERLAY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
body{display:flex;align-items:stretch;justify-content:center;font-family:"Segoe UI Variable Display","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body.left{justify-content:flex-start}body.right{justify-content:flex-end}
.panel{display:flex;align-items:center;gap:var(--gap);box-sizing:border-box;height:100%;padding:0 var(--pad) 0 var(--padl);border-radius:var(--r);
  background:#000;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);white-space:nowrap;
  opacity:0;transform:translateY(-4px);transition:opacity ${FADE_MS}ms cubic-bezier(.23,1,.32,1),transform ${FADE_MS}ms cubic-bezier(.23,1,.32,1)}
.panel.on{opacity:1;transform:none}
.map{display:flex;align-items:center;gap:var(--gap)}
.map img{display:block;height:var(--img);width:calc(var(--img) * 2);object-fit:cover;border-radius:var(--ir)}
.t b{display:block;font-size:var(--big);line-height:1.15;font-weight:600;letter-spacing:-.01em;color:#fff}
.t i{display:block;margin-top:1px;font-style:normal;font-size:var(--small);line-height:1.2;font-weight:500;color:rgba(255,255,255,.45)}
.sep{align-self:stretch;width:1px;margin:var(--sepm) 0;background:rgba(255,255,255,.12)}
.atk #sl{color:#ff4655}.def #sl{color:#4aa3ff}
[hidden]{display:none!important}
</style></head><body><div id="p" class="panel"><div class="map" id="mw"><img id="mi" alt=""><div class="t"><b id="mn"></b><i id="ml">Map</i></div></div><span class="sep" id="sep"></span><div class="t" id="sw"><b id="sl"></b><i>Starting side</i></div></div>
<script>
const $=(id)=>document.getElementById(id);
$('mi').onerror=()=>{$('mi').hidden=true};
const SIZE={small:{r:'8px',ir:'4px',gap:'12px',pad:'16px',big:'15px',small:'10.5px',img:'36px',sepm:'11px'},medium:{r:'10px',ir:'5px',gap:'14px',pad:'20px',big:'18px',small:'11.5px',img:'46px',sepm:'14px'}};
window.render=(c,on,small,align)=>{const p=$('p'),r=document.documentElement.style,z=SIZE[small?'small':'medium'];
 for(const k in z) r.setProperty('--'+k,z[k]);
 document.body.className=align||'';
 if(c){const hasMap=!!(c.map||c.found),hasSide=!!c.side;
  $('mw').hidden=!hasMap;$('sw').hidden=!hasSide;$('sep').hidden=!(hasMap&&hasSide);
  if(c.mapIcon){if($('mi').getAttribute('src')!==c.mapIcon){$('mi').hidden=false;$('mi').src=c.mapIcon;}}else $('mi').hidden=true;
  $('mn').textContent=c.map||'Match found';
  $('ml').textContent=c.map?(c.found?'Match found':'Map'):'Loading map';
  r.setProperty('--padl',hasMap&&c.mapIcon&&!$('mi').hidden?'8px':z.pad);
  if(hasSide){$('sl').textContent=c.side==='ATK'?'Attack first':'Defense first';p.className='panel '+(c.side==='ATK'?'atk':'def')+(p.classList.contains('on')?' on':'');}}
 requestAnimationFrame(()=>requestAnimationFrame(()=>p.classList.toggle('on',!!on)));};
window.measure=()=>{const b=document.getElementById('p').getBoundingClientRect();return {width:Math.round(b.width),height:Math.round(b.height),window:innerWidth};};
</script></body></html>`;

export class AgentSelectOverlay {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private visible = false;
  private shownKey: string | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  private prevPhase: AppState['phase'] | null = null;
  private foundUntil = 0;
  private foundTimer: NodeJS.Timeout | null = null;
  private last: AppState | null | undefined = null;

  constructor(private readonly settings: () => Settings) {}

  /** Called on every state emit. Shows only in agent select, once the map or the side is known. */
  update(state: AppState | null | undefined): void {
    this.last = state;
    const s = this.settings();
    const phase = state?.conn.status === 'connected' ? state.phase : null;
    // Queue popped: show "Match found" at once, before the map or side arrive.
    if (this.prevPhase === 'queue' && phase === 'pregame' && s.overlayMatchFound) {
      this.foundUntil = Date.now() + FOUND_MS;
      if (this.foundTimer) clearTimeout(this.foundTimer);
      this.foundTimer = setTimeout(() => this.update(this.last), FOUND_MS + 20);
    }
    if (phase !== 'pregame') this.foundUntil = 0;
    this.prevPhase = phase;
    if (!s.overlayEnabled || phase !== 'pregame') return this.hide();
    const pg = state?.pregame;
    const c: OverlayContent = {
      map: pg?.map?.name && pg.map.name !== 'Unknown' ? pg.map.name : undefined,
      mapIcon: pg?.map?.listIcon,
      side: pg?.side.side ?? null,
      found: Date.now() < this.foundUntil,
    };
    if (!c.map && !c.side && !c.found) return this.hide();
    void this.show(c, pg?.side.verified ?? false);
  }

  /** Re-place and re-size after a settings or display change. */
  relayout(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setBounds(this.bounds());
    if (this.visible) void this.win.webContents.executeJavaScript(`render(null, true, ${this.settings().overlayScale === 'small'}, ${JSON.stringify(this.align())})`).catch(() => undefined);
  }

  hide(): void {
    if (!this.visible || !this.win || this.win.isDestroyed()) return;
    this.visible = false;
    this.shownKey = null;
    void this.win.webContents.executeJavaScript('render(null, false)').catch(() => undefined);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.visible && this.win && !this.win.isDestroyed()) this.win.hide();
    }, FADE_MS + 10);
  }

  destroy(): void {
    if (this.foundTimer) clearTimeout(this.foundTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = null;
  }

  /** The overlay's renderer, for screenshots in mock mode. */
  get webContents() {
    return this.win && !this.win.isDestroyed() && this.visible ? this.win.webContents : null;
  }

  private align(): string {
    const p = this.settings().overlayPosition;
    return p === 'top-left' ? 'left' : p === 'top-right' ? 'right' : '';
  }

  private async show(c: OverlayContent, verified: boolean): Promise<void> {
    const win = this.ensure();
    await this.ready;
    if (win.isDestroyed()) return;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    const small = this.settings().overlayScale === 'small';
    const key = JSON.stringify([c, small]);
    if (this.visible && this.shownKey === key) return;
    const appearing = !this.visible;
    this.visible = true;
    this.shownKey = key;
    // A click-through window cannot show hover text, so the unverified note goes in the window title.
    win.setTitle(c.side && !verified ? `Agent select (${UNVERIFIED_NOTE})` : 'Agent select');
    if (appearing) {
      win.setBounds(this.bounds());
      win.showInactive();
      // Borderless games can take the top of the z-order back after alt-tab: claim it on every show.
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    }
    await win.webContents.executeJavaScript(`render(${JSON.stringify(c)}, true, ${small}, ${JSON.stringify(this.align())})`).catch((e) => log.warn('overlay render failed', e));
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const { width, height } = SIZES[this.settings().overlayScale];
    const win = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'Agent select',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('closed', () => {
      this.win = null;
      this.ready = null;
      this.visible = false;
    });
    this.ready = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_PAGE)}`).catch((e) => log.warn('overlay load failed', e));
    this.win = win;
    return win;
  }

  private bounds(): Electron.Rectangle {
    const s = this.settings();
    const { width, height } = SIZES[s.overlayScale];
    const display = screen.getAllDisplays().find((d) => d.id === s.overlayDisplay) ?? screen.getPrimaryDisplay();
    // Full display bounds, not the work area: borderless Valorant covers the taskbar too.
    const b = display.bounds;
    const x = s.overlayPosition === 'top-left' ? b.x + MARGIN : s.overlayPosition === 'top-right' ? b.x + b.width - width - MARGIN : b.x + Math.round((b.width - width) / 2);
    return { x, y: b.y + MARGIN, width, height };
  }
}

/** Displays for the settings selector. */
export function listDisplays(): { id: number; label: string; primary: boolean }[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    primary: d.id === primary,
    label: `${d.label || `Display ${i + 1}`} · ${d.size.width}×${d.size.height}${d.id === primary ? ' (primary)' : ''}`,
  }));
}
