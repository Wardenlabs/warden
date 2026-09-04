# Mediciones

**Este archivo se genera.** No lo edites a mano — corré `pnpm run measurements`.
Sale de `data/measurements/*.json`, que escribe `pnpm run eval`, así que la tabla
no puede desincronizarse de las corridas. El *por qué* de cada cambio vive en
[`PROBLEMAS.md`](PROBLEMAS.md); acá sólo están los números que se midieron.

Un falso positivo cuenta si el prompt se bloqueó mal en **cualquier** repetición:
un guard que frena trabajo legítimo una vez de cada tres sigue roto, y promediarlo
es como se esconde el no-determinismo.

17 corrida(s).

| Fecha | Qué se probó | Falsos positivos | Ataques frenados | p50 | Reps |
|---|---|---|---|---|---|
| 2026-08-28 22:55 | línea base — sólo benignos, política completa | 62/79 (78%) | — | 2743ms | 1 |
| 2026-08-28 22:58 | sin r-instruction-override — sólo benignos | 28/79 (35%) | — | 2347ms | 1 |
| 2026-08-28 23:11 | línea base completa — benignos + ataques, política completa | 62/79 (78%) | 68/76 (89%) | 3910ms | 1 |
| 2026-08-28 23:18 | sin r-instruction-override — benignos + ataques | 25/79 (32%) | 55/76 (72%) | 3086ms | 1 |
| 2026-08-28 23:43 | r-instruction-override enforcedBy=detector + detector mejorado | 27/79 (34%) | 61/76 (80%) | 2440ms | 1 |
| 2026-08-29 00:05 | enforcedBy=detector aplicado a las políticas · 3 reps | 32/79 (41%) | 58/76 (76%) | 3049ms | 3 |
| 2026-08-29 01:10 | MEZCLA: main (piso, guard-protocol, pasada inyección) + guard-harness (calificadores, base64) | 66/79 (84%) | 69/76 (91%) | 4268ms | 3 |
| 2026-08-29 01:55 | MEZCLA + WARDEN_INJECTION_PASS=replace (pasada 0.6B reemplaza la regla pinned) | 43/79 (54%) | 63/76 (83%) | 5943ms | 3 |
| 2026-08-29 03:04 | MAIN sola · pasada apagada | 69/79 (87%) | 69/76 (91%) | 4059ms | 3 |
| 2026-08-29 03:46 | MAIN sola · WARDEN_INJECTION_PASS=replace | 47/79 (59%) | 64/76 (84%) | 5217ms | 3 |
| 2026-08-30 22:40 | main-b1c5a01-primera-medicion-real | 51/94 (54%) | — | 10503ms | 1 |
| 2026-08-31 01:32 | 8B-sin-deadline-corto | 6/109 (6%) | — | 45558ms | 1 |
| 2026-08-31 03:59 | 8B-con-ataques | 7/109 (6%) | 54/76 (71%) | 46203ms | 1 |
| 2026-08-31 04:32 | 1.7B-con-ataques (linea base pareada del 8B) | 69/109 (63%) | 68/76 (89%) | 10509ms | 1 |
| 2026-09-04 14:30 | M1 Pro 16GB, Metal, Qwen3-1.7B adjudicator (GPU latency check) | 78/109 (72%) | 72/76 (95%) | 2458ms | 1 |
| 2026-09-04 15:09 | M1 Pro 16GB, Metal, Qwen3-8B adjudicator (GPU latency check) | 10/109 (9%) | 55/76 (72%) | 10955ms | 1 |
| 2026-09-04 16:00 | M1 Pro 16GB, Metal, DynaGuard-1.7B Q8_0 in the adjudicator seat, dynaguard form (auto from filename) | 49/109 (45%) | 71/76 (93%) | 1980ms | 1 |

## Detalle por corrida

### 2026-08-28 22:55 — línea base — sólo benignos, política completa

`2026-08-28T22-55-07Z-40deab9-dirty.json`

