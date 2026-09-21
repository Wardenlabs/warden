/** Registry advisories remain visible. Only these exact, tested local
 * mitigations are accepted, temporarily; a new advisory fails the build. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const reviewed = {
  'GHSA-jmr9-qjv8-65gv': ['extract-zip', '2.0.1'],
  'GHSA-7pqw-9j4j-h8q3': ['extract-zip', '2.0.1'],
  'GHSA-w3rx-r6r6-pgpr': ['image-size', '0.7.5'],
  'GHSA-5p2g-fcmc-qvqq': ['image-size', '0.7.5']
};
const patches = {
  'patches/extract-zip@2.0.1.patch': '1a2f73f0c43de194917059f415b84e6ce5e7a99098e81cf8529052ba81deb3a1',
  'patches/image-size@0.7.5.patch': '03c35246ea80fe1818b7de1d32fd527db56ead94ef3b7b3ee7d40c250be55eeb'
};
for (const [path, digest] of Object.entries(patches)) {
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), digest, `Review changed mitigation: ${path}`);
}
const audit = spawnSync('pnpm', ['audit', '--json'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 10_000_000 });
if (audit.error || audit.signal || ![0, 1].includes(audit.status)) throw new Error('Dependency audit could not complete. Retry with registry access.');
// The pnpm launcher may prepend a status line. Do not accept errors or an
// unrecognized report as an empty vulnerability list.
const start = audit.stdout.indexOf('{');
const report = JSON.parse(audit.stdout.slice(start));
assert(report.advisories && report.metadata?.vulnerabilities && !report.error, 'Unrecognized dependency audit report');
let mitigated = 0;
for (const item of Object.values(report.advisories)) {
  const expected = reviewed[item.github_advisory_id];
  assert(expected, `Unreviewed advisory: ${item.github_advisory_id ?? item.id} (${item.module_name})`);
  assert.equal(item.module_name, expected[0]);
  assert(item.findings?.length, 'Advisory has no dependency evidence');
  for (const finding of item.findings) {
    assert.equal(finding.version, expected[1], 'Mitigation only covers the reviewed version');
    if (item.module_name === 'image-size') {
      assert(finding.dev && finding.paths.every((path) => path.includes('>appdmg>image-size')), 'Legacy parser is only accepted in the DMG build tool');
    }
  }
  console.log(`Locally mitigated (registry still reports): ${item.github_advisory_id}, ${item.module_name}@${expected[1]}`);
  mitigated++;
}
if (mitigated) assert(Date.now() < Date.parse('2026-10-21T00:00:00Z'), 'Dependency mitigation review expired. Check upstream fixes and revalidate patches.');
const regression = spawnSync(process.execPath, ['scripts/test-archive-security.mjs'], { stdio: 'inherit', timeout: 30_000 });
assert.equal(regression.status, 0, 'Installed dependency mitigation failed its exploit regression');
console.log(`Dependency gate passed: ${mitigated} reviewed mitigations; no unreviewed advisories.`);
