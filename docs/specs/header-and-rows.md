# El header de página y las filas de tabla — Spec técnico

Implementa [`docs/prd/header-and-rows.md`](../prd/header-and-rows.md). La PRD
dice qué tiene que quedar y con qué palabras; este documento dice qué archivo se
toca, en qué orden, y cuáles de sus supuestos no sobrevivieron al código.

Referencias `archivo:línea` al repo al 2026-09-17, `main` en `85be57b`. Archivo
de diseño `RFPKLtSSZjQMHy9XaOOSqp`.

## 0. Fuentes de verdad

| qué | dónde |
|---|---|
| producto | `docs/prd/header-and-rows.md` |
| el header | componente `Header / Page v4` (`720:959`) |
| el conmutador | `Tabs / Item` (`697:913`), `Tabs / Row` (`712:946`) |
| la fila | `Row / Person` (`335:2548`) |
| por qué el strip se queda adentro | frame de comparación `720:12716` |
| por qué Cancel no existe | frame `727:1240` |
| las 131 pantallas ya migradas | páginas `02`–`09` del archivo |
| qué NO implementar | secciones `90 · Referencia` de cada página |

Cuando esta spec y la PRD digan cosas distintas, gana esta spec y §2 dice por
qué. Cuando esta spec y el archivo digan cosas distintas fuera de §2, gana el
archivo.

## 1. Lo que ya existe y no se toca

- **`src/`, entero.** Esto es consola. Ninguna ruta, ningún esquema, ninguna
  decisión del guard.
- **`web/js/nav.js`.** El sidebar no cambia.
- **`web/js/router.js`.** Incluido `holdLeave` (`router.js:49`), que es la razón
  por la que Cancel puede desaparecer sin perder la protección de salida.
- **Los tokens de color con significado.** `--verdict-*`, `--role-*`,
  `--signal-red`.
- **`ui.js` fuera de las cinco funciones de §3.** `button`, `menu`, `feedback`,
  `listState`, `disclosureRow`, `conditionBlock` y el resto quedan como están.

## 2. Las tres decisiones que esta spec toma sobre la PRD

La PRD se escribió mirando el archivo de diseño y las vistas que yo había
abierto. Leer los 28 call sites cambió tres cosas.

### 2.1 Hay 12 módulos, no 9

`pageHead` se llama en **28 lugares de 12 módulos**, no en los 9 que la PRD da
por sentado. Los cuatro que faltaban —`inbox.js` (5), `simulator.js` (2),
`redteam.js` (1), `engine.js` (1), `draft-set.js` (1)— no aparecen en ninguna
conversación de diseño y ninguno está dibujado en Figma. Se migran igual, con el
criterio de §5, y sus pantallas quedan sin referencia visual: es aceptable
porque ninguno tiene tabs ni toolbar, así que todos caen en el caso simple.

### 2.2 `sub` no se usa 8 veces, se usa 20 — y 4 de ellas son datos

La PRD §4 lista 14 descripciones. Son 20, y la diferencia no es de conteo: **en
cuatro casos la segunda línea no es prosa, es la identidad del registro.**

| call site | valor | veredicto |
|---|---|---|
| `activity.js:332` | `${whenLine(entry.ts)} · judged in ${seconds(d.totalMs)}` | **queda** |
| `inbox.js:144` | `Recorded ${…} · original decision: Held at ${hhmm(e.at)}` | **queda** |
| `inbox.js:166` | `${whenLine(e.at)} · waiting ${waitedFor(e.at)}${judged}` | **queda** |
| `team.js:670` | `esc(personLine(p))` | **queda** |

Cambia con cada registro, no se repite en ninguna otra parte de esa pantalla, y
no es una oración. La regla «el header no tiene segunda línea» se escribió
mirando vistas raíz, donde la `sub` duplicaba los filtros. En una vista de
detalle no duplica nada.

Por eso el componente **sí** lleva un parámetro `meta`, con una regla dura
alrededor: mono, una línea, sólo en vistas con `crumbs`, y nunca una oración.
Sin `crumbs` el parámetro se ignora. La restricción es estructural, no de
criterio, para que la pregunta no se reabra vista por vista.

Esto contradice la descripción del componente en Figma, que dice que no hay
parámetro para una segunda línea. Gana esta spec; hay que corregir la
descripción del componente.

### 2.3 `.page-head.--verdict` existe y la PRD no lo vio

