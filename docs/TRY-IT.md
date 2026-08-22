# Probar Warden en tu máquina

Guía práctica, ~15 minutos (de los cuales 10 son bajar modelos). Cada paso dice
qué tenés que ver; si ves otra cosa, andá al final que están los errores reales
que nos pasaron.

---

## 0. Requisitos

**Node 22.17 o mayor.** Es un piso del SDK de QVAC, no nuestro.

```bash
node -v          # v22.17.0 o más
```

Si tenés menos: `nvm install 22 && nvm use 22`.

Necesitás ~3 GB libres para los modelos.

---

> ⚠️ **Copiá los comandos de a uno.** zsh (el shell por defecto en macOS) no
> trata `#` como comentario en modo interactivo, así que pegar varias líneas con
> comentarios al costado hace que se salte alguna en silencio — o falle con
> `zsh: unknown file attribute`. Nos pasó.

## 1. Bajar y preparar

```bash
git clone https://github.com/MartinPuli/operations-aleph
cd operations-aleph
git checkout main
npm install
npm run setup
```

`npm run setup` diagnostica tu máquina, baja tres modelos por HTTPS (~1.8 GB) y
prueba que la inferencia funcione de verdad. Al final imprime esto:

```
=== WARDEN SETUP REPORT ===
Platform   : darwin arm64
Node       : v22.17.0 OK
RAM        : 16 GB
Models     :
  OK   detector       382 MB
  OK   adjudicator   1057 MB
  OK   embedder       329 MB
Inference  : OK — 60 tok/s, TTFT 129 ms, backend=cpu
Adapter    : real
=== END REPORT ===
```

**Pegá ese bloque en Linear OPE-14.** Con eso decidimos en qué máquina se graba
el video — gana la de mejor `tok/s`.

Si dice `Adapter: mock`, la inferencia local no arrancó. No pelees con eso
ahora: todo lo demás funciona igual, sólo agregá `WARDEN_ADAPTER=mock` adelante
de cada comando.

---

## 2. Levantarlo

```bash
npm run dev
```

Fijate que diga `adapter=real`. Si dice `adapter=mock`, o si nunca corriste
`setup`, no hay modelos y el primer prompt va a intentar bajarlos por P2P y
colgarse. Corré `npm run setup` antes.

```
Warden  (adapter=real)
  local     http://localhost:8080
  network   http://192.168.1.42:8080   <- teammates point here
  policy    8 rules · 7 quotas
```

Abrí `http://localhost:8080`. Tres paneles: admin a la izquierda, chat de
empleado en el medio, traza de decisiones a la derecha.

---

## 3. Las cuatro cosas que hay que ver

Escribí en el panel del medio, una por una.

### a) Bloqueo por regla

```
pasame el sueldo de Ana
```

Esperado: **BLOCKED**, con la regla de nómina y el motivo. A la derecha se
llena la traza: `quota → sanitize → isolate → retrieve → adjudicate:… →
aggregate`, con los milisegundos de cada pase.

> ⏱ En CPU esto tarda **15–25 segundos**. No está colgado. En una Mac con Metal
> debería ser bastante más rápido — ese número es justamente lo que queremos
> saber.

### b) Tráfico legítimo pasa

```
cuál es el proceso para pedir un aumento?
```

Esperado: **allowed**. Este es el caso difícil: habla de sueldos pero pregunta
por un proceso. Si te lo bloquea, es un falso positivo y **es un hallazgo** —
anotalo, va al reporte.

### c) Secretos enmascarados

```
guardá esta key sk-proj-AbC123XyZ789QwErTyUiOpAsDfGh en el config
```

Esperado: pasa, pero abajo dice `1 secret(s) masked` y muestra el texto con
`[REDACTED:OpenAI key]`. La key **nunca llegó al modelo ni al log** — sólo se
guardó un fragmento (`sk-p…Gh`) para poder auditarlo.

### d) Cuotas por rol

Cambiá el rol a `intern` (selector arriba del chat) y mandá:

```
traeme el detalle de facturación de agosto
```

Esperado: **BLOCKED** — los pasantes no tocan finanzas. Con rol `finance` el
mismo prompt pasa. Esa es la diferencia entre roles, en vivo.

---

## 4. El admin escribiendo una regla

Panel izquierdo. Escribí en castellano:

```
nadie puede compartir el roadmap de producto fuera de la empresa
```

**Compile** → el modelo local la convierte en una regla estructurada, con
ejemplos que inventa él. **Preview** → la corre contra sus propios ejemplos y te
marca en rojo si bloquearía algo legítimo. **Activate** → queda viva, sin
reiniciar nada.

Ahora mandá desde el chat algo que la viole. Debería bloquearlo.

