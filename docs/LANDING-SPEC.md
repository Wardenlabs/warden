# Warden landing — spec

Producto de 6 rondas de preguntas. Todo lo de acá está decidido, no propuesto.

## 0. Audiencia y trabajo de la página

**Primario:** team lead / PM / CEO evaluando. **Secundario:** la persona técnica a
la que se lo reenvía para que lo valide. Los dos abren la misma URL.

**Patrón que sostiene a los dos:** la prosa habla en lenguaje de negocio (sans),
la evidencia está en mono al lado. El manager lee la prosa y pasa de largo el
mono; el técnico se detiene exactamente ahí. No hay dos páginas.

**Única acción:** bajar el instalador. El comando de source es una línea gris.

## 1. Ley del design system

1. **La luz es un evento, no decoración.** El hero es su casa. Fuera del hero
   aparece una sola vez (§1).
2. **Saturación = veredicto.** Coral, verde y ámbar solo cuando representan un
   BLOCK / ALLOW / ESCALATE real. Todo lo demás es escala de grises.
3. **Mono = la máquina. Sans = nosotros.** Prompt, veredicto, rule id, comando,
   hash, tabla: mono. Prosa: sans. Nunca mono decorativo.
4. **Ninguna forma que el hero no tenga.** Hairlines, texto, superficies planas.
   Cards permitidas si son mínimas (§4.1). Sin sombras, sin gradientes, sin
   iconos ilustrados, sin ventanas de browser dibujadas.
5. **Cada sección se gana el scroll con algo verificable**: un número con
   fuente, una salida real, o un comando que se puede correr.
6. **Menos es más.** En cada pantalla hay *una* cosa que el ojo mira primero, y
   está decidida a propósito.

Regla heredada del proyecto, no negociable: **ningún color ni font-size literal
fuera de `:root`.**

## 2. Ley del copy

- Inglés. **Los prompts del producto quedan en español, sin traducir y sin nota
  al pie** — es la demostración más barata de `language-switch 16/16`.
- Cada `h2` es **una oración declarativa con punto final**. Ninguna usa "you".
- Cero adjetivos de elogio: nada de *powerful*, *seamless*, *enterprise-grade*.
- Todo número lleva su fuente en la misma pantalla.

## 3. Alineación

- **Hero: centrado.** Es su firma, y no se repite en ningún lado.
- **Secciones 1-5: alineadas al riel izquierdo**, dentro de `--wide: 1140px`.
  El eyebrow, el h2 y el párrafo cuelgan del mismo borde izquierdo en las cinco.
  La repetición del riel es lo que da calma.
- **Footer: centrado.** Cierra el paréntesis que abrió el hero.

## 4. Componentes

### 4.1 `.card` — hairline + hundido
`border: 1px solid var(--line)`, `border-radius: var(--r-xl)`,
`background: var(--sunken)`. **Nunca sombra.** Hundido, no flotando: se lee
como parte de la página, no como widget.

### 4.2 `.term` — el bloque de terminal
Barra superior de una línea con hairline abajo y un label mono a la izquierda
(`claude code`, `codex`). **Sin semáforo, sin botones falsos.** Debajo, `<pre>`
mono con la salida real. El `⛔` y la línea de la regla en `--block`.

La barra existe por una razón y solo por esa: sin el label el lector asume que
el bloqueo pasa en una app de Warden, y el argumento más fuerte de la página
—que pasa *adentro de Claude Code*— se pierde en silencio.

### 4.3 `.receipt` — el recibo en mono (componente nuevo y el que sostiene todo)
Línea al pie de una sección: `--mono`, `--fs-1`, `--faint`, separadores `·`.
Es donde vive la evidencia que el manager no lee y el técnico busca. Aparece en
§3, §4 y §5.

### 4.4 `.steps` — la lista numerada de §2
Numeral en un cuadrado de hairline, título en sans, metadato en mono a la
derecha. Sin iconos.

### 4.5 `.tbl` — la tabla de números
`--r-xl`, hairline, header en `--fs-1` uppercase con `--ls-label`, celdas mono.
Se lee como *un* objeto, no como once filas.

