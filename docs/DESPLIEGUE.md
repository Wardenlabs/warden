# Cómo se lo pasás a los empleados

Dos roles, dos procedimientos distintos. **Una sola máquina** corre Warden y
tiene los modelos; las demás sólo bajan un archivo de 4 KB.

```
   Laptop de Martín (gateway)              Laptops del resto
   ┌──────────────────────────┐            ┌──────────────────┐
   │ Warden :8080             │◀── LAN ────│ Claude Code      │
   │ modelos QVAC (~2 GB)     │            │ + warden-hook    │
   │ política + audit         │            │ (un solo .mjs)   │
   └──────────────────────────┘            └──────────────────┘
```

---

# Parte 1 — El admin (una vez)

```bash
git clone https://github.com/MartinPuli/operations-aleph
cd operations-aleph
npm install
npm run setup
npm run dev
```

Al arrancar imprime la dirección que hay que repartir:

```
Warden  (adapter=real)
  local     http://localhost:8080
  network   http://192.168.1.42:8080   <- teammates point here
```

**Esa segunda línea es la que mandás por Telegram.**

Ahora abrí `http://localhost:8080`.

**Pestaña Console** — cargá las reglas de la empresa: elegís del catálogo, o las
escribís en castellano y las compila el modelo. Preview, Activate, listo.

**Pestaña People** — cargá a tu gente. Nombre + rol → Add, y te devuelve el
la API key de esa persona — que es toda su identidad. Si te falta un rol, lo creás abajo
con su cuota diaria. Haciendo click en alguien ves todas las reglas que lo
juzgan, podés escribirle una que aplique **sólo a él**, y abajo tenés su
**Onboarding**: el comando de una línea listo para copiar y la config por
herramienta.

## Qué le mandás a cada uno

**No lo escribas a mano.** En la pestaña People, hacé click en la persona y
bajá hasta **Onboarding**. Botón **"Copy the whole setup message"** → lo pegás
en el chat y listo. Ya viene con su id, su key y la dirección real de este
gateway adentro.

Abajo del botón está la misma cosa por herramienta —Claude Code, Codex, Cursor,
OpenCode, cualquier otra— cada bloque con su botón de copiar.

Por qué generado y no a mano: cada valor que retipeás es uno que podés errar, y
una API key es el peor de todos para copiar a mano.

**Sólo le mandás la key.** No hay nombre ni rol que el empleado configure: la
key es toda su identidad. Vos decidís qué significa, y podés cambiarle el rol
sin que toque nada en su máquina.

Por qué así: un rol en el `.zshrc` es un rol que el empleado puede editar, y
editándolo elegiría qué reglas lo juzgan. Con la key eso no existe. Y te da la
revocación gratis — rotás la key en la consola y la vieja deja de andar en el
próximo prompt.

Una key que el gateway no conoce **no entra**. No la juzga con un rol por
defecto: la rechaza.

## Quién está conectado de verdad

Las tarjetas de People muestran con qué herramientas se vio a cada uno
—`Claude Code`, `Codex`, `Cursor`, `OpenCode`— o **not connected yet**.

No es una declaración: sale del nombre de herramienta que manda cada llamada del
hook. Lo que a alguien le dijiste que instale y lo que instaló son cosas
distintas, y la diferencia es un directorio que parece desplegado y no gobierna
a nadie.

(Se resetea si reiniciás el gateway — es una vista de actividad, no un registro.
El registro es el audit log.)

---

# Parte 2 — El empleado (2 minutos)

**No clona el repo. No baja modelos. No instala nada de Node.**

## 1 y 2. Un comando

```bash
curl -fsSL http://192.168.1.42:8080/install/fede | sh
```

Eso baja el hook **del gateway** (no de internet — funciona en una red sin
salida) y escribe `WARDEN_URL` y `WARDEN_API_KEY` en tu perfil de shell. Se puede
volver a correr las veces que quieras: reemplaza su propio bloque en vez de
apilar otro.