`style.css:995-996` y `activity.js:332` tienen un modificador para el header de
una decisión: `min-height: 0`, `align-items: flex-start`, y margen extra sobre
la `sub`. Es exactamente el caso de §2.2 resuelto a mano y antes. El modificador
se borra: con `meta` en el componente deja de hacer falta.

### 2.4 `.sheet` no puede seguir siendo un grid

El header es sticky (PRD §6: «El header no se va con el scroll»), y **el bloque
contenedor de un grid item es su propia grid area**. La fila del header mide
exactamente lo que mide el header, así que `position: sticky` no tiene por
dónde moverse y el header se va con el scroll igual. El bloque contenedor de un
flex item, en cambio, es el contenedor entero.

`.sheet` pasa a `display: flex; flex-direction: column`, con el mismo
`gap: var(--s-block)` y la misma regla de que los bloques no llevan margen. Lo
único que se pierde es `align-content: start`, que en columna es el default de
`justify-content`.

### 2.5 Las dos sublíneas de `solo.js` que no se pueden borrar

§7 manda `mitad → found` para `wired === false` y para `t.found` con
`wired === null`. Las dos comparten la línea de arriba —`Not connected · no
request judged`— así que reducir las dos a `Found` deja dos estados
indistinguibles, y son justamente los dos que el módulo separa a propósito:
silencio no es ausencia. Se quedan, acortadas: `Found · not in its settings` y
`Found · wiring not reported`. El criterio de §7 supone que la línea de arriba
ya carga la distinción; acá no.

### 2.6 El `Cancel` de `draft.js` no es el de `rules.js`

§6 pide verificarlo al migrar. No se repite el patrón: la propuesta y el editor
de un draft son **la misma ruta** (`policy/new`) y lo que las distingue es
`set.editing`. `go('policy', 'new')` desde ahí deja `location.hash` igual,
`route()` no ve movimiento y el editor se vuelve a dibujar — o sea que el crumb
sería un botón que no hace nada. El botón se saca igual, pero el crumb se lleva
el trabajo: `crumbs` acepta un `id` sin `go` para que la vista lo ligue. Queda
un quiet y un primary, como en todos lados.

## 3. `web/js/ui.js`

### 3.1 `pageHead` — reemplaza `contextBar` y `tabs`

```js
export function pageHead({
  title,
  crumbs = [],   // sólo en detalle; en una vista raíz el sidebar ya lo dijo
  meta = '',     // mono, una línea, sólo con crumbs. Ver §2.2
  primary = '',  // exactamente uno, o ninguno
  quiet = '',    // como máximo uno
  more = [],     // ítems de menu(); lo destructivo acá, último
  strip = ''     // tabs() o el toolbar de la vista
})
```

`sub`, `subMuted` y `actions` se van. Borrar `sub` rompe los 20 call sites en el
typecheck, que es cómo se encuentran sin ir a buscarlos.

Markup:

```html
<header class="page-head">
  <div class="page-head-top">
    <div class="page-where">
      <button class="page-crumb" data-go="…">← Rules</button>
      <span class="page-sep">/</span>
      <h1 class="page-title">Contract terms</h1>
    </div>
    <div class="page-meta num">12:41 today · judged in 4.4 s</div>
    <div class="page-actions">…quiet, primary, menu…</div>
  </div>
  <div class="page-strip">…</div>
</header>
```

El crumb es un `<button>`, no un `<span>` dentro del título. Plegado en el
título sería el dibujo de un link: sin hover, sin foco, sin tab-stop. Cada
segmento conserva el `data-go`/`data-sel` que `contextBar` ya emitía
(`ui.js:33-43`), así que el handler delegado de `nav.js` sigue sirviendo sin
cambios.

`meta` va en la fila de arriba, entre el título y las acciones, no debajo. Es lo
que mantiene la fila en una sola línea y `align-items: center` estable.

### 3.2 `contextBar` — se borra

`ui.js:33-43`. Sus 30 call sites pasan a `crumbs` de `pageHead`. Las cinco
vistas raíz —Rules, Team, Activity, Inbox, Models, Gateway, This device— lo
pierden entero.

### 3.3 `tabs` — deja de emitir su riel

`ui.js:57`. La firma no cambia. Lo que cambia es que ya no dibuja un riel ni un
acento: cada tab pasa a ser una card. El tercer elemento de cada ítem
(`mark`) pasa de un `•` de texto al punto de §4.3.

### 3.4 `search` — pierde la caja dentro del strip

`ui.js:115`. La firma no cambia; el CSS de §4.2 le saca el borde cuando vive en
`.page-strip`. Fuera del strip queda como está.

## 4. `web/style.css`

### 4.1 El header

