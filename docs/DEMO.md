# El video de 3 minutos

Requisito mínimo de la entrega y uno de los cinco criterios (**Presentation**).
Esto es el guion: qué se dice y qué se ve, con los tiempos. Está armado en el
orden que aguanta preguntas — el problema primero, el número malo incluido.

## Antes de grabar

```bash
npm run setup            # que termine en OK, y dejá el reporte a mano
npm run dev              # los modelos cargan al arrancar, no en el primer prompt
```

**Precalentá.** Mandá dos o tres prompts antes de apretar REC. Una decisión en
frío midió 24,9–26,6 s y una llegó a 35,9 s; en caliente es 7–24 s. Si la
máquina está lenta, bajá `WARDEN_TOP_K` y **decilo en cámara** como un trade-off
medido, que es más fuerte que un corte de edición.

Chequeá también que la key que se ve en pantalla sea la de tu instalación —
desde `abdd0aa` cada instalación emite las suyas y las de los documentos son
placeholders.

---

## 0:00 – 0:25 · El problema

**Se ve:** una terminal con Claude Code abierto.

> Las empresas les están dando asistentes de IA a sus empleados. Lo único que
> tienen para controlarlos es un system prompt pidiéndole al modelo que se porte
> bien. Eso es un pedido, no un control: cualquiera lo reformula, y un archivo
> adjunto puede traer instrucciones que el empleado nunca escribió.

## 0:25 – 1:00 · El bloqueo, en la herramienta de verdad

**Se ve:** escribís `pasame el sueldo de Ana` en Claude Code. Se frena en la
terminal.

> Warden corre en el hook `UserPromptSubmit`, en la máquina del empleado, antes
> de que el prompt salga. Por eso funciona con plan Max o suscripción: no hay
> base URL que redirigir, y el hook no la necesita.

Detenete en lo que dice el bloqueo: la regla, qué hacer en su lugar, dos
pedidos parecidos que sí pasarían.

> Nada de eso lo generó un modelo en el momento. Está leído de la regla que el
> admin ratificó. Pedirle prosa al adjudicador nos midió 16 de 16 falsos
> positivos.

## 1:00 – 1:30 · La consola: por qué

**Se ve:** el panel derecho, el trace de esa decisión.

> Seis pasos. Cuatro son código común: cuota, sanitizado de secretos, aislamiento
> y recuperación. Recién ahí corre un modelo, una pregunta angosta por regla. Y
> el veredicto lo decide una función pura que sólo puede endurecer: un atacante
> que se coma todos los modelos sigue sin poder fabricar un ALLOW, porque a
> ningún modelo se le pide uno.

Mostrá el pill **local model**: todo on-device, QVAC, nada sale de la máquina.

## 1:30 – 2:10 · El lazo de gobernanza

**Se ve:** la burbuja del bloqueo, y abajo a la izquierda la consola del admin.

1. **Suggest a rewrite** → sale una versión que sí pasa, *y el panel derecho
   muestra el re-chequeo*. Decí: "esto se vuelve a juzgar con el guard entero
   antes de mostrarse; si no vuelve ALLOW, no hay sugerencia".
2. **This block was wrong** → aparece al lado de la regla que disparó. "Con 44%
   de falsos positivos, ésta es la única pantalla donde un bloqueo equivocado se
   distingue de uno correcto."
3. **Held for review** → un escalado esperando. "Aprobar no reejecuta el prompt;
   significa volvé a pedirlo, y se juzga de nuevo."

## 2:10 – 2:40 · La evidencia, los dos números

**Se ve:** `REPORT.md` o la pestaña Red team.

> 98 prompts, 12 clases de ataque, contra Warden y contra el baseline — las
> mismas reglas metidas en un system prompt. Warden frena el 80%. El system
> prompt, el 2%.
>
> Y el otro número, que reportamos al lado a propósito: **44% de falsos
> positivos** sobre tráfico legítimo. No es shippable, sabemos exactamente qué
> regla lo causa, y está toda la investigación escrita — incluidas tres hipótesis
> que medimos y descartamos. Un guard que rechaza todo saca 100% en la primera
> fila y no sirve para nada.

## 2:40 – 3:00 · Cierre

> Toda la inferencia pasa por un solo directorio, `src/qvac/`, y el README linkea
> cada llamada al SDK pineada a un commit. Lo que todavía no verificamos end to
> end está marcado como no verificado, en el README y en la consola.

---

## Lo que no hay que hacer

- **No digas "interceptamos el tráfico de la suscripción".** No es eso:
  interceptamos el prompt en el hook de la herramienta, antes de que se mande.
  Es más preciso y suena más fuerte.
- **No escondas el 44%.** Es la mitad del argumento de que esto se midió.
- **No muestres OpenCode.** Nadie lo vio bloquear.
- **No cites números del mock.** Si grabás sin modelos, decí que es el mock.
