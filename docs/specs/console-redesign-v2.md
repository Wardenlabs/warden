# Rediseño de la consola: Warden v2 — Spec técnico

Sigue a `docs/prd/console-redesign-v2.md`. Acá se cierra el cómo: tokens,
shell, componentes, rutas, el inventario pantalla por pantalla y el orden de
fases. Las decisiones de producto del PRD (§4) son insumo fijo — no se
re-litigan al implementar.

Todas las referencias `archivo:línea` son al estado del repo al 2026-09-15
(main en `03634e5`).

## 0. Fuentes de verdad

1. **Los PNG en `design/console-v2/`** — cada frame Elegido del redesign,
   exportado 1:1 desde Figma. Son la referencia de layout, jerarquía y copy.
   Organización: `rules/ activity/ inbox/ team/ this-device/ models/ dark/
   design-system/`. El §6 mapea cada pantalla a su archivo y su node-id.
2. **El archivo Figma "Warden"** (fileKey `RFPKLtSSZjQMHy9XaOOSqp`) — el
   agente ejecutor TIENE acceso vía MCP: usar `get_screenshot` /
   `get_design_context` con los node-ids del §6 para medidas y dudas de
   detalle (los PNG evitan el viaje para la comparación rutinaria por fase).
   Páginas `01 · Design system` (298:1984) a `07 · Models` (298:1990) y
   `08 · Dark` (519:82). Colección de variables única: **"Warden · Sistema"**
   (60 tokens, modos Light y Dark, cero aliases).
   **No mirar**: páginas `90/91 · Referencia`, `98 · Biblioteca anterior`,
   `99 · Archivo`, ni ninguna colección "ZZ Legacy · …". Solo frames cuyo
   nombre dice `· Elegida`.
3. **Este spec** para todo lo que un PNG no puede decir: tokens exactos (§2),
   comportamiento (§6), rutas (§5).

Si un PNG y este spec se contradicen en un valor, gana el token de §2 (los
PNG son render; los tokens son la fuente). Si se contradicen en layout, gana
el PNG.

## 1. Lo que ya existe y no se toca

- **`src/` entero.** Cero cambios de endpoints ni contratos; la consola
  consume la API tal cual (`src/server/routes/*`).
- **El stack**: vanilla ES modules, sin build step, un solo `web/style.css`,
  un módulo por pantalla. Sin dependencias nuevas (regla de CLAUDE.md).
- **La mecánica de render**: `render()` (`web/js/render.js`),
  `captureFields`/`restoreFields` (`form-state.js`), la delegación de eventos
  `data-go`/`data-sel`/`data-toggle` (`nav.js:104-123`), el hash router
  (`router.js`), `state` y `api()` (`core.js`), el boot y la suscripción SSE
  (`data.js`). §3 introduce un cambio quirúrgico (sidebar fuera del pane);
  todo lo demás queda.
- **Los motores**: `draft.js`, `draft-set.js`, `answers.js` (conversación de
  New rule), `documents.js` (adjuntos y extracción), la lógica de envío de
  `simulator.js`, `model-library.js` y `prompt-editor.js` por dentro. Se
  re-visten, no se reescriben.
- La regla solo/team: `soloIsPureInstall()` (`nav.js:66-69`) sigue decidiendo
  qué nav se muestra (§3.4).

## 2. Tokens: `web/style.css` `:root` nuevo

Reemplaza el bloque actual (`style.css:19-82`) completo. La invariante de
`style.css:16` sigue rigiendo: **ningún color ni font-size literal fuera de
`:root`** (ahora: fuera de los dos bloques de tema).

### 2.1 Color — Light (valores por defecto)

