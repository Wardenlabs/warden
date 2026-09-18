/** Shared anatomy for settings: page header, status, navigation and sections. */
import { esc } from './core.js';
import { pageHead, tabs } from './ui.js';

export function settingsPage({ title, view, sections, selected, status = '', notices = '', content, primary = '' }) {
  return `<div class="sheet">${pageHead({ title, primary })}
    <div class="settings-layout">${status}${notices}
      ${tabs(view, sections, selected, `${title} sections`)}
      <div class="settings-content">${content}</div>
    </div></div>`;
}

/** Content and actions are trusted templates; never pass API strings unescaped. */
export function settingsSection(title, content, actions = '') {
  return `<section class="settings-section"><header class="settings-section-head">
    <h2>${esc(title)}</h2>${actions}</header>${content}</section>`;
}
