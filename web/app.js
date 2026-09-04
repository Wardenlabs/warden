/**
 * Console behaviour. Plain ES modules, no framework, no build step.
 *
 * One column. A rail to choose what you are looking at, and a list of those
 * things; selecting one opens it in place, under the row you clicked. There is
 * no side panel, because a panel that has to be labelled to be understood is a
 * panel that was not carrying its width.
 *
 * Two people read every detail and they want opposite things. An operations
 * lead wants one sentence; whoever runs the gateway wants nine passes and a
 * hash chain. So every detail leads with the sentence and folds the rest away.
 * Milliseconds are part of the folded half: they belong to "how long did this
 * take", which is one question among several and not the first one.
 *
 * Every colour and every font-size lives in :root. Nothing here writes a hex
 * value or a pixel size; if a style is missing, add a token and a class in
 * index.html rather than an inline style, or the system stops being one.
 */

// Every screen registers itself into `VIEWS` when its module loads, so the
// entry only has to load them and start. The order below is not significant.
import './js/activity.js';
import './js/inbox.js';
import './js/rules.js';
import './js/compiler.js';
import './js/engine.js';
import './js/draft.js';
import './js/team.js';
import './js/simulator.js';
import './js/redteam.js';
import './js/solo.js';
import './js/nav.js';
import { boot } from './js/data.js';

boot();