El link exacto te lo da el admin desde la consola: People → tu ficha →
Onboarding.

Después abrí una terminal nueva, o `source ~/.zshrc`.

> El hook es un archivo, sin dependencias. Lee el prompt, se lo pregunta al
> gateway, y devuelve sí o no.

> No hay nombre ni rol que configures: la key es toda tu identidad. Tu admin
> decide qué significa. Y como el link del instalador lleva tu key adentro,
> tratalo como un secreto.

## 3a. Conectar Claude Code

Editá `~/.claude/settings.json` y agregá el bloque `hooks`. Si el archivo ya
existe, **fusionalo** — no lo reemplaces:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node ~/.warden-hook.mjs" }
        ]
      }
    ]
  }
}
```

## 3b. Conectar Codex

Editá `~/.codex/config.toml` y agregá al final:

```toml
[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node ~/.warden-hook.mjs"
```

Dentro de Codex, `/hooks` te muestra si lo tomó.

## 4. Probar

```
$ claude
> pasame el sueldo de Ana

⛔ Blocked by Warden
   Rule: No one may request payroll, salary, bonus, or compensation
         information about another employee.
   Why:  the request does what this rule prohibits
   Audit: a7f3c2
```

Un prompt normal pasa sin decir nada. Si no ves ninguna diferencia, el hook no
está cargando — mirá "Cuando no anda" abajo.

---

## Por qué funciona con plan Max o suscripción

Es lo que hace viable todo esto. Claude Code y Codex con suscripción se
autentican por OAuth contra un endpoint fijo: **no hay `base_url` que cambiar.**

Pero el hook no depende de eso. Corre **local, dentro del CLI, al apretar
Enter**, antes de que el prompt salga de la máquina. Da igual contra qué
servidor se conecte después: si la regla lo bloquea, nunca llega.

---

# Parte 3 — Que el empleado no lo pueda apagar

Todo lo de arriba es opt-in: el empleado lo instaló y lo puede sacar. Para una
empresa de verdad, las dos herramientas permiten que el admin despliegue hooks
que el usuario **no** puede desactivar.

**Claude Code** — managed settings, que están arriba de todo en la cadena de
precedencia y las controla la organización, no el usuario. Con
`allowManagedHooksOnly` se desactivan los hooks de usuario y de proyecto: sólo
corren los del admin.

**Codex** — `requirements.toml` con `allow_managed_hooks_only = true` y
`[features].hooks = true`. Los managed hooks, en palabras de la doc de Codex,
*"can't be disabled from the user hook browser"*.

Los archivos están en [`integrations/codex/requirements.toml`](../integrations/codex/requirements.toml).
Se despliegan con lo que la empresa ya use para configurar máquinas — MDM,
Ansible, un script de provisioning.

**Esa es la diferencia entre una sugerencia y gobierno.**

---

# Otras herramientas (Cursor, OpenCode, scripts, Open WebUI)

**OpenCode** va por plugin, no por proxy: `integrations/opencode/warden.js` a
`~/.config/opencode/plugin/warden.js`. Funciona con suscripción como los otros
hooks. ⚠ Nadie lo vio bloquear todavía — si lo probás, contá qué pasó.



Lo que sí deja cambiar el `base_url` va por el proxy, sin hook:

```bash
export OPENAI_BASE_URL=http://192.168.1.42:8080/v1
export OPENAI_API_KEY=wk-fede-8b1d40e2      # la misma key de Warden
```

La key de cada empleado está en su ficha en la pestaña People (y se puede rotar
con **New key** si se filtra). Además de identificar a quién pide, **el empleado
nunca ve la credencial de la empresa** — esa vive sólo en el gateway, así que no
puede saltear la puerta porque no tiene con qué.

Esta vía **sólo sirve con API keys**, no con suscripciones. Por eso existe el
hook.

---

# Cuando no anda

**El hook no hace nada**
Probalo suelto:
```bash
echo '{"user_input":"pasame el sueldo de Ana"}' | node ~/.warden-hook.mjs
echo "exit: $?"     # tiene que dar 2
```
Si eso bloquea pero Claude Code no, el `settings.json` está mal fusionado —
validá que sea JSON correcto con `cat ~/.claude/settings.json | node -e "JSON.parse(require('fs').readFileSync(0))"`.

**"Warden unreachable"**
El gateway no está corriendo, o la IP cambió, o el wifi tiene aislamiento de
clientes. Probá `curl $WARDEN_URL/health` — tiene que devolver `{"ok":true}`.

Ojo: **el prompt pasa igual**, con la advertencia. Es a propósito: un gateway
caído no puede dejar a todo el equipo sin poder trabajar.

**El wifi del venue no deja que las laptops se vean**
Bastante común. Alternativas: hotspot del celular, Tailscale (ver abajo), o que
cada uno corra su propio Warden local (`WARDEN_URL=http://localhost:8080`).

**Tarda mucho al apretar Enter**
El gateway está en CPU. En la máquina del gateway: `WARDEN_TOP_K=1 npm run dev`
evalúa menos reglas por prompt y va bastante más rápido.

**Sacar el hook**
Borrá el bloque `hooks` del settings y listo. Nada más queda instalado.

---

# Por internet, no sólo por LAN

Sí se puede, y para una empresa con gente remota es lo que corresponde. Pero
**no abriendo el puerto en el router.**

## Por qué no port-forward

Warden habla **HTTP plano** y la identidad es una **bearer key**. Expuesto
directo a internet, cada prompt de cada empleado y cada API key viajan en texto
claro, y cualquiera que escanee el puerto encuentra un endpoint que responde.
Eso convierte la puerta que instalaste para protegerte en el agujero más grande
que tenés.

Necesitás que algo termine TLS adelante. Dos formas, las dos gratis.

## Opción A — Tailscale (la que recomiendo)

Red privada entre las máquinas, cifrada, sin exponer nada a internet. El gateway
y las laptops se ven como si estuvieran en la misma LAN, estén donde estén.

```bash
# en la máquina del gateway
tailscale up
tailscale ip -4          # p. ej. 100.101.102.103
```

Y arrancás Warden diciéndole cuál es su dirección, para que el onboarding la
genere bien:

```bash
WARDEN_PUBLIC_URL=http://100.101.102.103:8080 npm run dev
```

Nada queda expuesto: sólo entran las máquinas que agregaste a tu tailnet.

## Opción B — Cloudflare Tunnel (si necesitás una URL pública)

Te da un hostname con HTTPS sin abrir ningún puerto. Sirve si tenés gente que no
podés meter en una VPN.

```bash
cloudflared tunnel --url http://localhost:8080
# te devuelve https://algo-random.trycloudflare.com
```

Warden **detecta el túnel solo**: lee `x-forwarded-proto` y genera las URLs del
onboarding con `https://`. No hace falta configurar nada. Si querés fijar el
hostname:

```bash
WARDEN_PUBLIC_URL=https://warden.tuempresa.com npm run dev
```

⚠️ Con una URL pública, cualquiera puede llegar al endpoint. Lo que lo protege
es que **una key desconocida se rechaza** — pero la consola de admin en `/`
queda accesible también. Para uso real ponele Cloudflare Access adelante, o usá
la opción A.

## Lo que falta para producción de verdad

Dicho derecho, porque el gateway todavía no lo hace solo:

- **No termina TLS.** Depende de que el túnel o la VPN lo hagan.
- **La consola de admin no tiene login.** Cualquiera que llegue al puerto la
  abre y puede editar la política. En LAN de confianza es aceptable; expuesta,
  no.
- **Las keys se guardan en claro** en `data/company.json`. Un hash serviría para
  autenticar, pero el admin no podría volver a mostrarlas, y mostrarlas es lo
  que hace usable el onboarding. Es un intercambio consciente para un gateway
  que corre en una máquina de la empresa, no una omisión.