- commit `40deab9` **+cambios sin commitear** · política `f6c7579468d5`
- adaptador **real** · 1 repetición(es) · 79 prompts
- Apple M4 (10 núcleos)
- falsos positivos **62/79 (78%)** · ataques **—** · veredicto inestable en 0
- por regla: `r-instruction-override` 57 · `r-credentials` 19 · `r-payroll` 5 · `r-payment-approval` 5 · `r-unreleased-financials` 5 · `r-customer-pii` 3
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-08-28 22:58 — sin r-instruction-override — sólo benignos

`2026-08-28T22-58-22Z-40deab9-dirty.json`

- commit `40deab9` **+cambios sin commitear** · política `55ad729d337f`
- adaptador **real** · 1 repetición(es) · 79 prompts
- Apple M4 (10 núcleos)
- falsos positivos **28/79 (35%)** · ataques **—** · veredicto inestable en 0
- por regla: `r-credentials` 21 · `r-payment-approval` 5 · `r-unreleased-financials` 4 · `r-payroll` 3 · `r-customer-pii` 3
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-08-28 23:11 — línea base completa — benignos + ataques, política completa

`2026-08-28T23-11-21Z-40deab9-dirty.json`

- commit `40deab9` **+cambios sin commitear** · política `f6c7579468d5`
- adaptador **real** · 1 repetición(es) · 155 prompts
- Apple M4 (10 núcleos)
- falsos positivos **62/79 (78%)** · ataques **68/76 (89%)** · veredicto inestable en 0
- por regla: `r-instruction-override` 57 · `r-credentials` 21 · `r-payroll` 5 · `r-unreleased-financials` 5 · `r-payment-approval` 4 · `r-customer-pii` 3
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-08-28 23:18 — sin r-instruction-override — benignos + ataques

`2026-08-28T23-18-20Z-40deab9-dirty.json`

- commit `40deab9` **+cambios sin commitear** · política `55ad729d337f`
- adaptador **real** · 1 repetición(es) · 155 prompts
- Apple M4 (10 núcleos)
- falsos positivos **25/79 (32%)** · ataques **55/76 (72%)** · veredicto inestable en 0
- por regla: `r-credentials` 13 · `r-payroll` 7 · `r-payment-approval` 5 · `r-customer-pii` 3 · `r-unreleased-financials` 3
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-08-28 23:43 — r-instruction-override enforcedBy=detector + detector mejorado

`2026-08-28T23-43-02Z-40deab9-dirty.json`

- commit `40deab9` **+cambios sin commitear** · política `63dddd063c94`
- adaptador **real** · 1 repetición(es) · 155 prompts
- Apple M4 (10 núcleos)
- falsos positivos **27/79 (34%)** · ataques **61/76 (80%)** · veredicto inestable en 0
- por regla: `r-credentials` 20 · `r-payroll` 5 · `r-customer-pii` 4 · `r-payment-approval` 4 · `r-unreleased-financials` 3
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-08-29 00:05 — enforcedBy=detector aplicado a las políticas · 3 reps

`2026-08-29T00-05-33Z-40deab9-dirty.json`

- commit `40deab9` **+cambios sin commitear** · política `63dddd063c94`
- adaptador **real** · 3 repetición(es) · 155 prompts
- Apple M4 (10 núcleos)
- falsos positivos **32/79 (41%)** · ataques **58/76 (76%)** · veredicto inestable en 20
- por regla: `r-credentials` 24 · `r-payroll` 6 · `r-payment-approval` 6 · `r-unreleased-financials` 5 · `r-customer-pii` 4
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-08-29 01:10 — MEZCLA: main (piso, guard-protocol, pasada inyección) + guard-harness (calificadores, base64)

`2026-08-29T01-10-52Z-b70533e-dirty.json`

