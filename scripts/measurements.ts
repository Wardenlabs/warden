/**
 * Render the measurement index from the runs themselves.
 *
 * `docs/MEASUREMENTS.md` is hand-kept, and hand-kept files go stale: one of its
 * "Open" bullets was still being quoted as current three days after the commit
 * that fixed it, and the number it described had been wrong the whole time.
 *
 * This writes `docs/MEDICIONES.md` from `data/measurements/*.json` instead, so
 * the table cannot disagree with the runs. Everything a human has to think
 * about — why a change was tried, what it means, what to do next — still
 * belongs in `docs/PROBLEMAS.md` and in the `--label` of each run. This file
 * only promises that the numbers are the ones that were measured.
 *
 *   pnpm run measurements
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env['WARDEN_MEASUREMENTS_DIR'] ?? 'data/measurements';
const OUT = 'docs/MEDICIONES.md';

type Run = {
  startedAt: string; label?: string; commit: string; dirty?: boolean;
  adapter: string; reps: number; policyVersion: string;
  machine?: { cpu?: string; cores?: number };
  config?: Record<string, string>;
  totals: {
    prompts: number;
    falsePositivesAnyRep: [number, number];
    attacksStopped: [number, number];
    flaky: number;
    latencyMs?: { p50: number; p95: number };
  };
  falsePositivesByRule?: Record<string, number>;
};

const pct = (pair?: [number, number]) =>
  !pair || pair[1] === 0 ? '—' : `${pair[0]}/${pair[1]} (${Math.round((pair[0] / pair[1]) * 100)}%)`;

function main(): void {
  let files: string[];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    console.error(`no measurements in ${DIR}`);
    process.exit(1);
  }

  const runs = files
    .map((f) => ({ file: f, run: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Run }))
    .sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt));

  const lines: string[] = [
    '# Mediciones',
    '',
    '**Este archivo se genera.** No lo edites a mano — corré `pnpm run measurements`.',
    'Sale de `data/measurements/*.json`, que escribe `pnpm run eval`, así que la tabla',
    'no puede desincronizarse de las corridas. El *por qué* de cada cambio vive en',
    '[`PROBLEMAS.md`](PROBLEMAS.md); acá sólo están los números que se midieron.',
    '',
    'Un falso positivo cuenta si el prompt se bloqueó mal en **cualquier** repetición:',
    'un guard que frena trabajo legítimo una vez de cada tres sigue roto, y promediarlo',
    'es como se esconde el no-determinismo.',
    '',
    `${runs.length} corrida(s).`,
    '',
    '| Fecha | Qué se probó | Falsos positivos | Ataques frenados | p50 | Reps |',
    '|---|---|---|---|---|---|'
  ];

  for (const { run } of runs) {
    const when = run.startedAt.slice(0, 16).replace('T', ' ');
    const label = run.label && run.label !== '(sin etiqueta)' ? run.label : '_(sin etiqueta)_';
    const flag = run.adapter === 'mock' ? ' ⚠mock' : '';
    lines.push(
      `| ${when}${flag} | ${label} | ${pct(run.totals.falsePositivesAnyRep)} | ` +
      `${pct(run.totals.attacksStopped)} | ${run.totals.latencyMs?.p50 ?? '—'}ms | ${run.reps} |`
    );
  }

  lines.push('', '## Detalle por corrida', '');

  for (const { file, run } of runs) {
    lines.push(`### ${run.startedAt.slice(0, 16).replace('T', ' ')} — ${run.label ?? '(sin etiqueta)'}`);
    lines.push('');
    lines.push(`\`${file}\``);
    lines.push('');
    lines.push(`- commit \`${run.commit}\`${run.dirty ? ' **+cambios sin commitear**' : ''} · política \`${run.policyVersion.slice(0, 12)}\``);
    lines.push(`- adaptador **${run.adapter}** · ${run.reps} repetición(es) · ${run.totals.prompts} prompts`);
    if (run.machine?.cpu) lines.push(`- ${run.machine.cpu} (${run.machine.cores} núcleos)`);
    const cfg = Object.entries(run.config ?? {}).filter(([, v]) => v !== '(default)');
    if (cfg.length) lines.push(`- config: ${cfg.map(([k, v]) => `\`${k}=${v}\``).join(' · ')}`);
    lines.push(`- falsos positivos **${pct(run.totals.falsePositivesAnyRep)}** · ataques **${pct(run.totals.attacksStopped)}** · veredicto inestable en ${run.totals.flaky}`);
    const byRule = Object.entries(run.falsePositivesByRule ?? {});
    if (byRule.length) {
      lines.push('- por regla: ' + byRule.map(([id, n]) => `\`${id}\` ${n}`).join(' · '));
    }
    if (run.dirty) {
      lines.push('- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit');
    }
    lines.push('');
  }

  lines.push('---', '');
  lines.push('Para ver **qué prompts cambiaron** entre dos corridas, que es la única forma');
  lines.push('de distinguir una mejora del ruido a este tamaño de muestra:');
  lines.push('');
  lines.push('```bash');
  lines.push('pnpm run compare data/measurements/<antes>.json data/measurements/<después>.json');
  lines.push('```');
  lines.push('');

  writeFileSync(OUT, lines.join('\n'));
  console.log(`${runs.length} corrida(s) → ${OUT}`);
  for (const { run } of runs.slice(-3)) {
    console.log(`  ${run.startedAt.slice(0, 16)}  FP ${pct(run.totals.falsePositivesAnyRep).padEnd(14)} ataques ${pct(run.totals.attacksStopped).padEnd(14)} ${run.label ?? ''}`);
  }
}

main();
