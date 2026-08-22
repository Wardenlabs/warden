import { loadPolicy, seedIfEmpty } from '../src/policy/store.js';
console.log('1. loadPolicy antes:', loadPolicy().rules.length, loadPolicy().version.slice(0,8));
try {
  const s = seedIfEmpty('data/seed/policies.seed.json');
  console.log('2. seedIfEmpty ->', s.rules.length, s.version.slice(0,8));
} catch (e) { console.log('2. seedIfEmpty THREW:', e instanceof Error ? e.message.slice(0,300) : e); }
console.log('3. loadPolicy después:', loadPolicy().rules.length, loadPolicy().version.slice(0,8));
