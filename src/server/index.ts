/**
 * The gateway's entry point: boot migrations, listen, warm the models, and
 * leave cleanly. What the server *does* is in `app.ts` and `routes/`; this
 * file is only what has to happen once, in order, when the process starts.
 */
import { dropUnrequestedSample } from '../policy/boot-migrations.js';
import { loadPolicy } from '../policy/store.js';
import { adapterName } from '../qvac/index.js';
import { createApp } from './app.js';
import { HOST, PORT, seedPath } from './config.js';
import { lanAddresses } from './http.js';
import { installExitHandlers, preloadModels } from './lifecycle.js';

/*
 * Nothing is seeded at boot. A fresh install has no company, no people and no
 * rules — which is also the only honest starting state for a thing whose job is
 * to enforce rules somebody wrote: it should not arrive holding eight it
 * invented. The console's empty states say so, and the sample company is a
 * button (POST /api/company/sample) rather than a fact about you.
 *
 * What runs here instead is the other half of that, for the installs that
 * already have one. See `boot-migrations.ts` — an upgrade does not touch the
 * user's data folder, so the sample an older build seeded outlives the fix
 * unless the boot removes it, and it may only remove what it can prove nobody
 * edited.
 */
try {
  dropUnrequestedSample(seedPath('policies.seed.json'), seedPath('company.json'));
} catch {
  /* a migration must never be the reason the gateway will not start */
}

const server = createApp().listen(PORT, HOST, () => {
  console.log(`\nWarden  (adapter=${adapterName()})`);
  console.log(`  local     http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  network   http://${ip}:${PORT}   <- teammates point here`);
  }
  console.log(`  policy    ${loadPolicy().rules.length} rules · ${loadPolicy().quotas.length} quotas`);
  console.log(`  console   open the local or network URL in a browser\n`);
  preloadModels();
});

installExitHandlers(server);
