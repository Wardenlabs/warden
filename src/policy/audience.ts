/**
 * Who a rule binds.
 *
 * A rule's `appliesTo` is a list of audience tokens, and there are three kinds:
 *
 *   `*`        everyone
 *   `sales`    everyone holding that role
 *   `@ana`     one named person
 *
 * The tokens are a union, not an intersection: `["@ana", "sales"]` means Ana
 * plus the whole sales team. Union is the only reading that fails safe — an
 * intersection would let a typo in one token quietly narrow a rule to nobody,
 * and a rule that binds nobody protects nobody while still looking active in
 * the console.
 *
 * The `@` prefix is what keeps people and roles from colliding. Without it an
 * employee called `sales` (or, more realistically, a role and a person who
 * happen to share a name) would make the audience ambiguous, and the guard
 * would have to guess which one the admin meant.
 */

/** Every actor, regardless of role or identity. */
export const EVERYONE = '*';

/** The audience token that binds exactly one person. */
export function employeeToken(id: string): string {
  return `@${id}`;
}

export function isEmployeeToken(token: string): boolean {
  return token.startsWith('@');
}

/** The employee id inside a token, or null if this token names a role. */
export function employeeIdOf(token: string): string | null {
  return isEmployeeToken(token) ? token.slice(1) : null;
}

/**
 * Whether a rule's audience covers this actor.
 *
 * Structural in the actor on purpose — this module belongs to the policy layer
 * and should not need to know the guard's types to answer a question about
 * two strings.
 */
export function bindsActor(appliesTo: string[], actor: { id: string; role: string }): boolean {
  return appliesTo.some(
    (token) =>
      token === EVERYONE || token === actor.role || token === employeeToken(actor.id)
  );
}

/**
 * The audience in words, for the console and for the explanation an employee
 * reads when a rule fires. `@ana` on its own is meaningless to anyone who did
 * not write it, so it resolves through the directory to a name.
 */
export function describeAudience(
  appliesTo: string[],
  people: { id: string; name: string }[] = []
): string {
  if (appliesTo.includes(EVERYONE)) return 'everyone';
  return appliesTo
    .map((token) => {
      const id = employeeIdOf(token);
      if (!id) return token;
      const person = people.find((p) => p.id === id);
      // A token pointing at someone who has left the directory is dead policy,
      // not a silent no-op: say so rather than printing a bare id.
      return person ? person.name : `${id} (no longer in the directory)`;
    })
    .join(', ');
}

/**
 * Drop audience tokens that name nothing real.
 *
 * Used on anything a model produced. A hallucinated role or a misremembered
 * employee id would narrow a rule without saying so, so unknown tokens are
 * discarded — and if that empties the audience, the rule falls back to
 * everyone. Too broad is a false positive somebody notices and fixes; too
 * narrow is a rule that silently guards no one.
 */
export function sanitiseAudience(
  claimed: string[],
  knownRoles: string[],
  knownEmployeeIds: string[] = []
): string[] {
  if (claimed.includes(EVERYONE)) return [EVERYONE];
  const valid = claimed.filter((token) => {
    const id = employeeIdOf(token);
    return id ? knownEmployeeIds.includes(id) : knownRoles.includes(token);
  });
  return valid.length > 0 ? [...new Set(valid)] : [EVERYONE];
}
