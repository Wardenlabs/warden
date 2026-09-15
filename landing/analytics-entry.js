import { analyticsConfig } from './analytics-config.js?v=white-studio-1';
import { initAnalytics } from './analytics.js?v=launch-1';

// Analytics is deliberately independent from the animation module.
try { initAnalytics(analyticsConfig); }
catch { /* A metrics failure must never block the page or a download. */ }