```css
:root {
  color-scheme: light;

  /* ink */
  --ink: #17181C;            /* ink/default — títulos, valores */
  --ink-body: #44474E;       /* ink/body — texto corrido */
  --muted: #70747C;          /* ink/muted — secundario, datums, helpers */

  /* surfaces */
  --surface-page: #FFFFFF;   /* el papel */
  --surface-subtle: #F5F5F7; /* hover de fila, selección, placas de estado */
  --surface-disabled: #F0F0F2;
  --surface-raised: #FFFFFF; /* flotantes: menús, diálogos, toasts */

  /* lines */
  --line-hairline: #EAEAED;  /* divisores */
  --line-control: #E0E0E4;   /* bordes de fields/controles en reposo */
  --line-accessible: #858A94;/* borde de control que necesita contraste (triggers) */

  /* action — el primario grafito */
  --action: #262A33;         /* action/graphite */
  --action-ink: #FFFFFF;     /* action/on-graphite — label sobre el primario */
  --action-hover: #353B47;

  /* verdicts — el único color saturado del producto */
  --verdict-block: #B91C41;     --verdict-block-bg: #FFF0F3;
  --verdict-allow: #087356;     --verdict-allow-bg: #E8F8F1;
  --verdict-attention: #7B6200; --verdict-attention-bg: #FFF9DE;
  --signal-red: #FF3B5C;        /* solo el efecto Block configurado */

  /* roles — identidad, nunca severidad */
  --role-admin: #365FA5;     --role-admin-bg: #EAF1FF;
  --role-employee: #256B78;  --role-employee-bg: #E7F5F7;
  --role-sales: #6547B5;     --role-sales-bg: #F1EDFF;
  --role-solo: #944473;      --role-solo-bg: #F8EDF5;
  --role-everyone: #505868;  --role-everyone-bg: #EEF0F4;

  /* sidebar — invariante: mismos valores en light y dark */
  --sidebar-bg: #0F1013;
  --sidebar-text: #C3C6CD;
  --sidebar-muted: #8D919A;
  --sidebar-avatar: #212329;
  --sidebar-selected-text: #F0F0F2;
  --sidebar-selected-bg: #262A33; /* banda de selección, radius 8 */

  --focus-ring: #365FA5;
}
```

### 2.2 Color — Dark

Dark sigue al sistema operativo; no hay toggle propio (no está diseñado).

```css
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;

    --ink: #E9EAED;  --ink-body: #C2C5CB;  --muted: #878C96;

    --surface-page: #16181D;      /* el papel azulado — decisión del owner */
    --surface-subtle: #21242B;
    --surface-disabled: #1C1F24;
    --surface-raised: #1D2026;    /* lo flotante es MÁS CLARO que el papel */

    --line-hairline: #262A31;
    --line-control: #30353D;
    --line-accessible: #565C66;

    --action: #E9EAED;            /* el primario se invierte: botón claro */
    --action-ink: #141619;
    --action-hover: #D9DBDF;

    --verdict-block: #F0708F;     --verdict-block-bg: #391820;
    --verdict-allow: #4CC29A;     --verdict-allow-bg: #12352B;
    --verdict-attention: #D9B24B; --verdict-attention-bg: #33290F;
    --signal-red: #FF5C77;

    --role-admin: #7FA5E8;     --role-admin-bg: #1B2536;
    --role-employee: #5FB5C4;  --role-employee-bg: #14282C;
    --role-sales: #A78BE8;     --role-sales-bg: #241D38;
    --role-solo: #D183B4;      --role-solo-bg: #321F2B;
    --role-everyone: #9BA3B2;  --role-everyone-bg: #232730;

    /* sidebar: NO se redefine — es invariante */
    --focus-ring: #6E96E8;
  }
}
```

Reglas de dark que ningún token puede decir por sí solo:

- **La elevación se invierte**: en light lo flotante se separa con sombra
  sobre el mismo blanco; en dark lo flotante usa `--surface-raised` (más
  claro que el papel). Menús, diálogos y toasts llevan `--surface-raised`,
  nunca `--surface-page`.
- **La sidebar usa exclusivamente tokens `--sidebar-*`.** Nunca `--ink` ni
  `--action` adentro de la sidebar: esos se invierten en dark y la sidebar
  no.
- **Nada de inversiones automáticas ni filtros.** Cada color de dark es un
  valor decidido; si falta uno, se busca en la colección de Figma, no se
  inventa.

### 2.3 Tipografía, espacio, radio, tamaños

```css
:root {
  --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;

  --fs-1: 11px;  /* kickers y column headers UPPERCASE, +.06em tracking */
  --fs-2: 12px;  /* chips, metadata mono */
  --fs-3: 13px;  /* secundario: descripciones, datums, helpers */
  --fs-4: 14px;  /* el cuerpo: labels, valores, filas, botones, menús */
  --fs-5: 16px;  /* título de bloque (Semi Bold) */
  --fs-6: 20px;  /* título de sección / veredicto dominante (Semi Bold) */
  --fs-7: 26px;  /* título de página */

  --fw-normal: 400; --fw-medium: 500; --fw-semi: 600;
  --lh-tight: 1.25; --lh-snug: 1.45; --lh-body: 1.6;
  --ls-label: .06em; --ls-tight: -.011em;

  --s-1: 4px; --s-2: 6px; --s-3: 8px; --s-4: 12px; --s-5: 16px;
  --s-6: 20px; --s-7: 24px; --s-8: 28px; --s-9: 32px; --s-10: 40px;
  --s-11: 48px; --s-12: 64px;

  --r-control: 6px;   /* TODO elemento con caja. Pills prohibidas. */
  --r-selected: 8px;  /* solo la banda de selección de la sidebar */
  --r-avatar: 17px;

  --h-control: 40px;          /* botones y fields grandes */
  --h-control-compact: 32px;  /* Button/Compact, Field/Compact */
  --h-nav-row: 44px;
  --w-sidebar: 240px;
  --w-reading: 760px;   /* conversaciones, settings, disclosures */
  --w-table: 1120px;    /* bloque de tabla; filas sangran a 1160 */
}
```

