/**
 * The screen a first run is drawn on: the wordmark that is also the way out, an
 * eyebrow, a title, a rail, the content, a note, and one action at the bottom
 * right with Back at the bottom left.
 *
 * It was written inside first-run.js with This device's eyebrow and a rail of
 * three built in. Team's first run is the same screen with a different eyebrow,
 * four segments, and — on two of its steps — a form where the two cards go. So
 * what varies is passed in, and what a first run *is* stays in one place:
 * nothing here knows which steps exist or what finishes them.
 */
import { esc } from './core.js';
import { ICONS } from './icons.js';
import { button } from './ui.js';

/**
 * A bar filled up to where you are; the label above it says which step that is.
 * The design does not distinguish the current segment from the finished ones
 * and neither does this — a third state nobody drew is a third state nobody
 * agreed to.
 */
export function rail(step, label, steps = 3) {
  const bars = Array.from({ length: steps }, (_, i) => `<i class="${i + 1 <= step ? '--done' : ''}"></i>`).join('');
  return `<div class="first-run-rail"><p class="kicker">${esc(label)}</p><div>${bars}</div></div>`;
}

/**
 * Two cards. On a step that asks for a choice they are the choices and the led
 * one is the selection; on a step that reports they are a state and an
 * instruction, and `--lead` marks the one carrying the state. Same box, and the
 * design draws them the same way on purpose.
 *
 * `tone` is never the verdict. It is about how the step turned out: a
 * confirmation is green under a card that says "Blocked", because blocking was
 * the good ending.
 */
export function card(title, body, { lead = false, tone = '', choice = '' } = {}) {
  const cls = `choice-card${lead ? ' --lead' : ''}${tone ? ` --${tone}` : ''}`;
  const attrs = choice
    ? ` role="radio" aria-checked="${lead}" tabindex="0" data-choice="${esc(choice)}"`
    : '';
  return `<div class="${cls}"${attrs}>
    <b>${esc(title)}</b>
    <span>${esc(body)}</span>
  </div>`;
}

/** Two cards as a group; a radio group when they are a choice. */
export function cards(html, choice = false) {
  return `<div class="first-run-cards"${choice ? ' role="radiogroup" aria-label="Choose one"' : ''}>${html}</div>`;
}

/**
 * `content` is markup the caller built — the cards, or a form. `error` sits
 * between it and the note: under the thing that was tried, above what happens
 * next. `secondary` is a quiet control beside the action, for a step whose
 * action is not the only thing worth pressing.
 *
 * `ids` names the two controls every run has, so two runs can be bound without
 * one answering the other's clicks.
 */
export function screen({ kicker, steps = 3, step, label, title, content, error = '', note, action, secondary = '', back = true, ids }) {
  return `<div class="first-run">
    <header><button type="button" class="first-run-mark" id="${esc(ids.leave)}" aria-label="Warden — leave setup">${ICONS.brand}</button></header>
    <div class="first-run-body">
      <div class="first-run-heading">
        <p class="kicker">${esc(kicker)}</p>
        <h1>${esc(title)}</h1>
      </div>
      ${rail(step, label, steps)}
      <div class="first-run-content">
        ${content}
        ${error}
        <p class="first-run-note">${esc(note)}</p>
      </div>
      <div class="first-run-actions">
        ${back ? button('← Back', { kind: 'link', id: ids.back }) : '<span></span>'}
        ${secondary ? `<span class="first-run-actions-end">${secondary}${action}</span>` : action}
      </div>
    </div>
  </div>`;
}