Reemplaza los bloques de `532` a `549` (`.context-bar`, `.crumbs`, `.crumb`,
`.page-head`, `.page-head-text`, `.page-title`, `.page-sub`, `.page-actions`) y
borra `995-996` (`.page-head.--verdict`, ver §2.3).

```css
:root { --h-page-row: 56px; }   /* token nuevo, único de este documento */

.page-head {
  position: sticky; top: 0; z-index: 10;
  margin-inline: calc(-1 * var(--w-bleed)); padding-inline: var(--w-bleed);
  background: var(--surface-page);
  border-bottom: 1px solid var(--line-hairline);
}
.page-head-top {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--s-7); height: var(--h-page-row);
}
.page-where { display: flex; align-items: baseline; gap: var(--s-2); min-width: 0; }
.page-crumb {
  border: 0; padding: 3px var(--s-2); border-radius: var(--r-control);
  background: none; font-size: var(--fs-4); color: var(--muted);
  white-space: nowrap; cursor: pointer;
}
.page-crumb:hover { background: var(--surface-subtle); color: var(--ink); }
.page-title {
  margin: 0; font-size: var(--fs-6); font-weight: var(--fw-semi);
  line-height: var(--lh-tight); letter-spacing: var(--ls-tight); color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.page-meta { font-size: var(--fs-2); color: var(--muted); white-space: nowrap; }
.page-actions { display: flex; align-items: center; gap: var(--s-3); flex: none; }
.page-strip { display: flex; align-items: center; gap: var(--s-1); height: var(--h-tabs); }
```

**El fondo es `--surface-page`, no `--surface-subtle`.** El gris sutil es un
*estado* en sus 26 usos —hover, open, pressed, recuadro hundido— y en claro es
además el mismo `#F4F5F4` que `--sidebar-bg`, con lo que la banda y la
navegación se fusionaban. Acá el fondo existe sólo para que sticky no deje pasar
el contenido por debajo; en reposo es invisible.

**El bleed es `--w-bleed`**, el mismo que las tabs y las filas ya usan. Es el
único valor de bleed del sistema y sigue siendo el único.

`.page-title` pasa a `--fs-6`. Con eso `--fs-7` queda con un solo usuario en
todo el stylesheet, `.first-run-body h1` (`1447`), que es la pantalla que se ve
una vez por instalación.

### 4.2 El conmutador

Reemplaza `.tabs` y `.tab` (`571-585`) y `.filter` (`470-476`) por un solo
bloque. El riel y el acento de 2px desaparecen.

```css
.tab, .filter {
  display: inline-flex; align-items: center;
  height: var(--h-control-compact); padding: 0 var(--s-5);
  border: 0; border-radius: var(--r-control); background: none;
  font-size: var(--fs-4); font-weight: var(--fw-medium);
  color: var(--muted); cursor: pointer; white-space: pre;
}
.tab:hover, .filter:hover { background: var(--surface-subtle); color: var(--ink-body); }
.tab.--on, .filter.--on { background: var(--surface-selected); color: var(--ink); }
.tabs, .filter-set { display: flex; gap: var(--s-1); }

.page-strip .search {
  width: auto; height: var(--h-control-compact);
  border-color: transparent; background: none;
  margin-left: auto; padding-inline: var(--s-3);
}
.page-strip .search:hover { background: var(--surface-subtle); }
```

**`--surface-selected` es un token nuevo y es obligatorio.** Sin él, hover y
seleccionado comparten `--surface-subtle` —que es el bug que `.filter` tiene hoy
(`475` y `476` son el mismo valor)— y pasar el mouse por una tab no seleccionada
se lee igual que la seleccionada. Valores: `#E6E8E6` claro, `#303030` oscuro,
los mismos que `--sidebar-selected-bg` ya usa. Va en los tres bloques de tema.

Con esto `--sidebar-selected-bg` queda como alias de `--surface-selected`, o se
borra y el sidebar usa el token nuevo. Lo segundo es mejor; el stylesheet dice
que son dos nombres porque responden a dos roles, y con la card pasan a ser un
rol solo: «esto está elegido».

### 4.3 El punto de pendiente

```css
.tab-dot {
  display: inline-block; width: 5px; height: 5px; margin-left: var(--s-2);
  border-radius: 50%; background: var(--verdict-attention);
}
```

`tabs()` ya acepta un tercer elemento por ítem y `models.js:276` ya lo usa. Lo
que falta es que `solo.js:588` lo pase: un tab con trabajo sin terminar se marca
y hoy no.

### 4.4 Las filas

