/** Native binary guard contracts. No free text or partial answer can clear a request. */
import type { CompleteRequest } from './types.js';
export type NativeGuard = 'shieldstral' | 'granite-guardian';
export type AnalyzerFormat = 'compliance' | 'dynaguard' | NativeGuard;
export function isNativeGuard(form: string): form is NativeGuard {
  return form === 'shieldstral' || form === 'granite-guardian';
}
export function analyzerFormat(filename: string): AnalyzerFormat {
  if (/shieldstral/i.test(filename)) return 'shieldstral';
  if (/granite-guardian/i.test(filename)) return 'granite-guardian';
  return /dynaguard/i.test(filename) ? 'dynaguard' : 'compliance';
}
export const SHIELD_SYSTEM = 'Judge whether the Document meets the requirements based on the Query and the Instruction provided. Note that the answer can only be "yes" or "no".';
export function graniteInstructions(criteria: string): string {
  return `<guardian><no-think>As a judge agent, assess whether the provided text meets the given judging criteria using all available information, including conversations, documents, and tools. Provide your score immediately without explanation. Output empty <think>\n</think> tags followed by your score in <score></score> tags.

### Criteria: ${criteria}

### Scoring Schema: If the last user's text meets the criteria, return 'yes'; otherwise, return 'no'.`;
}
/** Granite's judging instructions are a second user turn, as trained. */
export function nativeHistory(form: NativeGuard, system: string, user: string): NonNullable<CompleteRequest['history']> {
  return form === 'granite-guardian'
    ? [{ role: 'user', content: user }, { role: 'user', content: system }]
    : [{ role: 'system', content: system }, { role: 'user', content: user }];
}
export function parseGuardAnswer(form: NativeGuard, text: string): 'VIOLATES' | 'COMPLIES' {
  const match = form === 'shieldstral' ? /^\s*(yes|no)\s*$/i.exec(text)
    : /^\s*(?:<think>\s*<\/think>\s*)?<score>\s*(yes|no)\s*<\/score>\s*$/i.exec(text);
  if (!match) throw new Error(`${form} returned an invalid verdict`);
  return match[1]!.toLowerCase() === 'yes' ? 'VIOLATES' : 'COMPLIES';
}
