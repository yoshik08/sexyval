import { BrowserWindow, screen } from 'electron';
import type { AppState, Settings } from '../shared/types';
import { UNVERIFIED_NOTE } from '../shared/side';
import { log } from './log';

/**
 * Agent-select overlay: a tiny always-on-top pill with your starting side.
 *
 * It is an ordinary window: no injection, hooks, memory reading or screen capture. It never takes
 * focus (focusable: false, showInactive) and lets every click through. It shows only during agent
 * select and only the starting side (never enemy info), and hides the moment the phase changes.
 * Windows can draw it over Valorant in Windowed or Windowed Fullscreen, not over exclusive Fullscreen.
 */

const SIZES = { small: { width: 112, height: 40 }, medium: { width: 140, height: 48 } } as const;
const MARGIN = 16;
const FADE_MS = 150;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
body{display:flex;align-items:center;justify-content:center;font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif}
.pill{display:flex;align-items:center;gap:9px;height:calc(100% - 4px);width:calc(100% - 4px);box-sizing:border-box;padding:0 14px;border-radius:999px;
  background:rgba(12,12,14,.86);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);opacity:0;transform:scale(.96);transition:opacity ${FADE_MS}ms ease-out,transform ${FADE_MS}ms ease-out}
.pill.on{opacity:1;transform:none}
.side{font-weight:800;letter-spacing:.02em;font-size:var(--big);line-height:1}
.atk .side{color:#ff4655}.def .side{color:#4aa3ff}
.label{font-size:var(--small);line-height:1.1;color:rgba(245,245,247,.72);font-weight:600}
.label i{display:block;font-style:normal;color:rgba(245,245,247,.45);font-weight:500}
</style></head><body><div id="p" class="pill"><span class="side" id="s"></span><span class="label" id="l">starting<i>side</i></span></div>
<script>
window.render=(side,on,small)=>{const p=document.getElementById('p');
 document.documentElement.style.setProperty('--big',small?'17px':'21px');document.documentElement.style.setProperty('--small',small?'9.5px':'11px');
 if(side){document.getElementById('s').textContent=side;p.className='pill '+(side==='ATK'?'atk':'def');}
 requestAnimationFrame(()=>p.classList.toggle('on',!!on));};
</script></body></html>`;

export class AgentSelectOverlay {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private visible = false;
  private shownSide: string | null = null;
  private hideTimer: NodeJS.Timeout | null = null;

  constructor(private readonly settings: () => Settings) {}

  /** Called on every state emit. Shows only in agent select with a known side. */
  update(state: AppState | null | undefined): void {
    const s = this.settings();
    const side = state?.phase === 'pregame' && state.conn.status === 'connected' ? (state.pregame?.side.side ?? null) : null;
    const verified = state?.pregame?.side.verified ?? false;
    if (!s.overlayEnabled || !side) return this.hide();
    void this.show(side, verified);
  }

  /** Re-place and re-size after a settings or display change. */
  relayout(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setBounds(this.bounds());
    if (this.visible) void this.win.webContents.executeJavaScript(`render(null, true, ${this.settings().overlayScale === 'small'})`).catch(() => undefined);
  }

  hide(): void {
    if (!this.visible || !this.win || this.win.isDestroyed()) return;
    this.visible = false;
    this.shownSide = null;
    void this.win.webContents.executeJavaScript('render(null, false)').catch(() => undefined);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.visible && this.win && !this.win.isDestroyed()) this.win.hide();
    }, FADE_MS + 10);
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = null;
  }

  /** The overlay's renderer, for screenshots in mock mode. */
  get webContents() {
    return this.win && !this.win.isDestroyed() && this.visible ? this.win.webContents : null;
  }

  private async show(side: 'ATK' | 'DEF', verified: boolean): Promise<void> {
    const win = this.ensure();
    await this.ready;
    if (win.isDestroyed()) return;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    const small = this.settings().overlayScale === 'small';
    if (this.visible && this.shownSide === side) return;
    this.visible = true;
    this.shownSide = side;
    win.setBounds(this.bounds());
    // A click-through window cannot show hover text, so the unverified note goes in the window title.
    win.setTitle(verified ? 'Starting side' : `Starting side (${UNVERIFIED_NOTE})`);
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    await win.webContents.executeJavaScript(`render(${JSON.stringify(side)}, true, ${small})`).catch((e) => log.warn('overlay render failed', e));
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
      title: 'Starting side',
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
    this.ready = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch((e) => log.warn('overlay load failed', e));
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