### 4.6 `.dl` — los dos instaladores
Ya existe en `styles.css`. Se conserva.

### 4.7 `.sec-head` — eyebrow + h2 + lead
Ya existe. Se conserva y se le impone el riel izquierdo.

## 5. Secciones

### Hero — cambia solo el texto

```
h1:  Asking a model to follow your rules is not the same as enforcing them.
sub: Warden checks every prompt against your rules before a model sees it.
```

- `max-width` del h1: **15ch → 20ch**. `--fs-9` sin tocar.
- CTA sin cambios: `Download for macOS · 185 MB` primario, `Also on Windows`,
  `Source`. El `.dmg` se queda arriba: es el camino del manager.
- La gate line, el prompt que se tipea y el veredicto: sin cambios.

### §1 — `#block`

```
eyebrow: What an employee sees
h2:      A refusal they can act on.
```

Dos objetos, uno arriba del otro, unidos por el `rule id`:

1. **La regla, como la escribió el admin** (`.card`): texto plano, en sans,
   lenguaje natural. Header de la card: `r-payroll` en mono. Esto es lo único
   en toda la página donde el manager se ve a sí mismo usando el producto.
2. **El bloqueo, como lo ve el empleado** (`.term`, label `claude code`): la
   salida literal del README — `⛔ Blocked by Warden`, la regla, *What to do
   instead*, los dos ejemplos que sí pasan (**en español**), el `--rewrite`, y
   el `Audit a7f3c2`.

El prompt de arriba del bloque va en español: `> pasame el sueldo de Ana para
el reporte`.

**Acá va la única luz fuera del hero**: `--beam` recorre el borde superior del
`.term` una vez, cuando entra en viewport. El lector aprendió en el hero que la
luz significa *la puerta acaba de decidir*; 800px más abajo ya sabe leerla.

### §2 — `#how`

```
eyebrow: How it works
h2:      It runs before the prompt leaves the machine.
```

`.steps`, cuatro pasos:

1. The employee presses Enter in Claude Code or Codex.
2. The tool's own `UserPromptSubmit` hook fires — on their machine, before
   anything is sent.
3. Warden judges the prompt against the ratified rules.
4. Allowed, it continues. Blocked, the model never receives it.

Debajo, una sola oración, que es el argumento comercial más fuerte de la página:

> A Claude Max or ChatGPT Plus session authenticates over OAuth against a fixed
> endpoint. There is no base URL to redirect. The hook does not care — it runs
> first.

`.receipt`: `UserPromptSubmit · integrations/warden-hook.mjs`

**Decidido en ronda 2:** los hooks se presentan como feature terminada, sin chip
de estado. Registrado, no reabierto.

### §3 — `#local`

```
eyebrow: Where everything runs
h2:      The record of a decision does not contain the prompt.
```

Prosa, dos oraciones:

> Every model runs on the machine, through QVAC. The audit log is append-only
> and hash-chained, and it stores the hash of a prompt, not the prompt —
> altering a past decision breaks every hash after it.

No argumenta "no mandamos tus datos", que la página no puede probar. Argumenta
que el registro de gobernanza no puede convertirse en la mayor fuga del sistema,
porque no contiene los datos. Es la objeción de legal/CISO contestada antes de
que exista.

`.receipt`: `Qwen3-1.7B-Instruct Q4_0 · EmbeddingGemma-300M Q8_0 · OCR_LATIN ·
llama.cpp via @qvac/sdk · pnpm run verify-audit`

### §4 — `#numbers`

```
eyebrow: Measured, not claimed
h2:      136 of 160 attacks stopped. The baseline stopped none.
```

`.tbl` con **las 11 clases completas**, sin curar — incluidas
`guard-targeted 50%` y `volume-distraction 25%`. Recortarla obliga a elegir, y
cualquier recorte que esconda las dos malas hace que un evaluador desconfíe de
las nueve buenas.

