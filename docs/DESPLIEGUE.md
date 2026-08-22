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
`WARDEN_USER` y la API key de esa persona. Si te falta un rol, lo creás abajo
con su cuota diaria. Haciendo click en alguien ves todas las reglas que lo
juzgan y podés escribirle una que aplique **sólo a él**.

## Qué le mandás a cada uno

**No lo escribas a mano.** En la pestaña People, hacé click en la persona y
bajá hasta **Onboarding**. Botón **"Copy the whole setup message"** → lo pegás
en el chat y listo. Ya viene con su id, su key y la dirección real de este
gateway adentro.

Abajo del botón está la misma cosa por herramienta —Claude Code, Codex, Cursor,
OpenCode, cualquier otra— cada bloque con su botón de copiar.

Por qué generado y no a mano: cada valor que retipeás es uno que podés errar, y
estos fallan en silencio. Un `WARDEN_USER` mal escrito no da error, simplemente
hace que a esa persona la juzguen como a un desconocido.

El rol **no** se lo mandás: sale del directorio. Si el empleado pone
`WARDEN_ROLE` en su máquina, el gateway lo ignora para cualquiera que esté
cargado en People — un rol que el empleado puede editar en su `.zshrc` es un rol
con el que podría elegir qué reglas lo juzgan. `WARDEN_ROLE` sólo se usa como
fallback para alguien que no está en el directorio.

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

## 1. Bajar el hook

```bash
curl -o ~/.warden-hook.mjs \
  https://raw.githubusercontent.com/MartinPuli/operations-aleph/main/integrations/warden-hook.mjs
chmod +x ~/.warden-hook.mjs
```

Un archivo, sin dependencias. Sólo lee el prompt, se lo pregunta al gateway, y
devuelve sí o no.

## 2. Configurar (en `~/.zshrc` o `~/.bashrc`)

```bash
export WARDEN_URL=http://192.168.1.42:8080
export WARDEN_USER=fede
export WARDEN_ROLE=analyst
```

`WARDEN_ROLE` es opcional y sólo sirve si no estás en el directorio; para todos
los demás manda lo que el admin puso en People.

Después `source ~/.zshrc` o abrí una terminal nueva.

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
export OPENAI_API_KEY=wk-fede-8b1d40e2      # la key personal de Warden
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
Bastante común. Alternativas: hotspot del celular, Tailscale, o que cada uno
corra su propio Warden local (`WARDEN_URL=http://localhost:8080`).

**Tarda mucho al apretar Enter**
El gateway está en CPU. En la máquina del gateway: `WARDEN_TOP_K=1 npm run dev`
evalúa menos reglas por prompt y va bastante más rápido.

**Sacar el hook**
Borrá el bloque `hooks` del settings y listo. Nada más queda instalado.
