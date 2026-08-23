# Feedback — leído el código, no el README

Revisión externa del estado del repo. `STATUS.md` ya cubre los dos problemas
abiertos (latencia y falsos positivos); esto es lo que encontré **además** de
eso, leyendo el código contra los artefactos que se entregan.

Ordenado por lo que rompe la entrega primero.

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

### 3. La cola de escalación no existe, pero el producto la promete

`src/server/index.ts:325-326`:

```js
app.get('/api/escalations', (_req, res) => res.json([]));
app.post('/api/escalations/:id', (req, res) => res.json({ id: req.params.id, ok: true }));
```

Dos stubs. No hay store, no hay pestaña en la consola, el admin no puede
aprobar nada. Mientras tanto:

- `aggregate.ts` le dice al empleado *"Held for an administrator to review — you
  have not been refused, just queued."*
- `warden-hook.mjs:172` imprime *"Queued for an administrator."*
- `openai.ts:104` devuelve `202` con un `escalationId`.

Tres superficies prometiendo una cola que no recibe nada. Hoy `ESCALATE` es un
`BLOCK` con mejor redacción, y `ESCALATE` es **21 de los 98 prompts** del corpus
— más de un quinto del corpus mide un camino que termina en un array vacío.

Bajo la regla de honestidad del propio repo ("nada va al README hasta que se lo
vio funcionar"), esto está del lado equivocado.

---

## P1 — un campo muerto en el modelo de política

**`Rule.scope` no lo lee nadie.**

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

### 2. Cola de escalación de verdad

~150 líneas, riesgo cero sobre el guard (es post-decisión), y es la mejor escena
del video: el empleado manda algo, le dice "queda en revisión", el admin lo ve
aparecer en la consola por SSE — que ya existe — lo aprueba, el empleado sigue.

Convierte `ESCALATE` de "block con mejor tono" en el diferencial del producto, y
saca la promesa falsa del punto 3 de arriba.

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