`.cell-stack` (`618-619`) deja de ser un `grid` vertical y pasa a ser una línea:

```css
.cell-stack { display: flex; align-items: baseline; gap: var(--s-2); min-width: 0; }
.cell-stack small { font-size: var(--fs-3); color: var(--muted); }
.cell-stack .sep { color: var(--muted); }
```

`.exempt-note` (`1049`) se borra y se reemplaza por un chip:

```css
.exempt-chip {
  display: inline-flex; align-items: center; height: 20px; padding: 0 var(--s-2);
  border-radius: 4px; font-size: var(--fs-2); font-weight: var(--fw-medium);
  color: var(--verdict-attention); background: var(--verdict-attention-bg);
}
```

`.tool-row` (`1519`) baja su padding de 18 a 12: con la celda en una línea, el
piso de la fila lo pone el botón de 32, y 18+32+18 da 68 donde 12+32+12 da 56.

## 5. Las 28 migraciones

Todas siguen la misma forma. `contextBar(x) + pageHead({title, sub, actions})`
pasa a `pageHead({title, crumbs, meta, primary, quiet, more, strip})`.

| módulo | sites | crumbs | meta | notas |
|---|---|---|---|---|
| `rules.js:114` | 3 | — | — | `Test rules →` quiet, `+ New rule` primary |
| `rules.js:285` | 1 | `Rules` | — | |
| `rules.js:308` | 1 | `Rules` | — | `Remove rule…` al menú |
| `rules.js:394` | 1 | `Rule details` | — | **`Cancel` se borra** (§6) |
| `team.js:140` | 1 | — | — | strip = `tabs()` |
| `team.js:653` | 1 | `Team` | — | |
| `team.js:668` | 1 | `Team` | `personLine(p)` | menú de persona |
| `activity.js:130/134/138` | 3 | — | — | la `sub` de carga se borra |
| `activity.js:145` | 1 | — | — | strip = toolbar |
| `activity.js:332` | 1 | `Activity` | `whenLine · judged in Xs` | borrar `--verdict` |
| `activity.js:345` | 1 | `Activity` | — | |
| `inbox.js:51/55/61/66` | 4 | — | — | 61 y 66 pierden su `sub` |
| `inbox.js:129` | 1 | `Inbox` | — | |
| `inbox.js:144` | — | `Inbox` | `Recorded … · Held at …` | vive en el bloque de 144 |
| `inbox.js:166/222` | — | `Inbox` | `whenLine · waiting X` | |
| `models.js:275` | 1 | — | — | strip = `tabs()`; `SUBS` se borra entero |
| `gateway.js:328` | 1 | — | — | sin strip: las tabs van bajo `conditions()` |
| `solo.js:582` | 1 | — | — | sin strip, ídem |
| `solo.js:826` | 1 | `This machine` | — | la `sub` baja a lede |
| `draft.js:55/326` | 2 | sí | — | la `sub` baja a la conversación |
| `draft-set.js:237` | 1 | sí | — | ídem |
| `engine.js:21` | 1 | `Models` | — | la `sub` baja a lede |
| `redteam.js:28` | 1 | `Rules` | — | la `sub` baja a lede |
| `simulator.js:108/406` | 2 | `Rules` | — | `View instruction` quiet |

**Gateway y This device no llevan strip.** Ponen `conditions()` entre el título
y las tabs, y ese bloque es verdadero sin importar qué tab esté elegido. Ahí el
conmutador pertenece al contenido que conmuta: `tabs()` se renderiza dentro de
`.gw-page` / `.device-page` como hoy, con el CSS nuevo de §4.2.

## 6. `Cancel`, y por qué se puede borrar

`rules.js:396` dibuja `Cancel`; `rules.js:453` lo liga a
`go('policy', rule.id)`. El crumb de atrás de `rules.js:393` navega al mismo
lugar. Y `router.js:49` corre `holdLeave` en toda navegación, que en
`rules.js:50` es `holdEdit`, que en `rules.js:365-372` arma el diálogo «Leave
without saving?» cuando hay cambios sucios.

O sea: **los dos caminos son el mismo camino, guard incluido.** Borrar el botón
no abre ningún agujero. Quedan `Test rule` quiet y `Save changes` primary, que
es exactamente la regla de la PRD §3.3 sin excepción.

Lo mismo en `draft.js:326` si su header repite el patrón; verificar al migrar.

## 7. Las segundas líneas de las filas

Dieciséis, en `team.js`, `solo.js` y `model-library.js`. El criterio, en orden:

