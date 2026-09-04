/**
 * The company as a whole: its name, the shipped sample, and the way out of it.
 *
 * Administrative, like everything not on the employee allowlist. All of these
 * are destructive in the small: a rename is visible to everyone, and the reset
 * revokes the seeded keys on purpose.
 */
import { Router } from 'express';
import { forgetAll as forgetPrompts } from '../../audit/prompts.js';
import {
  clearDemoDirectory,
  discardSeededPeople,
  invalidate as invalidatePeople,
  loadSampleCompany,
  renameCompany
} from '../../policy/people.js';
import { discardSeededRules, seedIfEmpty } from '../../policy/store.js';
import { seedPath } from '../config.js';
import { asyncRoute } from '../http.js';

export const companyRoutes = Router();

companyRoutes.put('/api/company', asyncRoute(async (req, res) => {
  const name = String(req.body?.name ?? '');
  try {
    const dir = renameCompany(name);
    res.json({ name: dir.name });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

/**
 * Install the shipped sample company, because somebody pressed the button.
 *
 * The demo used to be the default and it is now a request. Both halves arrive
 * together — a directory of people with no rules to judge them by teaches less
 * than either half alone — and both are the committed seed files, so pressing
 * this twice gives the same company with fresh keys rather than two companies.
 */
companyRoutes.post('/api/company/sample', asyncRoute(async (_req, res) => {
  const dir = loadSampleCompany(seedPath('company.json'));
  const policy = seedIfEmpty(seedPath('policies.seed.json'));
  invalidatePeople();
  res.json({ name: dir.name, employees: dir.employees.length, rules: policy.rules.length });
}));

/**
 * Take out everything that came with Warden, on request, wherever it is.
 *
 * The boot migration does this by itself for installs that never asked for the
 * sample, and it is deliberately careful: if it cannot prove a row is ours it
 * leaves the row alone. That carefulness has a cost, and the cost showed up on
 * a real machine. Name your company and the `demo` flag clears, which is
 * correct and also removes the evidence the migration reads, so the seven
 * invented people and the eight seeded rules sit there with nothing willing to
 * remove them. There was no button for it either: "Clear the sample team" only
 * ever appeared while the flag was set, and it only ever touched people.
 *
 * This is that button, and it does not need evidence because the person
 * pressing it is the evidence. It still only removes rows that match the files
 * we ship, so a rule you wrote or edited survives it.
 */
companyRoutes.post('/api/company/sample/clear', asyncRoute(async (_req, res) => {
  const people = discardSeededPeople(seedPath('company.json'), true);
  const { rules, quotas } = discardSeededRules(seedPath('policies.seed.json'));
  invalidatePeople();
  res.json({ people, rules, quotas });
}));

companyRoutes.post('/api/company/reset', asyncRoute(async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
  const dir = clearDemoDirectory(name);
  // Resetting the company and leaving last week's prompts readable would be a
  // reset that kept the one thing worth clearing.
  forgetPrompts();
  res.json({ name: dir.name, employees: dir.employees.length });
}));
