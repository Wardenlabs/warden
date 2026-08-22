#!/usr/bin/env node
// Thin re-export so `npm link` inside the repo gives the same binary an
// employee gets by curling one file. One implementation, not two.
import '../integrations/warden-hook.mjs';