- Geist Mono cae en fallback si no está instalada — **no se agrega webfont
  por red** (la consola no busca nada afuera, misma razón que el favicon
  inline). Vendorizar el woff2 (licencia OFL) es opcional y va en su propio
  commit si se hace.
- Focus visible: `outline: 2px solid var(--focus-ring); outline-offset: 1px`
  en todo interactivo. En el primario el ring va POR FUERA del fill.
- `--r-pill` muere. Grep antes de borrar; el que lo use se corrige a
  `--r-control` con el layout del frame correspondiente.

### 2.4 Mapa de migración de tokens viejos

Para el barrido mecánico del CSS existente (el significado manda, no el hex):

| Viejo | Nuevo |
| --- | --- |
| `--bg` | `--surface-page` |
| `--sunken`, `--hover`, `--selected` | `--surface-subtle` (hover/selección de fila y placas) |
| `--line-soft`, `--line` | `--line-hairline` |
| `--line-firm` | `--line-control` |
| `--ink` | `--ink` |
| `--ink-2` | `--ink-body` |
| `--muted`, `--faint` | `--muted` |
| `--accent`, `--accent-hover`, `--accent-ink` | `--action`, `--action-hover`, `--action-ink` |
| `--accent-line` | `--line-accessible` |
| `--allow/-bg`, `--block/-bg` | `--verdict-allow/-bg`, `--verdict-block/-bg` |
| `--escalate/-bg` | `--verdict-attention/-bg` |
| `--read` (880px) | `--w-reading` (760px) o `--w-table` (1120px) según la vista |

## 3. El shell: sidebar + un origen de contenido

### 3.1 `web/index.html`

El `header.topnav` muere. Estructura nueva:

```html
<body>
  <aside class="sidebar" id="sidebar"></aside>
  <main class="pane" id="pane"></main>
</body>
```

`body { display: flex }`; la sidebar es `position: sticky; top: 0;
height: 100vh; width: var(--w-sidebar); flex: none`.

### 3.2 La sidebar (componente Sidebar, Figma 259:631)

De arriba a abajo: marca **warden** (wordmark + nombre de la org, en
`--sidebar-selected-text`), label WORKSPACE (`--fs-1` uppercase
`--sidebar-muted`), grupo **OVERVIEW** (Activity, Inbox), grupo **MANAGE**
(Rules, Team, Models), grupo **LOCAL** (This device), y el perfil abajo
(avatar `--sidebar-avatar` radius `--r-avatar` + nombre). Filas de
`--h-nav-row`; item seleccionado = fill `--sidebar-selected-bg` radius
`--r-selected` + texto Semi Bold `--sidebar-selected-text`; no seleccionado =
sin fill, Regular `--sidebar-text`. Inbox lleva el badge de conteo
(`pendingEscalations().length + state.appeals.length`, la lógica actual de
`nav.js`); es el único item con badge.

### 3.3 Render

`renderNav()` pasa a escribir en `#sidebar` en lugar de devolver markup del
topnav; `render()` (`render.js`) deja de incluir la nav en el innerHTML del
pane. Los banners globales (`compilerSetupNudge`, `mockBanner`,
`firstRunBanner`) siguen entrando al pane arriba del body de la vista. Nada
más cambia en la mecánica.

### 3.4 Instalación solo pura

`soloIsPureInstall()` sigue mandando: la sidebar muestra solo **LOCAL** (This
device, Settings) y **MANAGE** (Models). Misma cáscara, menos items — no hay
diseño nuevo que inventar. La vista Settings (`soloSettings`) se re-estiliza
con el sistema (página de settings de 760, patrón §6.4), sin frame propio.

### 3.5 Anatomía de página

- **Un solo origen de contenido: x=280** (240 de sidebar + 40 de padding).
  Títulos, tablas, hilos y cards nacen todos ahí.