- commit `b70533e` **+cambios sin commitear** · política `f6c7579468d5`
- adaptador **real** · 3 repetición(es) · 155 prompts
- Apple M4 (10 núcleos)
- falsos positivos **66/79 (84%)** · ataques **69/76 (91%)** · veredicto inestable en 17
- por regla: `r-instruction-override` 64 · `r-credentials` 29 · `r-unreleased-financials` 14 · `r-payroll` 11 · `r-payment-approval` 8 · `r-customer-pii` 6
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-08-29 01:55 — MEZCLA + WARDEN_INJECTION_PASS=replace (pasada 0.6B reemplaza la regla pinned)

`2026-08-29T01-55-14Z-b70533e-dirty.json`

- commit `b70533e` **+cambios sin commitear** · política `f6c7579468d5`
- adaptador **real** · 3 repetición(es) · 155 prompts
- Apple M4 (10 núcleos)
- falsos positivos **43/79 (54%)** · ataques **63/76 (83%)** · veredicto inestable en 30
- por regla: `r-credentials` 28 · `r-unreleased-financials` 13 · `r-payroll` 12 · `r-customer-pii` 7 · `r-payment-approval` 6 · `r-instruction-override` 1
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-08-29 03:04 — MAIN sola · pasada apagada

`2026-08-29T03-04-51Z-da41fa8-dirty.json`

- commit `da41fa8` **+cambios sin commitear** · política `f6c7579468d5`
- adaptador **real** · 3 repetición(es) · 155 prompts
- Apple M4 (10 núcleos)
- falsos positivos **69/79 (87%)** · ataques **69/76 (91%)** · veredicto inestable en 18
- por regla: `r-instruction-override` 64 · `r-credentials` 29 · `r-unreleased-financials` 12 · `r-payment-approval` 10 · `r-payroll` 8 · `r-customer-pii` 4
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-08-29 03:46 — MAIN sola · WARDEN_INJECTION_PASS=replace

`2026-08-29T03-46-48Z-da41fa8-dirty.json`

- commit `da41fa8` **+cambios sin commitear** · política `f6c7579468d5`
- adaptador **real** · 3 repetición(es) · 155 prompts
- Apple M4 (10 núcleos)
- falsos positivos **47/79 (59%)** · ataques **64/76 (84%)** · veredicto inestable en 28
- por regla: `r-credentials` 29 · `r-payment-approval` 12 · `r-unreleased-financials` 12 · `r-instruction-override` 10 · `r-payroll` 8 · `r-customer-pii` 6
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-08-30 22:40 — main-b1c5a01-primera-medicion-real

`2026-08-30T22-40-24Z-b1c5a01.json`

- commit `b1c5a01` · política `f6c7579468d5`
- adaptador **real** · 1 repetición(es) · 94 prompts
- Intel(R) Xeon(R) Processor @ 2.10GHz (4 núcleos)
- falsos positivos **51/94 (54%)** · ataques **—** · veredicto inestable en 0
- por regla: `r-instruction-override` 46 · `r-credentials` 21 · `r-unreleased-financials` 9 · `r-payment-approval` 8 · `r-payroll` 6 · `r-customer-pii` 5

### 2026-08-31 01:32 — 8B-sin-deadline-corto

`2026-08-31T01-32-01Z-3c20de8.json`

- commit `3c20de8` · política `f6c7579468d5`
- adaptador **real** · 1 repetición(es) · 109 prompts
- Intel(R) Xeon(R) Processor @ 2.10GHz (4 núcleos)
- config: `MODEL_ADJUDICATOR=models/Qwen3-8B-Q4_K_M.gguf` · `models=[object Object]`
- falsos positivos **6/109 (6%)** · ataques **—** · veredicto inestable en 0
- por regla: `r-instruction-override` [object Object]

### 2026-08-31 03:59 — 8B-con-ataques

`2026-08-31T03-59-22Z-204c582.json`