1. ¿Es una instrucción y ya hay un control que la ejecuta? → se borra.
2. ¿Dice lo mismo para todas las filas de ese estado? → es una definición, se borra.
3. ¿Cambia por fila? → es un dato, se queda en la misma línea con un `·`.

| archivo | sublínea | veredicto |
|---|---|---|
| `team.js:90` | `2 devices · hook vX` | dato |
| `team.js:93` | `X removed from its settings` | mitad → `X` |
| `team.js:96` | `N devices since the key was rotated` | mitad → `N devices` |
| `team.js:99` | `An older hook that does not say what it wired` | definición → borrar |
| `team.js:101` | `No device has ever checked in` | definición → borrar |
| `team.js:519` | `Exempt from company-wide rules` | mitad → chip `exempt` |
| `team.js:644` | `hook vX · last heard from Y` | dato |
| `solo.js:229` | `everyone · not judged for you` | mitad → `everyone` |
| `solo.js` `toolFacts` ungovernable | `No prompt hook exists…` | definición → borrar |
| `solo.js` `toolFacts` verified/wired | `Wired · reported X` | dato |
| `solo.js` `toolFacts` `wired===false` | `Found · Warden is not in X settings` | mitad → `found` |
| `solo.js` `toolFacts` `found` | `Found · this machine has not reported…` | mitad → `found` |
| `solo.js` `toolFacts` not found | `Install X before connecting it` | instrucción → borrar |
| `model-library.js:107/148/158` | nombre · tamaño · velocidad | dato |

**Dónde para el criterio.** `team.js:644` tiene cinco datos entre las dos
líneas: `Claude Code · wired · hook v0.2.5` arriba y `Reported 40 min · last
judged 5 min` abajo. Juntarlos da un renglón corrido. Ahí las dos líneas se
quedan y sólo se les saca la cola explicativa. La regla dice que dos hechos
**cortos** no necesitan dos líneas; cinco sí.

**`model-library.js:148` no es un caso de sublínea.** Tiene nombre, tamaño y
`4.4 s a decision` en una línea gris, y ese último es el número con el que se
elige un modelo. Esa tabla necesita columnas, no un renglón más largo. Fuera de
alcance, anotado para su propio rediseño.

## 8. Orden

**Esto se escribió mal y se implementó en un commit.** `tsconfig.json` excluye
`web/`, así que borrar `sub` no rompe ningún typecheck: los call sites
aparecieron por el error de import de `contextBar` y por grep. Y los cuatro
commits no se pueden separar de todos modos — un call site no se puede migrar
primero por su copy y después por sus acciones, porque para llamar al `pageHead`
nuevo hay que decidir las dos cosas a la vez.

Lo que sí se separó: el trabajo de ritmo de página y del bloque de condiciones
que ya estaba sin commitear en el árbol fue a su propio commit antes de este,
para que el diff del header se lea solo.

Lo que se implementó, entonces:

1. **El componente y la hoja de estilos.** `pageHead` nuevo, `contextBar`
   borrado, `tabs` como card, el CSS de §4, `--surface-selected`, `--h-page-row`.
2. **Los 28 call sites**, con sus crumbs, su `meta`, sus acciones bajo la regla
   uno + uno + resto, y las catorce descripciones borradas o bajadas a lede.
3. **Las filas** de §7, el chip de exención y el punto de pendiente.

## 9. Lo que no está acá

- **La tabla de Models con columnas propias** (§7).
- **`headlineAction` con más de un hueco.** `solo.js` atiende sólo `gaps[0]`, así
  que con tres condiciones sin cumplir hay tres filas en ámbar y un botón. El
  punto de pendiente mejora el diagnóstico, no la acción. Es un problema de
  producto, no de layout.
- **El tab Overview de Gateway.** Duplica dos filas del bloque de estado
  (`Hooks` y `Reach` contra `Decision deadline` y `If it cannot answer`). Está
  decidido sacarlo y mover `Devices` al bloque, pero es un cambio de contenido y
  merece su propia pasada.
- **Una suite de navegador para `web/`.** Sigue sin haberla. Lo que sí hay, y
  esta spec no lo había visto, es `scripts/test-console.mjs` (`pnpm run
  test:console`): 61 tests que importan los módulos y comparan el HTML que
  devuelven. Tocan las sublíneas de `solo.js` y hubo que actualizarlos.
  La verificación del layout se hizo renderizando cada vista en cada selección
  bajo Chrome headless, en los dos temas, más un scroll de la lista de reglas
  para confirmar que el header efectivamente se queda.
