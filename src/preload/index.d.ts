import type { CyberSlotsApi } from '@shared/ipc';

declare global {
  interface Window {
    cyberslots: CyberSlotsApi;
  }
}

export {};