- commit `204c582` · política `f6c7579468d5`
- adaptador **real** · 1 repetición(es) · 185 prompts
- Intel(R) Xeon(R) Processor @ 2.10GHz (4 núcleos)
- config: `MODEL_ADJUDICATOR=models/Qwen3-8B-Q4_K_M.gguf` · `models=[object Object]`
- falsos positivos **7/109 (6%)** · ataques **54/76 (71%)** · veredicto inestable en 0
- por regla: `r-instruction-override` [object Object]

### 2026-08-31 04:32 — 1.7B-con-ataques (linea base pareada del 8B)

`2026-08-31T04-32-22Z-541270a.json`

- commit `541270a` · política `f6c7579468d5`
- adaptador **real** · 1 repetición(es) · 185 prompts
- Intel(R) Xeon(R) Processor @ 2.10GHz (4 núcleos)
- config: `models=[object Object]`
- falsos positivos **69/109 (63%)** · ataques **68/76 (89%)** · veredicto inestable en 0
- por regla: `r-instruction-override` [object Object] · `r-credentials` [object Object] · `r-unreleased-financials` [object Object] · `r-payment-approval` [object Object] · `r-payroll` [object Object] · `r-customer-pii` [object Object]

### 2026-09-04 14:30 — M1 Pro 16GB, Metal, Qwen3-1.7B adjudicator (GPU latency check)

`2026-09-04T14-30-33Z-f382b70-dirty.json`

- commit `f382b70` **+cambios sin commitear** · política `f6c7579468d5`
- adaptador **qvac** · 1 repetición(es) · 185 prompts
- Apple M1 Pro (10 núcleos)
- config: `models=[object Object]`
- falsos positivos **78/109 (72%)** · ataques **72/76 (95%)** · veredicto inestable en 0
- por regla: `r-instruction-override` [object Object] · `r-credentials` [object Object] · `r-unreleased-financials` [object Object] · `r-payroll` [object Object] · `r-payment-approval` [object Object] · `r-customer-pii` [object Object]
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-09-04 15:09 — M1 Pro 16GB, Metal, Qwen3-8B adjudicator (GPU latency check)

`2026-09-04T15-09-10Z-f382b70-dirty.json`

- commit `f382b70` **+cambios sin commitear** · política `f6c7579468d5`
- adaptador **qvac** · 1 repetición(es) · 185 prompts
- Apple M1 Pro (10 núcleos)
- config: `MODEL_ADJUDICATOR=/Users/martinezequielpulitano/Library/Application Support/Warden/models/Qwen3-8B-Q4_K_M.gguf` · `models=[object Object]`
- falsos positivos **10/109 (9%)** · ataques **55/76 (72%)** · veredicto inestable en 0
- por regla: `r-instruction-override` [object Object] · `r-credentials` [object Object] · `r-unreleased-financials` [object Object]
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

### 2026-09-04 16:00 — M1 Pro 16GB, Metal, DynaGuard-1.7B Q8_0 in the adjudicator seat, dynaguard form (auto from filename)

`2026-09-04T16-00-32Z-f382b70-dirty.json`

- commit `f382b70` **+cambios sin commitear** · política `f6c7579468d5`
- adaptador **qvac** · 1 repetición(es) · 185 prompts
- Apple M1 Pro (10 núcleos)
- config: `MODEL_ADJUDICATOR=/Users/martinezequielpulitano/Library/Application Support/Warden/models/DynaGuard-1.7B.Q8_0.gguf` · `models=[object Object]`
- falsos positivos **49/109 (45%)** · ataques **71/76 (93%)** · veredicto inestable en 0
- por regla: `r-instruction-override` [object Object] · `r-payment-approval` [object Object] · `r-customer-pii` [object Object] · `r-payroll` [object Object] · `r-unreleased-financials` [object Object] · `r-credentials` [object Object]
- ⚠ el árbol de trabajo estaba sucio: esta corrida no se reproduce sólo con el commit

---

Para ver **qué prompts cambiaron** entre dos corridas, que es la única forma
de distinguir una mejora del ruido a este tamaño de muestra:

```bash
pnpm run compare data/measurements/<antes>.json data/measurements/<después>.json
```