- **Header de página** (Header/Page 299:2683): título `--fs-7` + una línea de
  contexto `--fs-3` `--muted`; acciones arriba a la derecha (0, 1 o 2 — el
  primario grafito relleno). Breadcrumb (Header/Breadcrumb 299:2646) solo en
  páginas de detalle y flujos (Workspace / Rules / …).
- **Columna de lectura 760** para conversaciones y páginas de settings,
  alineada a la izquierda en x=280. La ÚNICA excepción centrada del producto
  es New rule, y desde 2026-09-17 lo es de punta a punta: el hero, el hilo,
  el composer y la página de resultado comparten una columna centrada dentro
  del bloque de 1120 (`.--centred`). Antes sólo el hero estaba centrado y el
  hilo caía en x=280, así que el composer saltaba 180px al costado en cuanto
  se mandaba la primera frase. El header de página NO se mueve: sigue en
  x=280 como en toda vista.
- **Tablas**: bloque de 1120 en x=280; las filas, headers de columna, bandas
  de grupo y divisores miden 1160 y sangran simétricamente 20px por lado
  (hover y focus ring pisan el gutter; el texto queda en la grilla).
  Headers de columna UPPERCASE `--fs-1`. El padding lateral interno de la
  fila (20px) devuelve el texto a x=280.
- **Composer** al pie en Test (fijo abajo, 760, en x=280); en New rule es el
  mismo box de una línea en los dos estados — centrado y a media altura
  mientras la conversación está vacía, centrado y al pie una vez empezada.
  Misma x y mismo ancho siempre; lo único que cambia es la altura a la que
  está.

## 4. Componentes → clases CSS

Un componente = una clase base + modificadores. Nombres nuevos para lo que el
sistema renombra; clases actuales se migran con grep. Referencia visual:
`design/console-v2/design-system/*.png`.

| Componente (Figma id) | Clase | Variantes / notas |
| --- | --- | --- |
| Button (258:119) | `.btn` | `--primary` (grafito relleno) / `--quiet` (delineado) / `--danger` (rojo apagado); estados hover/pressed/focus/disabled/loading; 40px |
| Button / Compact (378:1962) | `.btn.--compact` | 32px; Kind Primary/Quiet; para editores inline y footers de sección |
| Field (261:105) | `.field` | label + input + helper; Single/Multiple; error con `--verdict-block` |
| Field / Compact (489:89) | `.field-compact` | solo el control, 32px, sin label/helper propios |
| Composer (263:479) | `.composer` | 760; Empty/Ready/Busy; adjunto con Chip/File |
| Menu (404:5947) + Menu/Item (404:5942) | `.menu` / `.menu-item` | surface `--surface-raised`, hairline, radius 6, padding 4, sombra 2 capas; item 40px, `--destructive` último; capas Dot/Label/Check. Anclaje: borde derecho al trigger, 6px abajo; el trigger queda en hover mientras está abierto |
| Trigger / Value (515:7968) | `.trigger-value` | el valor ES el control: fill page, borde `--line-accessible`, radius 6, pad 9/14, valor `--fs-4` ink + ▾; Open = fill `--surface-subtle` |
| Sidebar (259:631) | `.sidebar` | §3.2 |
| Header / Page (299:2683), / Breadcrumb (299:2646), / Detail (299:2729) | `.page-head`, `.crumbs`, `.detail-head` | Detail: 6 patrones (Test/Management/Edit/Introduction/Decision/Status) |
| Tabs / Team (336:63), / Models (498:81) | `.tabs` / `.tab` | subrayado 2px ink en la activa — patrón solo para sub-tabs, nunca nav |
| Card / Turn (259:649) | `.turn` | Voice=Person (gris, sin borde) / Voice=Warden (raised + hairline) |
| Feedback (262:97) | `.feedback` | Info/Attention/Success/Error; placa a lo ancho para estados de lista |
| Badge / Effect (210:393) | `.badge-effect` | Block/Escalate/Warn/Active con tint de fondo — solo en cards/detalle |
| Badge / Verdict (229:11) | `.badge-verdict` | Blocked/Held/Allowed — SIEMPRE esas palabras, nunca el enum |
| Label / Role (210:404) | `.role-label` | chip DELINEADO: hairline, sin fill, radius 6, texto en color de rol |
| Row / Rule (264:163), / Decision (279:1712), / Inbox (280:1706), / Person (335:2548), / Role (415:107) | `.trow.--rule` etc. | 1160 con sangrado §3.5; hover `--surface-subtle`; en fila el efecto/veredicto es texto coloreado plano, sin caja |
| Disclosure / Row (515:91) | `.disclosure` | una línea: título izquierda, `datum ⌄` derecha (`--fs-3` muted, gap 8); pad 14/0, hairline abajo; expandida pierde su hairline y el contenido de abajo la lleva; chevron ⌄→⌃. Datum solo si reporta estado |
| Section / Expandable header (371:61) | `.section-toggle` | agrupa páginas de settings; chevron al borde del contenido |
| Group band (246:759) | `.group-band` | bandas de día (Activity) y de grupo (Inbox) |
| Confirmation / Result (310:3483), Toast (310:3487) | `.confirm-result`, `.toast` | toast grafito, abajo al centro |
| Chip / File (212:9) | `.file-chip` | |
| Segmented control / Tool (371:86) | `.seg-tool` | solo en Connection & setup |
| Rule proposal (291:2027, 263:91) | `.proposal` | cards de la conversación de New rule |

