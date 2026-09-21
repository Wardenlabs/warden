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
import { lanAddresses, listeningOn } from './http.js';
import { installExitHandlers, preloadModels, reconcileTransfers } from './lifecycle.js';
import { portAvailable, portHolder } from './installation.js';

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

/*
 * The port is already taken: say by whom, and stop.
 *
 * Almost always the other Warden. The desktop app and a checkout both default
 * to 8080, each holds its own people and its own keys because writable state is
 * cwd-relative, and what the second one printed was Node's bind error —
 * `EADDRINUSE`, a stack trace, nothing that names Warden. Worse is what came
 * next: whoever started it read the banner that had already printed, assumed it
 * had come up, pointed a hook at localhost, and every prompt went to the
 * *other* installation, which refused a key it had never issued. That is the
 * incident `docs/prd/wiring-and-unwiring.md` opens with, and the whole of the
 * cure is naming the gateway that answered.
 *
 * Asked before listening rather than off the listen error, because the banner
 * prints from the listening callback and Node emits both — so the failure path
 * had "Warden local http://localhost:8080" three lines above "did not start",
 * which is the same wrong belief this is here to prevent. A port free during
 * this check and taken a millisecond later still fails the way it always did.
 */
if (!(await portAvailable(PORT, HOST))) {
  const held = await portHolder(PORT);
  console.error(`\nWarden did not start: port ${PORT} is already in use.\n`);
  if (held) {
    console.error(`  It is held by the Warden installation "${held.label}" (v${held.version}).`);
    if (held.dataDir) console.error(`  That one keeps its people, keys and rules in ${held.dataDir}.`);
    console.error('\n  Two gateways cannot share a port, and neither knows the other\'s keys.');
    console.error('  Stop that gateway, or give this one a port of its own:\n');
  } else {
    console.error('  Something that is not Warden is holding it.');
    console.error('  Stop it, or give this gateway a port of its own:\n');
  }
  console.error(`    WARDEN_PORT=${PORT + 1} pnpm run dev\n`);
  process.exit(1);
}

const server = createApp().listen(PORT, HOST, () => {
  console.log(`\nWarden  (adapter=${adapterName()})`);
  console.log(`  local     http://localhost:${PORT}`);
  // Only what is bound. This printed every LAN address the machine had while
  // listening on loopback, and "teammates point here" under an address that
  // refuses them is the setup message's mistake made at the top of the log.
  if (listeningOn() === 'network') {
    for (const ip of lanAddresses()) {
      console.log(`  network   http://${ip}:${PORT}   <- teammates point here`);
    }
  } else {
    console.log('  network   off — bound to this computer only (WARDEN_HOST)');
  }
  console.log(`  policy    ${loadPolicy().rules.length} rules · ${loadPolicy().quotas.length} quotas`);
  console.log(`  console   open the local or network URL in a browser\n`);
  reconcileTransfers();
  preloadModels();
});

// Managed GGUF uploads are streamed and have their own byte, disk and duration
// limits. Node's five-minute request default would cut off legitimate multi-GB
// imports before that route's 30-minute transfer budget.
server.requestTimeout = 30 * 60_000;
server.headersTimeout = 30_000;

installExitHandlers(server);
