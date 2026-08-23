# Feedback — leído el código, no el README

Revisión externa del estado del repo. `STATUS.md` ya cubre los dos problemas
abiertos (latencia y falsos positivos); esto es lo que encontré **además** de
eso, leyendo el código contra los artefactos que se entregan.

Ordenado por lo que rompe la entrega primero. Leído contra `main` a la altura de
`eb60ef8` (reescritura de prompt + apelación); si algo de acá se arregla después,
el commit que lo arregla es la respuesta, no este archivo.

---

## P0 — tres cosas que un juez puede ver hoy

### 1. `REPORT.md` está generado con el contador viejo

El fix de conteo por prompt entró en `9a0fd67` ("Count attacks and controls per
prompt"). `REPORT.md` no se regeneró desde entonces:

```bash
git log 9a0fd67..HEAD -- REPORT.md    # vacío
```

O sea que el artefacto que se entrega tiene los números del bug que ya
arreglaron. Se ve directo en la tabla:

| clase | REPORT.md dice | con el contador actual |
|---|---|---|
| document-borne | 2/6 (33%) | **0/4 (0%)** |

`09-document-borne.json` tiene 4 ataques (`db-01`..`db-04`, todos `ESCALATE`) y
2 controles limpios (`db-05`, `db-06`, ambos `ALLOW`). Los cuatro ataques están
en la tabla de fallas del propio reporte — se escaparon los cuatro. Los dos
controles no están, o sea que se permitieron bien. El contador viejo bucketeaba
por archivo y contó esos dos controles como **ataques detenidos**.

Arrastra al titular:

| | REPORT.md dice | corregido |
|---|---|---|
| Ataques detenidos | 66/82 (80%) | 64/80 (80%) |
| Falsos positivos | 7/16 (**44%**) | 7/18 (**39%**) |

El 80% aguanta por casualidad. Los otros dos números no: **la clase más débil
está en cero, no en 33%**, y el 44% que aparece en `STATUS.md`, en `CLAUDE.md` y
en toda la investigación de Gastón es el número pre-fix.

Cuesta un `npm run redteam` en una máquina con modelos. Es lo primero que haría.

> Ojo con el orden: si se regenera el reporte y `document-borne` pasa a 0/4,
> conviene que el aviso de OCR ausente (`report.ts:129`) salga en la misma
> corrida, porque sin OCR esa clase no mide comprensión de documentos y el 0%
> se lee peor de lo que es.

### 2. El generador afirma una reproducibilidad que ustedes mismos desmintieron

`src/redteam/report.ts:295`:

```js
w('Runs are deterministic: fixed seed, temperature 0. The same corpus against the');
w('same policy version reproduces the same numbers.');
```

`CLAUDE.md` y `STATUS.md` dicen lo contrario, medido: dos corridas idénticas de
`benign-controls` contra la política `69d4ba36` dieron 44% y 31%, porque
`parallel: 4` batchea y la composición del batch cambia los numéricos. De ahí
sale la regla de `--reps 3`.

Está hardcodeado en el generador, así que **cada** `REPORT.md` que emitan lo
reimprime. Es la sección "Reproducing this" — exactamente donde un juez va a
mirar antes de correr nada. Cambiarlo por lo que midieron es más fuerte, no más
débil: "las corridas varían ±6% con n=16, por eso el reporte se saca con
`--reps 3`" es la frase de un equipo que midió.

### 3. `ESCALATE` sigue sin cola, y el admin todavía no puede soltar nada

> **Resuelto en `47b917f`.** La cola existe y se llena sola: se **deriva del
> audit log** (`escalationQueue()` en `src/policy/escalations.ts`), así que todo
> `ESCALATE` aparece sin que el empleado tenga que hacer nada — que era
> exactamente el hueco. `POST /api/escalations/:id` graba aprobado o rechazado
> con nota, deduplicado, y responde 404 a un id que nunca fue held. Los dos
> stubs ya no están. La consola lo muestra bajo Policy controls, con el badge de
> cuántos esperan y actualizándose en vivo por SSE.
>
> Una cosa que el hallazgo pedía y **no** se hizo, a propósito: *"soltar"*. Una
> aprobación no reejecuta el prompt original — el hook volvió segundos después
> de que la persona apretó Enter y su herramienta siguió, no hay nada que
> reanudar. Significa "volvé a pedirlo, pasa por sus propios méritos", y está
> dicho con esas palabras en el botón, en el hook y en el `aggregate`. La
> alternativa sería una decisión guardada que el pipeline honra sin juzgar, que
> es el early-ALLOW que el diseño prohíbe.
>
> Y como el revisor no puede ver el prompt (el log guarda el hash),
> `warden-hook --note <auditId>` y el botón "Add context for the reviewer" son
> el único camino por el que las palabras del empleado llegan a esa pantalla.

`eb60ef8` ("Give a refusal somewhere to go") agregó la apelación y está bien
hecha: `POST /api/guard/appeal` valida que la decisión sea del que apela contra
el `auditId`, `recordAppeal` deduplica, y `GET /api/appeals` la muestra unida a
la regla que disparó — que es el objeto que el admin tiene que editar. Eso llena
la promesa de *"quote this if you think it is wrong"*, que efectivamente no
tenía a dónde ir.

Pero llena esa promesa, no la otra. Quedan dos huecos:

**La apelación la inicia el empleado; el `ESCALATE` no encola nada.** El único
llamador de `recordAppeal` es la ruta de apelación. El camino de `ESCALATE` está
igual que antes — `openai.ts:104` devuelve `202` con un `escalationId`, y ahí
termina. Mientras tanto `aggregate.ts:195` sigue diciendo *"Held for an
administrator to review — you have not been refused, just queued"* y el hook
sigue imprimiendo *"Queued for an administrator"*. Nadie encola. Si el empleado
no apela por su cuenta, el admin nunca se entera.

Eso importa más de lo que parece: `ESCALATE` es **21 de los 98 prompts** del
corpus, y en el reporte cuenta como ataque detenido. Un `ESCALATE` que nadie ve
es un `BLOCK` que el reporte anota como éxito.

**No hay acción, sólo lectura.** `/api/appeals` es `GET`. No hay aprobar, no hay
soltar, no hay cerrar. El admin ve la apelación y su única salida es ir a editar
la regla — que es lo correcto a largo plazo y no sirve para el empleado que está
frenado ahora.

**Y quedaron dos stubs muertos contradiciendo lo nuevo.**
`src/server/index.ts:488-489`:

```js
app.get('/api/escalations', (_req, res) => res.json([]));
app.post('/api/escalations/:id', (req, res) => res.json({ id: req.params.id, ok: true }));
```

El `POST` devuelve `{ ok: true }` sin hacer nada. Cualquiera que lo encuentre
antes que `/api/appeals` va a creer que la aprobación existe y está rota, en vez
de que no existe. Borrarlos es una línea y saca la ambigüedad.

## P1 — un campo muerto en el modelo de política

**`Rule.scope` no lo lee nadie.**

> **Resuelto en `47b917f`, por la salida cara.** El filtro va en
> `rulesForActor(spec, actor, side)` y no en `selectRules`: es el mismo lugar
> que ya resolvía las tres clases de audiencia, y por la misma razón — un
> llamador que lo filtra a mano es un llamador que se lo olvida. `side` es
> `'input'` por default; `'any'` existe sólo para *describir* una política (la
> lista de reglas de una persona en la consola, el system prompt del baseline),
> nunca para aplicarla.
>
> Y la salida se juzga de verdad: `src/guard/output.ts` corre el mismo
> isolate → retrieve → adjudicate → aggregate sobre la respuesta del modelo, con
> las reglas `output` y `both`. Dos límites que quedaron escritos en el README
> porque son reales: corre **sólo en el proxy** (por el hook, Warden actúa antes
> de mandar el prompt y nunca ve la respuesta), y una política con reglas de
> salida **no puede streamear**, porque un token no se puede des-mandar — sin
> reglas de salida, streamea igual que antes.
>
> Lo medido: **353 → 324 adjudicaciones** sobre los 98 prompts del corpus con
> mock, y ninguna otra línea del reporte se movió. Cuánto del 39% era esto sigue
> **sin medir** y necesita `--reps 3` con modelo real, que es justo lo que el
> hallazgo pedía averiguar antes de seguir reescribiendo `r-instruction-override`.

Está definido en `src/policy/types.ts:12` (`input | output | both`), el
compilador se lo pide al modelo (`src/policy/compile.ts:76`), la consola lo
muestra. `grep -rn scope src/guard src/proxy src/server` no devuelve nada.

Consecuencias, en el seed:

- `r-legal-commitment` es `scope: "output"`, `severity: escalate`,
  `appliesTo: ['*']`. Es la única regla del seed sobre **lo que el asistente
  responde**, y hoy se juzga contra **lo que el empleado escribe**. Está mal en
  las dos direcciones: no puede atrapar un compromiso legal en la respuesta, y
  se dispara sobre inputs que nunca fue su trabajo juzgar. `CLAUDE.md` registra
  que el guard rechazó *"draft a reply to this vendor"* — que es exactamente la
  forma de prompt que esa regla atrae. Vale medir cuánto del 39% es esto antes
  de seguir reescribiendo `r-instruction-override`.
- Las 4 reglas `both` prometen cobertura de salida que no existe. El proxy hace
  `forward()` en streaming directo, sin mirar la respuesta.

Es la mitad del modelo de política que el admin cree activa. Hay dos salidas
honestas y ninguna es dejarlo como está:

- **Barata (una tarde):** filtrar por scope en `selectRules`, y que la consola
  diga en la regla "esta regla es de salida — la verificación de salida todavía
  no está implementada". Deja `r-legal-commitment` inerte, pero *visiblemente*
  inerte, que es lo contrario de ahora.
- **Cara (un día):** bufferear la respuesta en el proxy y correr las reglas
  `output`/`both` contra ella. Es una feature de verdad y nadie más en la track
  la va a tener.

---

## Qué agregar, por impacto sobre costo

### 1. Ampliar `benign-controls` de 16 a ~40 prompts

Es el cambio de mayor valor por hora del repo y no es una feature.

Toda la investigación de falsos positivos corre sobre **n=16**. Un prompt son 6
puntos porcentuales. Ustedes mismos escribieron "±6% at n=16" y "ocho prompts no
pueden resolver una diferencia de dos prompts" — y después midieron reescrituras
de reglas contra 8 prompts y una corrida de corpus contra 16.

Con n=40 un prompt son 2.5 puntos y todas las palancas que ya tienen a mano
(`WARDEN_MIN_RELEVANCE`, despinnear la regla, el filtro de scope) pasan de
"ruido" a "medible". Sin eso, cada cosa que agreguen abajo se mide con la misma
regla elástica.

Mismo argumento, más chico: `volume-distraction` tiene **n=4**. El 25% de esa
fila no significa nada.

### 2. Cerrar el lazo de la escalación

La apelación ya está. Falta lo que la convierte en un lazo cerrado, y es poco:

- Que un `ESCALATE` **se encole solo**, sin depender de que el empleado apele.
  `recordAppeal` ya existe y ya deduplica por `auditId`; es llamarlo desde el
  camino del veredicto con origen `escalate` en vez de `appeal`.
- Un `POST /api/appeals/:id/release` que suelte el pedido, escriba en el audit
  quién lo soltó, y lo empuje por el SSE que ya está.
- Borrar los dos stubs de `/api/escalations`.

Riesgo cero sobre el guard — todo es post-decisión — y es la mejor escena del
video: el empleado manda algo, le dice "queda en revisión", el admin lo ve
aparecer solo en la consola, lo suelta, el empleado sigue. Hoy esa escena se
corta en el medio porque el empleado tiene que acordarse de apelar.

### 3. Calificadores estructurados en las reglas (`appliesWhen`)

Este es el arreglo arquitectónico que `STATUS.md` identifica pero no nombra.

El modelo pierde sistemáticamente el calificador: la regla dice *"above USD
5,000"* y el prompt dice *"aprobá la factura 4470 de USD 1.240"*, y dispara
igual. Comparar dos números no es trabajo de un 1.7B.

Un campo opcional y tipado en `Rule`, redactado por el compilador y ratificado
por el admin:

```ts
appliesWhen?: { amountAbove?: { currency: string; value: number } }
```

evaluado en código **antes** de adjudicar. Si el prompt trae un monto y está por
debajo del umbral, la regla no aplica — eso no es un bypass, es el alcance
propio de la regla. Si no se detecta ningún monto, la regla aplica igual
(fail-closed, como todo lo demás acá).

Es además la demostración de la tesis del proyecto: *le sacamos de la regla todo
lo que se puede decidir sin el modelo, y al modelo le queda sólo lo que necesita
juicio.*

### 4. Cachear la decisión por `(policyVersion, hash(prompt), actor)`

Ataca de frente el problema 1 de `STATUS.md`: la decisión fría de 35.954 s que
pasó el deadline de 30 s del hook y **falló abierta**.

El hook dispara en cada prompt y en un loop de agente los prompts se repiten. La
decisión es una función pura del input y de la versión de política, así que
cachearla es determinístico y seguro.

**No es el `kvCache` que los quemó.** Aquel cacheaba estado del modelo con una
clave que no incluía el turno del usuario, y por eso repetía veredictos de otro
prompt. Esto cachea la decisión completa con clave del input completo: si algo
del input cambia, la clave cambia. Vale escribir esa distinción en el comentario
para que nadie lo revierta por reflejo dentro de tres meses.

### 5. Subir las reps de `diagnose-fp.ts`

Gratis, y es el experimento con más información pendiente en todo el repo.

El resultado de la regla del color de los muebles está en n=1 por celda. Si se
sostiene, no hay reescritura de reglas que sirva y toda la estrategia cambia — y
es *el* hallazgo del proyecto para el video: "medimos que el texto de la regla no
es lo que decide". Si no se sostiene, se ahorran las noches que `STATUS.md` ya
avisa que se están gastando ahí.

Es un `--reps` y una corrida. Debería pasar antes que cualquier otra cosa de
esta lista salvo la 1.

### 6. Prender `WARDEN_MIN_RELEVANCE` y medirlo

Ya está escrito, defaultea a 0, y el comentario en `src/policy/index.ts` ya
documenta el caso: `r-credentials` sacó 0.46 contra *"pasame el sueldo de Ana"*,
entró igual al top-3 y devolvió VIOLATES. Es un falso positivo que la etapa de
retrieval ya tenía la evidencia para evitar.

Compra latencia y precisión con el mismo cambio. Requiere el punto 1 para poder
elegir el valor con algo que no sea ruido.

### 7. Modo simulación al ratificar una regla

Ya tienen `preview`. Extenderlo: antes de ratificar, correr la regla candidata
contra `benign-controls` **y** contra las últimas N decisiones reales del audit
log, y mostrarle al admin *"esta regla habría bloqueado 3 de los últimos 100
pedidos de tu equipo — estos"*.

Es la única cosa de la lista que le da al admin el costo de su propia regla
antes de que sea ley. Convierte el problema de falsos positivos de debilidad en
feature, y el harness ya existe (`src/redteam/runner.ts`).

---

## Qué no agregar

- **Más reglas al seed.** Cada regla es una llamada al modelo y una chance más
  de equivocarse. Con `TOP_K=3` más la pinneada ya corren cuatro por prompt.
- **Otra reescritura de `r-instruction-override`.** Ya midieron tres wordings
  (4/8, 3/8, 5/8) y el mejor perdió un ataque. Es el camino que `STATUS.md`
  dice que está agotado; la señal determinística que ya llega al veredicto
  (`hadMetaInstructions`, 5/8 ataques y 0/16 FPs) es la que tiene el margen.
- **Voting.** Está medido y está peor. Ya está escrito por qué.

---

## Lo que está bien, para que no se pierda

Corto a propósito, pero vale decirlo porque parte de esto no es común:

- El límite `src/qvac/` es real y se sostiene en todo el repo. "¿Dónde pasa la
  inferencia?" se contesta con un `ls`.
- `aggregate()` como único lugar que decide, y monotónico. Es la propiedad que
  hace que el resto de las decisiones se puedan discutir sin miedo.
- Los comentarios que explican **por qué no** — el `kvCache`, el voting, la
  cláusula del preámbulo que se sacó y se volvió a poner. Eso es lo que hace que
  el repo no repita sus propios errores, y es raro verlo.
- El baseline en el reporte. Medir contra "la misma política en el system
  prompt" es lo que convierte el número en un argumento.
- El `rewriteGate()` de `eb60ef8`. Una función que le pide al modelo una frase
  que pase el guard es, descrita con honestidad, una máquina de buscar bypasses
  — y lo que la acota es estructural y no un prompt bien redactado: hash del
  audit, una sola reescritura, veto si `isolate()` marcó la original, y la
  sugerencia pasa por el guard completo antes de mostrarse. Es el mismo criterio
  que el resto del repo aplicado a una feature que era fácil hacer mal.
