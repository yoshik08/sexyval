import type { SexyValApi } from '../../../shared/types';

declare global {
  interface Window {
    sexyval: SexyValApi;
  }
}

export const api: SexyValApi = window.sexyval;
