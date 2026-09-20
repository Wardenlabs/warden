# Rule-first console and contextual records

The owner’s review of v0.2.5 requested the official logo, larger outer margins,
full-width lists, record panels that retain list context, and rule prompting as
the first screen. This replaces the previous full-page record convention.

## Direction

Warden is an administrator’s workspace for stating rules and inspecting their
consequences. Its entrance is the rule composer. The distinctive interaction is
writing an instruction in a quiet central column, then reviewing decisions and
people beside the lists that led to them.

Preserve the existing palette: paper `#FFFFFF`, canvas `#F4F5F4`, graphite
`#22282A`, secondary ink `#656E6F`, allowed `#087356`, separators `#E7EAE8`. Attention and role labels use neutral ink.
Small blocked/allowed verdict markers retain their meaning; large headings and setup states stay neutral. Manrope, already used by the
landing, gives headings their own voice; system sans remains the compact body
face and system monospace carries timestamps and technical records. Font files
are local, with their original license.

A 12px outer frame separates the white workspace from the canvas. List width
follows the window, with balanced responsive gutters. Reading and composing
remain limited to 700px. The official SVG lockup replaces the generic checkmark
shield and typeset approximation. Narrow windows use the official mark alone.

```
Sidebar | Full-width list                    |
Sidebar | Visible list    | Selected record  |
Sidebar |         Rule composer              |
```

The initial alternative retained the 1120px page cap and centred that box.
That still wasted the space the owner identified, so only prose retains a
reading measure. The shared drawer is the one new structural gesture; colour,
verdict semantics and the existing controls remain quiet.

## Interaction

- Empty and unknown addresses open `policy/new`, for solo and team installs.
- Rules is the first sidebar destination and opens its composer. View rules
  reaches the catalogue. Existing explicit links continue to work.
- Activity, Inbox, rule detail/edit and people use a native modal dialog on the
  right. Rules creation and Team tabs remain full pages.
- The underlying list stays visible and inert. Its IDs are isolated so live
  updates cannot bind foreground actions to background controls.
- Close, outside click and Escape return to the list. Focus and scroll return
  to the selected row when available. Rule edits keep their unsaved-work guard.
- A nested confirmation owns keyboard focus; the editor behind it becomes inert.
- At narrow widths the panel fills the screen. Motion respects reduced motion.

## Verification

Console tests cover launch routing, explicit links and which destinations use
panels. Browser checks exercise all four sections, live text preservation,
keyboard focus, list scroll restoration, unsaved edit confirmation, wide-screen
coverage, dark mode and a 390px viewport using synthetic data.

## Follow-up: less visual instruction

The owner rejected mustard status headings, coloured role labels, redundant
helper paragraphs and the boxy Rules composer. Setup now reads “Setup
incomplete” in neutral ink. Sidebar group labels and the Workspace caption are
removed. Rule effect explanations and persistent editing instructions are
removed from the templates; validation errors remain conditional. Inbox uses
explicit recording actions and reports the non-resumption in the saved result.
The composer uses a 22px radius, a quiet border and unboxed example actions.

## Refinement after v0.2.6

The sidebar lockup is 100px wide. Overview, Manage and Local return as compact
navigation labels; helper paragraphs stay omitted. Setup facts use neutral text
without decorative status dots. The rule composer owns the shield mark, a
brief entrance movement and a two-line Manrope heading. Reduced-motion settings
disable that movement.

`settings-layout.js` owns the page structure shared by This device, Gateway and
Models. Connections is the device landing tab. `device-rules.js` owns the rule
list; the device controller retains mutations and confirmation state. Add and
Remove replace the duplicate checkbox/menu controls.

`style.css` imports five ordered layers from `web/styles/`: foundation,
components, rules, settings and responsive. New settings use the shared grid,
section headings and action footer. Views must escape API strings before
passing HTML to a component. Labels remain plain strings that components escape.

## Role colour, reversed after v0.2.18

Role labels are coloured again, and the earlier sentence above — "Attention and
role labels use neutral ink" — holds only for attention now. Flattening the
roles to neutral removed the wrong thing: a role is what groups a table, and
five greys group nothing.

The mistake underneath it was in `roleTone`, not in the palette. It matched
against four spelled-out names — `admin`, `employee`, `sales`, `solo` — and
everything else fell through to the neutral. Those four are the demo
directory's roles, so the only installation where the colours worked was the
sample one; a real company creating `engineer` got grey. A role is any string
`POST /api/roles` accepts, so there is no list to colour by hand.

The palette carries four numbered identity slots and a neutral, and a role
takes a slot by a hash of its own name: stable across renders, reloads and
machines with no state to keep, so the same role is the same colour in the
table, the picker and the menu without anything agreeing beforehand.
Collisions past four roles are expected and harmless — the colour groups rows
at a glance and never carries the meaning alone; the word beside it does.
"Everyone" is a scope rather than a role, and a person is not one either; both
take the neutral. Tokens are `--role-1` … `--role-4` and `--role-neutral`,
named by slot rather than by role for the same reason. In Figma they are
`role/1` … `role/4` and `role/neutral`; `Label / Role`'s four variants are four
example roles standing in for the four slots, not a claim that admin is blue.