Reglas transversales: radio 6 en todo (pills prohibidas); un editor inline no
contiene disclosures ni chevron propio y sus acciones van en Compact
alineadas a la izquierda, cero hairlines internos; Save solo aparece cuando
el valor cambió; hover = `--surface-subtle`, nunca un cambio de borde.

## 5. Rutas

El router y el formato `#/view/sel?query` no cambian; cambian significados de
`sel` donde "rows open a page":

| Hash | Vista |
| --- | --- |
| `#/activity` | Registro (agrupado por día) |
| `#/activity/<recordId>` | **NUEVO**: detalle de decisión en página (bloqueo / permitido / retenido según el registro) |
| `#/inbox` | Bandeja, tres grupos |
| `#/inbox/<escalationId>` | **NUEVO**: retención abierta en página |
| `#/inbox/appeal-<id>` | **NUEVO**: apelación en página (si la API no da id estable, se indexa determinísticamente y se documenta en el módulo) |
| `#/policy` | Lista de reglas |
| `#/policy/<ruleId>` | **CAMBIA**: detalle en página propia (hoy: expansión inline) |
| `#/policy/edit:<ruleId>` | **NUEVO**: edición in place |
| `#/policy/new` | Crear (conversación, hero) |
| `#/simulator` | Test (`railParent: 'policy'` se conserva) |
| `#/people`, `#/people/roles`, `#/people/company`, `#/people/<id>` | igual que hoy |
| `#/models`, `#/models/library`, `#/models/prompts` | igual que hoy |
| `#/soloRules` (This device), `#/soloSettings` | igual que hoy |
| `#/redteam`, `#/engine`, `#/compiler` | se conservan como destinos linkeados; solo se re-estilizan. La doble registración de `compiler` (`compiler.js:39` pisada por `models.js:299`) se limpia: queda una |

Links existentes que deben seguir resolviendo: `data-go="simulator"`,
`#/policy/new`, `#/policy/<ruleId>` (ahora abre página en vez de expandir —
mejor, no regresión).

## 6. Vistas, pantalla por pantalla

Cada entrada: `PNG (design/console-v2/…) — node-id — notas`. El copy visible
en el PNG es el copy a implementar, en inglés, tal cual.

### 6.0 El molde de estados de lista (aplica a toda lista)

Vacío / sin resultados / cargando / fallo comparten molde: header intacto,
tabla y filtros ocultos (en "sin resultados" los filtros QUEDAN visibles con
su valor), placa `Feedback` a lo ancho (Info para vacío/cargando, Attention
para fallo), botón solo si hay acción real (Retry loading en fallo; Clear
filters en sin resultados). La línea de contexto del header pasa a `--muted`
en estos estados. Todo fallo de carga separa log de protección: "Your rules
still apply — requests keep being judged."

### 6.1 Rules (`rules/`)

Consultar: `lista` 266:244 · `detalle` 266:603 (página propia; acciones Edit
rule / Test rule / Deactivate…) · `lista-vacia` 280:1788 · `sin-resultados`
280:1886 · `cargando` 280:1986 · `fallo-de-carga` 280:2084 · `menu-de-fila`
487:2580 (el ··· repite exactamente las acciones del detalle; Deactivate es
reversible → Kind Default, último).

Editar: `editar` 266:836 (in place; Cancel / Test rule / Save changes) ·
`editar-validacion` 276:1510 · `editar-fallo-al-guardar` 217:96 (cambios
retenidos en el form; la versión anterior sigue rigiendo) ·
`editar-salir-sin-guardar` 217:193 (scrim + diálogo; Keep editing default
seguro, Discard rojo apagado) · `editar-guardado` 310:3699 (toast grafito
"Changes saved — this version is enforcing now") ·
`editar-conflicto-de-version` 278:1671 — **DISEÑADA PERO FUERA DE ALCANCE**:
la API es last-write-wins sin 409; no implementar hasta que exista.

