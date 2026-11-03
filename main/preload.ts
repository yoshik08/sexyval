// Sandboxed preload: only 'electron' can be required here, so channel names are inlined.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { SexyValApi } from '../shared/types';

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const fn = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

const EVENTS = new Set(['state', 'toast', 'nav', 'shop', 'catalog', 'owned', 'prices', 'accounts', 'alert']);

const api: SexyValApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => on('state', cb),
  onToast: (cb) => on('toast', cb),
  onNav: (cb) => on('nav', cb),
  getShop: () => ipcRenderer.invoke('shop:get'),
  refreshShop: () => ipcRenderer.invoke('shop:refresh'),
  onShop: (cb) => on('shop', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getDebug: () => ipcRenderer.invoke('debug:get'),
  isMock: () => ipcRenderer.invoke('mock:is'),
  mockSetPhase: (phase) => ipcRenderer.invoke('mock:phase', phase),
  rpc: (method, ...args) => ipcRenderer.invoke('rpc', method, args),
  on: (event, cb) => {
    if (!EVENTS.has(event)) throw new Error(`unknown event ${event}`);
    return on(event, cb);
  },
};

contextBridge.exposeInMainWorld('sexyval', api);
