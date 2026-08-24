/**
 * Bridge for the splash window only. The console window needs no preload at
 * all — it is the same web console the gateway serves to a browser.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('warden', {
  choose: (choice: 'download' | 'mock' | 'retry') => {
    ipcRenderer.send('setup:choice', choice);
  },
  onState: (callback: (state: unknown) => void) => {
    ipcRenderer.on('setup:state', (_event, state: unknown) => callback(state));
  }
});