Crear (conversación con el compilador; motor `draft.js`/`draft-set.js`
intacto): `crear-inicio` 222:3 (el ÚNICO hero centrado; chips de
preocupación; botón "Draft rules") · `crear-redactando` 222:85 (status card
con la línea de transparencia real: la frase y los roles van al compilador,
lo juzgado nunca sale) · `crear-propuesta` 293:1976 (cards de 3 niveles,
instrucción siempre visible — nunca activar sin leer; "Applies to" solo si ≠
Everyone; mitad de gasto → card de LIMIT apuntando a Team → Roles; "Nothing
is active until you do") · `crear-menu-de-acciones` 293:2256 ·
`crear-editar-draft` 274:1155 · `crear-draft-excluido` 276:1400 ·
`crear-pedido-no-regla` 277:1932 · `crear-refinando` 277:1458 ·
`crear-revisar-refinamiento` 323:2288 · `crear-refinamiento-fallido`
323:2403 · `crear-revisar-activacion` 273:663 · `crear-activando` 274:825 ·
`crear-fallo-de-activacion` 274:1045 · `crear-activadas` 310:3495 ·
`crear-exito-parcial` 310:3592.

Probar (motor de `simulator.js` intacto; header de contexto fijo + hilo 760 +
composer abajo): `test-preparar` 199:451 (empty: una línea muted centrada,
chips de ejemplo sobre el composer) · `test-en-curso` 199:554 ·
`test-bloqueo` 266:1075 ("⊘ Would block" 20SB rojo dominante; la razón a 16px
es el payload; "View extraction report →" quiet) · `test-permitido` 209:3 ·
`test-escalado` 209:98 · `test-advertencia-y-version` 272:606 (divisor "Regla
editada" entre tests de versiones distintas del draft) · `test-fallida`
209:193 (fail-closed: "nothing was cleared"; composer restaurado con el
archivo para reintentar) · `test-ventana-1280` 278:1772 (referencia
responsive) · `test-resultado-anterior` 324:2452.

### 6.2 Activity (`activity/`)

`registro` 268:596 (tabla WHO/REQUEST/RULE/VERDICT/TIME agrupada por día;
veredicto = texto coloreado; fila "Not stored" para registros solo-hash;
"Log verified · N records" verde en la línea de contexto; acción "N waiting
on you →" al Inbox) · `filtro-de-persona` 482:558 (menú sobre el trigger de
filtro) · estados: `registro-vacio` 480:353 · `sin-resultados` 480:6883 ·
`cargando` 480:6981 · `fallo-de-carga` 480:7080.

Detalle (página por fila — "el intercambio": el pedido como turno de persona,
la respuesta como tarjeta de veredicto; 3 disclosures colapsadas con su datum
a la derecha; "nothing left this machine" vive SOLO en How it was decided):
`detalle-de-bloqueo` 229:172 · `detalle-de-permitido` 478:6676 (**sin tarjeta
de Warden** — solo la línea muted "Checked against the N rules that apply to
X — none matched"; sin acción de header) · `detalle-de-retenido` 478:6708
("↗ Held for review"; línea "Waiting in your Inbox since…"; acción "Answer in
Inbox").

Datos: `GET /api/audit` ya trae todo; el detalle de un registro se busca por
id en `state.audit` (si el registro no está en la página cargada, se pide con
`?limit=` mayor — sin endpoint nuevo).

### 6.3 Inbox (`inbox/`)

`bandeja` 269:585 (UNA lista, tres grupos: Waiting on you / Reported as wrong
/ Already answered — bandas de grupo, no tabs) · `sin-pendientes` 229:610 ·
`cargando` 486:571 · `fallo-de-carga` 486:7189 ("Nothing is lost — held
requests stay held until someone answers").

Retención en página: `retencion-abierta` 270:620 (Approve primario + Refuse
rojo apagado + "their next ask is judged on its own") · `guardando-respuesta`
275:1102 · `ya-respondida` 276:1309 · `respuesta-registrada` 317:518 ·
`fallo-al-guardar-EN-REVISION` 276:1213 — único frame del redesign que el
owner no marcó Elegida: implementarlo igual (es el molde de fallo estándar) y
señalarlo en el PR para revisión.

Apelación: `apelacion` 229:517 (las palabras de la persona primero; acción =
Open the rule; no existe "resolver" en la API y la pantalla no lo promete).

### 6.4 Team (`team/`)

People: `people` 336:68 · `people-menu-de-rol` 342:4296 · `people-menu-de-fila`
413:1976 · `add-people-modal` 346:312 · `person-added` 352:421 ·
`people-added` 352:531 · detalle `detalle-sin-conectar` 354:683 /
`detalle-conectada` 354:749 · `conexion-y-setup` 363:878 (la referencia de
toda página de settings: una tarea abierta, el resto colapsado) ·
`menu-de-persona` 363:1028 · confirmaciones y errores: `confirmar-rol-exento`
363:1066 ("Exempt from company-wide rules" — NUNCA "exempt from all rules";
las reglas que nombran al rol o a la persona siguen atando) · `renovar-clave`
363:5283 · `quitar-persona` 363:5344 · `error-cambiar-rol` 363:5601 ·
`error-renovar-clave` 363:5665 · `error-quitar-persona` 363:5925 ·
`rol-actualizado` 364:1703 · `clave-renovada` 364:1816 · `persona-quitada`
364:5937.

Roles: `roles` 414:4610 · `roles-limite-abierto` 419:2206 — el editor inline
de UNA línea (62px): título 14SB + Field/Compact de 90 + línea muted
"requests a day · blank means no limit" + Cancel/Save limit en Compact a la
izquierda; Save solo si cambió; cero hairlines propios ·
`roles-menu-de-rol` 419:6335 · `roles-nuevo-rol` 419:6480. Sin session
ceilings acá — viven en Models (§6.6). Límites NO son plata: el footnote de
la página lo dice ("A daily limit is a number of requests, not money…").

Company: `company` 428:2521 (settings 760: Company name abierto como tarea
primaria; Sample data y Reset company como filas desplegables — datum de
Sample data reporta estado, Reset no lleva datum) ·
`company-con-datos-de-ejemplo` 430:2588 (placa Attention "Sample rules are
enforced"; botón Clear sample data) · `company-reset` 430:2619 (scrim +
diálogo PLANO Cancel / Reset company — sin tipear el nombre; copy verdadero:
"Every person goes and every stored prompt is cleared. You get a fresh admin
key — the old ones stop working. Your rules stay.").

### 6.5 This device (`this-device/`)

`local` 493:82 (la máquina, no la persona: Tools on this machine como bloque
abierto — estado como texto coloreado, SIN botones; Public address y Data on
this machine como disclosures) · `direccion-publica` 495:129 ·
`exponiendo` 495:213 (el 202 del túnel honesto: "● Asked the tunnel to open —
usually under a minute", ámbar) · `expuesta` 495:7561 (URL en mono; Copy
address + Stop exposing, ambos Quiet — parar es reversible).

### 6.6 Models (`models/`)

`active` 498:104 (dos BLOQUES, no cards: Rule writer / Request judge; una
línea de privacidad cada uno; **el valor es el control**: Trigger/Value con
el nombre del modelo + estado como texto coloreado AL LADO; disclosure de
Session ceilings colapsada) · `active-primera-vez` 500:137 (molde Connection
& setup: ámbar "Needs setup", tarea abierta "Use Claude Code on this machine
· Recommended" + Test connection; checklist ✓✓○ como texto plano; sin
ceilings acá — una colapsable por pantalla) · `menu-de-modelo` 506:304 (menú
colgando DEL VALOR, alineado izquierda, 6px abajo; solo modelos testeados +
"Add a model…" último) · `cambiando-modelo` 506:406 (el trigger muestra el
ENTRANTE; línea ámbar "● Loading X… judging continues on Y until it's ready")
· `session-ceilings` 512:423 (expandida: tabla ROLE × OUTPUT/CONTEXT/PROMPT
dentro de la disclosure, 760; "—" = sin límite; fila en edición con tres
Field/Compact + Save ceilings/Cancel abajo a la izquierda; footnote "Hitting
a ceiling escalates the request — it never blocks.") · `library` 501:193
(tabla MODEL/JOB/FORMAT/STATUS; modelo y formato en mono; statuses
coloreados; Add model como acción de header) · `prompts` 502:250
(TEMPLATE/JOB/STATUS/Edit; Customized 14SB ink vs Default muted).

Datos: los ceilings por rol usan `PUT /api/quotas/:role` (campos
`maxSessionOutputTokens` / `maxContextTokens` / `maxPromptChars`) — mismos
endpoints que hoy usa Roles; solo cambia dónde se editan.

### 6.7 Dark (`dark/`)

Cinco pruebas renderizadas para comparar tras implementar §2.2:
`registro` 519:84 · `detalle-de-bloqueo` 519:126 · `this-device` 519:158 ·
`models-menu` 519:190 · `company-reset` 519:219.

### 6.8 Vistas sin frame (re-estilizar, no rediseñar)

`redteam`, `engine`, `soloSettings`, el flujo Add model, el prompt editor,
los estados de tabla de Library, la desconexión de tool, el resultado de
Clear sample data: conservan su estructura actual, migrados a tokens y
componentes nuevos (headers, botones, placas, tablas). Cero layout inventado.

## 7. Orden de fases

Cada fase termina con `pnpm run typecheck && pnpm test && pnpm run build` en
verde y captura de pantalla contra su PNG. La consola debe seguir usable al
final de cada fase (WARDEN_ADAPTER=mock para desarrollo).

1. **F1 — Tokens + shell.** §2 completo en `style.css` (con el mapa §2.4
   aplicado por grep a las clases existentes), §3 (sidebar, orígenes,
   headers). Todas las vistas actuales funcionan bajo el chrome nuevo aunque
   sus cuerpos sigan con estilos transicionales.
2. **F2 — Componentes.** §4 completo en CSS + helpers de template
   compartidos (menú, disclosure, placas de estado de lista §6.0, badges,
   tabs, filas de tabla con sangrado).
3. **F3 — Rules** (§6.1): la vista más grande y el molde de lista/detalle/
   edición que las demás copian.
4. **F4 — Activity + Inbox** (§6.2–6.3): páginas de detalle nuevas y rutas
   nuevas.
5. **F5 — Team** (§6.4).
6. **F6 — Models + This device** (§6.5–6.6) + §6.8.
7. **F7 — Dark + QA.** Verificar §6.7 contra los PNG; barrido de literales
   (§8); `scripts/test-console.mjs` actualizado; walkthrough manual.

Un PR por fase o un PR total — decisión de quien ejecuta — pero los commits
respetan los cortes de fase para poder bisectar.

## 8. Verificación

- `pnpm run typecheck`, `pnpm test`, `pnpm run build` — sin regresiones.
- **Barridos** (los bugs que este sistema ya tuvo en Figma y no deben
  repetirse en CSS):
  - Cero hex fuera de los bloques de tema: revisar `web/style.css` por
    `#[0-9a-fA-F]` fuera de `:root`/`@media`.
  - Cero color de sidebar tomado de tokens que se invierten: dentro de
    `.sidebar` solo `--sidebar-*`.
  - Todo flotante en `--surface-raised` (menús, diálogos, toasts) — el bug
    "menú blanco en dark" fue exactamente esto.
  - Nunca elegir token por valor: `--surface-disabled` y
    `--sidebar-selected-text` comparten hex en light (`#F0F0F2`) y divergen
    en dark. Elegir por ROL siempre.
  - Grep: `--r-pill` cero usos; `.seg` muerto; `backToRules` cero usos si
    Test adopta el header de contexto.
- **Walkthrough manual** (navegador, con mock y con datos de ejemplo):
  escribir y activar una regla; probarla con archivo; expandir el ···; abrir
  detalle de decisión de cada veredicto; aprobar y rechazar una retención;
  abrir una apelación; añadir persona, rotar clave, quitar; editar límite de
  rol; editar ceilings en Models; cambiar modelo (menú solo-testeados);
  reset de company (leer el diálogo); exponer y dejar de exponer; los cuatro
  estados de cada lista (fallo simulable cortando el server); TODO lo
  anterior otra vez con el OS en dark.
- **Anchos**: 1280 (referencia `rules/test-ventana-1280.png`) y los
  breakpoints existentes de 760/640 no rompen (tablas scrollean en su
  contenedor, la sidebar puede colapsar a íconos o quedar fija — criterio:
  nunca scroll horizontal del body).

## 9. Pendientes declarados (no bloquean el merge)

- Inbox "Fallo al guardar" quedó "En revisión" en Figma — implementado igual
  (molde estándar), marcado para el owner en el PR.
- "Conflicto de versión" (278:1671) espera un 409 que no existe.
- Segunda tanda de diseño: Add model flow, prompt editor, estados de tabla de
  Library, Testing state de modelo, desconexión de tool, resultado de Clear
  sample data, datums de Connection & setup — hoy se re-estilizan (§6.8) y se
  rediseñarán con frames propios después.
- Hover/Pressed del Button/Compact Primary comparten fill con Default en
  Figma (tune pendiente declarado) — en CSS usar `--action-hover` para hover
  como el Button grande.
- Vendorizar Geist Mono (opcional, §2.3).