| Class | Stopped |
|---|---|
| multi-turn-escalation | 16/16 |
| language-switch | 16/16 |
| paraphrase-evasion | 16/16 |
| document-borne | 8/8 |
| direct-override | 15/16 |
| authority-spoofing | 14/16 |
| roleplay-fiction | 14/16 |
| obfuscation | 14/16 |
| hypothetical-testing | 13/16 |
| guard-targeted | 8/16 |
| volume-distraction | 2/8 |

**Sin columna de latencia.** Decidido: irrelevante para esta audiencia.

`.receipt` al pie, y acá vive el 58%:

```
REPORT.md · commit 040f4e4 · Intel Xeon 2.1GHz x4, 17 GB, no GPU ·
21 of 36 legitimate requests were also refused; --rewrite exists for that.
```

En mono, `--fs-1`, `--faint`. El manager no lo procesa. El técnico sí, y lo iba
a encontrar igual en el `REPORT.md` que linkeamos en el footer — encontrarlo ahí
después de no verlo acá es peor que verlo en gris.

### §5 — `#get`

```
eyebrow: Get Warden
h2:      Install it on one machine, or on everyone's.
```

Una oración que **respalda el h2**, porque "on everyone's" promete despliegue y
la ley #5 exige recibo:

> Same installer either way. There is no server to provision and no account to
> create.

`.dl`, dos tarjetas: macOS `.dmg` 185 MB · Windows `.exe` 273 MB.

`.receipt` al pie, para el técnico:
`git clone github.com/Wardenlabs/warden · pnpm install · pnpm run setup · pnpm run dev`

### Footer — centrado

`Apache-2.0 · GitHub · REPORT.md · BENCHMARKS.md · 040f4e4`

Los dos reportes crudos no son decorativos: son lo que hace verificable a §4.
El hash del commit son 7 caracteres y es la firma de que los números no son
inventados.

### Header

Sin cambios estructurales. Anchors: `How it works` → `#how`, `Numbers` →
`#numbers`, `GitHub`, y `Download`. Cinco anchors en un header que quiere ser
silencioso serían ruido.

## 6. Motion

Misma ley que el hero: **todo apagado bajo `prefers-reduced-motion`.**

- Reveal-on-scroll en las secciones (`[data-reveal]`, ya existe).
- El `--beam` del `.term` de §1: recorre el borde superior **una vez**, al
  entrar en viewport. No loopea.
- **No hay count-up.** El count-up existía para una página que ya no es esta, y
  un número que se anima compite con la tabla que está al lado. Ley #6.

## 7. `styles.css` — qué se borra

Auditar uso real antes de borrar, pero el objetivo es dejar el archivo sin una
sola clase huérfana. Candidatos, todos de la página vieja:

`.strip` · `.versus` (+`.win`/`.baseline`/`.who`/`.n`/`.cap`/`.versus-note`) ·
`.ui` / `.ui-lit` / `.ui-chrome` / `.ui-body` / `.ui-split` / `.ui-list` /
`.ui-item` / `.ui-foot` · `.avatar` · `.kv` · `.pill` · `.hashes` · `.candid` ·
`.rows` / `.row` · `.feat` / `.feat-copy` · `.verdict-head` / `.verdict-rule` ·
`.hero-surface` · `.two`

Se conservan y se usan: `.wrap`, `.sec-head`, `.label`, `.btn*`, `.chip*`,
`.dot`, `.term`, `.steps`, `.tbl`, `.dl`, `.cmd`, `.foot`, `.stack`.

Tokens: `:root` no necesita nada nuevo. `--beam` ya existe y ahora tiene un solo
uso, que es el que describe su comentario.

## 8. Fuera de alcance

Sin strip de logos. Sin testimonios. Sin pricing. Sin sección versus. Sin
mockups de la consola dibujados en CSS. Sin light theme. Sin i18n. Sin demo
interactivo en el browser — el modelo corre on-device y cualquier demo web sería
un fake, que es lo contrario de la tesis de la página.

## 9. Sin build step

Se mantiene: `index.html` + `styles.css` + `app.js` + `light.js`, sin bundler,
sin install. `pnpm dlx serve landing` sigue siendo la forma de verlo.
