/**
 * The registry every screen adds itself to. A leaf on purpose: it imports
 * nothing, so it is always evaluated before any module that writes into it.
 */
export const VIEWS = {};
