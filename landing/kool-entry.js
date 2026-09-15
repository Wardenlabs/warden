import { initKoolDownloads } from './kool-download.js';

try { initKoolDownloads(); } catch { /* Downloads remain ordinary GitHub links if enhancement is unavailable. */ }