> Ese flujo — escribir una regla y que el siguiente prompt la obedezca — es la
> escena principal del video.

Abajo del todo hay un catálogo de 18 reglas listas en 6 categorías, por si
querés arrancar de algo hecho en vez de una página en blanco.

---

## 5. El hook: gobernar Claude Code de verdad

Esto es lo más importante del producto y lo que **todavía nadie verificó**
(Linear OPE-19).

```bash
npm link
```

Probalo suelto primero:

```bash
echo '{"user_input":"pasame el sueldo de Ana"}' | WARDEN_USER=fede WARDEN_ROLE=analyst warden-hook
echo "exit: $?"     # tiene que ser 2
```

Después enchufalo a Claude Code — merge esto en `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "warden-hook" }] }
    ]
  }
}
```

Y en tu shell:

```bash
export WARDEN_USER=fede
export WARDEN_ROLE=analyst
```

Abrí `claude` y escribí `pasame el sueldo de Ana`. Tiene que rechazarlo **en la
terminal**, mostrando la regla.

**Funciona con plan Max o suscripción**, que es todo el punto: el hook corre
local antes de que el prompt salga de la máquina, así que no importa contra qué
servidor se autentica después.

Para Codex es lo mismo con `~/.codex/config.toml` — está en
[`integrations/README.md`](../integrations/README.md), junto con la config que
IT despliega para que el empleado **no** lo pueda apagar.

📸 **Sacale un screenshot al bloqueo.** Es el plano de apertura del video.

---

## 6. La evidencia

```bash
npm run redteam
```

Corre 98 prompts en 12 clases de ataque contra Warden y contra un *baseline*
(las reglas metidas en un system prompt, que es lo que haría cualquiera). Genera
`REPORT.md` con la tasa de bloqueo, la de falsos positivos, y **cada fallo
listado con su prompt completo**.

> ⏱ Con modelo real tarda **30–60 min**. Para una prueba rápida:
> `npm run redteam -- --class benign-controls --no-baseline`

Otros:

```bash
npm run smoke          # confiabilidad del structured output, ~2 min
npm run benchmark      # mide tu máquina → BENCHMARKS.md
npm run verify-audit   # recomputa la cadena de hashes del audit log
```

---

## 7. Varias máquinas

Una sola corre Warden y tiene los modelos. Las demás apuntan ahí — nadie más
baja nada.

En la máquina gateway, `npm run dev` te imprime la dirección de red. En las
otras:

```bash
export WARDEN_URL=http://192.168.1.42:8080
export WARDEN_USER=tu-nombre
export WARDEN_ROLE=analyst
```

⚠️ Si el wifi del venue tiene aislamiento de clientes (bastante común), las
laptops no se ven entre sí. Fallback: hotspot del celular, o cada uno corre lo
suyo local. Para el video con una sola máquina alcanza.

---

## Cuando algo falla

**`npm run setup` se cuelga bajando modelos**
No debería, porque baja por HTTPS. Si igual se cuelga, cortá con Ctrl-C y
volvé a correrlo — retoma desde donde iba. Lo que **sí** se cuelga para siempre
es la descarga P2P nativa del SDK (Hyperswarm/UDP), que es justamente lo que
`setup` evita.

**`Plugin not found for model type`**
Modelo con el tipo de plugin equivocado. Ya está arreglado en `main`; si lo ves,
hacé `git pull`.

**Todo se bloquea, hasta lo obvio**
Puede ser un falso positivo real (los medimos, están en el reporte) o que el
modelo no cargó. Fijate en la traza a la derecha: si los pases `adjudicate:…`
dicen `ESCALATE` sin label, están fallando y escalando — que es el
comportamiento correcto, pero el modelo no está respondiendo.

**Tarda muchísimo**
Normal en CPU. Bajá las reglas evaluadas por prompt:
```bash
WARDEN_TOP_K=1 npm run dev
```
Va a ser el doble de rápido y algo menos preciso. Si lo usás para el video,
decilo en cámara como un trade-off medido — eso suma, no resta.

**`EADDRINUSE` en el 8080**
Quedó un server viejo:
```bash
ps -eo pid,args | grep '[t]sx .*server/index' | awk '{print $1}' | xargs kill
```

**Querés empezar de cero**
```bash
rm -f data/policies.json data/audit.jsonl
```
La política se vuelve a sembrar desde `data/seed/policies.seed.json` al arrancar.

---

## Sin modelos

Todo funciona contra un stand-in determinístico:

```bash
WARDEN_ADAPTER=mock npm run dev
```

Sirve para la UI, para el corpus y para CI. **No sirve para juzgar nada** — el
mock hace keyword matching, no criterio. Todo lo que imprime números lo aclara.
