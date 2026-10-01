# SOLUCIÓN — Reto 2: Gestión Inteligente de Contratos y Buzón de Entrada

**Periferia IT Group · Agente autónomo de contratos con Human-in-the-Loop**

---

## 1. Resumen ejecutivo

Se construyó un agente autónomo que procesa el buzón de entrada compartido
(`fixtures/reto-02/buzon/`), detecta solicitudes de **altas de contratos** y **otrosíes**,
las valida contra el **maestro de contratos** y el **directorio comercial**, y las registra
solo cuando el nivel de confianza y las reglas de gobierno lo permiten. Los casos dudosos se
escalan a un humano mediante **solicitudes HITL** auditables. Todo el pipeline deja rastro en
un registro de operaciones **append-only** (JSONL).

```bash
npm install
npm run demo     # demo determinista de los 6 casos (sin red, sin API keys)
npm run client   # frontend web: http://localhost:4173 (chat + timeline + HITL)
npm run typecheck
```

### Resultados de la demo (`npm run demo`)

| Mensaje | Escenario | Resultado |
|---|---|---|
| `msg-001` | Contrato nuevo con datos completos | ✅ **Alta automática** (`CT-2025-001`, confianza 0.90) |
| `msg-002` | Otrosí de `CT-2024-001` (valor + vigencia) | ✅ **Otrosí aplicado** (v1→v2, estado `MODIFICADO`) |
| `msg-003` | Reenvío de contrato ya registrado | 🛑 **Duplicado bloqueado** (coincide `CT-2024-002`) |
| `msg-004` | Correo interno irrelevante | 🗄️ **NO_RELEVANTE**, archivado sin escrituras |
| `msg-005` | Contrato ambiguo (NIT faltante, montos en texto, remitente externo) | 🙋 **Escalado a HITL** (confianza 0.28 < 0.60); el operador aprueba y completa datos → `CT-2025-002` con origen `HUMANO` |
| `msg-006` | Otrosí de contrato inexistente + remitente con typo de dominio | 🚨 **Excepción controlada**: escalamiento y rechazo por el operador |

---

## 2. Arquitectura de la solución

```
                        ┌───────────────────────────────────────────────┐
                        │                 FRONTEND (SPA)                │
                        │  src/client/public/index.html (sin build)     │
                        │  chat · timeline SSE · tarjetas HITL · maestro│
                        └───────────────▲───────────────────────────────┘
                                        │ HTTP + Server-Sent Events
                        ┌───────────────┴───────────────────────────────┐
                        │            SERVIDOR (src/client/server.ts)    │
                        │  /api/chat  /api/hitl  /api/estado  /api/events│
                        └───────────────▲───────────────────────────────┘
                                        │ importa
┌───────────────────────────────────────┴───────────────────────────────────────┐
│                          CICLO DEL AGENTE (src/agent/loop.ts)                 │
│   percibir → extraer → validar → decidir → actuar → auditar                   │
│   emite EventoAgente en cada paso (consola, SSE o auditoría)                  │
│   ┌────────────────────┐   ┌──────────────────────────────────────────────┐   │
│   │ src/agent/hitl.ts  │   │ ConfirmadorHumano (demo scripted / web poll) │   │
│   │ solicitudes JSON   │   └──────────────────────────────────────────────┘   │
└─────────▲─────────────────────────────────────────────▲─────────────────────┘
          │ usa                                          │ depende de (puerto)
┌─────────┴───────────────────────────────┐   ┌─────────┴──────────────────────┐
│   HERRAMIENTAS (src/tools/contratos.ts) │   │  LLMAdapter (src/llm/adapter)  │
│   9 herramientas tipadas con Zod:       │   │  · AdaptadorSimulado (default) │
│   buzón · maestro · duplicados ·        │   │  · AdaptadorOpenAI (LLM_MODO=  │
│   otrosíes · asesores · registro ·      │   │    openai)                     │
│   auditoría JSONL                       │   │  · AdaptadorOllama (local)     │
└─────────▲───────────────────────────────┘   └────────────────────────────────┘
          │ lee/escribe
┌─────────┴─────────────────────────────────────────────────────────────────────┐
│  FIXTURES (fixtures/reto-02/)                                                 │
│  buzon/msg-001…006.md · maestro-contratos.csv (+ .base.csv semilla) ·          │
│  comerciales.json · operaciones.jsonl (append-only) · hitl-pendientes.json     │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Principio rector:** el núcleo de negocio (herramientas + ciclo) no sabe qué LLM lo asiste.
La extracción se inyecta por el puerto `LLMAdapter`, lo que permite pasar del modo simulado
a un modelo real sin tocar una línea del dominio.

---

## 3. El ciclo del agente

Cada mensaje del buzón recorre seis pasos; en cada paso se emite un `EventoAgente`
(Consumido por la consola del demo y por el stream SSE `/api/events` del frontend):

| # | Paso | Qué ocurre | Eventos |
|---|---|---|---|
| 1 | **Percibir** | `leerMensaje` parsea front-matter + cuerpo (remitente, email, asunto). | `turno_inicio`, `tool_call`, `tool_result` |
| 2 | **Extraer** | El adaptador LLM (o el simulado) devuelve `ExtraccionContrato`: entidades + **confianza por campo (0–1)** + notas. | `extraccion`, `confianza` |
| 3 | **Clasificar** | `CONTRATO_NUEVO` · `OTROSI` · `NO_RELEVANTE` · `AMBIGUO`. | — |
| 4 | **Validar** | Altas: `validarDuplicado` + `resolverAsesor`. Otrosíes: `detectarOtrosi` (contrato existe, cambios reales, umbral de doble aprobación). | `tool_call`, `tool_result` |
| 5 | **Decidir** | Matriz de confianza (§5): auto / HITL / escalamiento. Genera `AccionPropuesta[]`. | `clasificacion`, `decision` |
| 6 | **Actuar + Auditar** | Ejecuta `registrarContrato`/`registrarOtrosi`, o crea la solicitud HITL y espera/queda pendiente. Todo queda en `operaciones.jsonl`. | `hitl_request`, `hitl_resuelta`, `turno_fin`, `error` |

### Manejo de excepciones (todas controladas, nunca silenciosas)

- **Otrosí de contrato inexistente** (`CT-2099-999`): confianza ≤ 0.5, acción `ESCALAR`,
  la solicitud HITL documenta la causa exacta; no se ejecuta ninguna escritura.
- **Remitente con typo de dominio** (`jose.rodriguez@periberia.com`): `resolverAsesor`
  matchea por parte de usuario (≥ 0.9) y lo resuelve con nota de verificación.
- **Confianza baja + datos incompletos**: escalamiento directo (clasificación `AMBIGUO`).
- **Correo irrelevante**: se archiva con registro de auditoría breve, sin llamadas de escritura.
- **Errores de dominio tipados** (`ContratosToolError`): `ENTRADA_INVALIDA`, `NO_ENCONTRADO`,
  `DUPLICADO`, `CONFLICTO`, `NO_AUTORIZADO`, `ERROR_IO` — surfaced tal cual al operador,
  nunca "corregidos" por el agente.

---

## 4. Herramientas (todas con entrada/salida validadas por Zod)

| Herramienta | Tipo | Validaciones destacadas |
|---|---|---|
| `listarMensajesBuzon` | lectura | orden determinista por id |
| `leerMensaje` | lectura | formato `msg-00N`, front-matter obligatorio |
| `consultarMaestro` | lectura | id exacto o matching difuso (bigramas, ≥ 0.4) |
| `validarDuplicado` | lectura | coincidencia por NIT exacto o similitud de cliente ≥ 0.85 |
| `detectarOtrosi` | lectura | compara contra el contrato real; calcula si exige doble aprobación |
| `resolverAsesor` | lectura | email exacto, tolerancia a typos de dominio, nombre y zona |
| `registrarContrato` | escritura | asesor activo + dominio autorizado + anti-duplicado duro + fechas coherentes; ID secuencial por año |
| `registrarOtrosi` | escritura | contrato existente y no cerrado/vencido; incrementa `version`; recalcula monto total |
| `registrarOperacion` | escritura | append JSONL: quién, qué, cuándo, confianza, origen (`AGENTE`/`HUMANO`) |

Cada herramienta devuelve `ResultadoHerramienta<T> = { ok: true; data: T } | { ok: false; error; codigo }`:
los errores son **valores**, no excepciones, y el ciclo decide qué hacer con ellos.

---

## 5. Decisiones de diseño

1. **Puerto/adaptador para el LLM.** El mismo ciclo corre con el adaptador simulado
   (heurísticas deterministas, offline, $0) o con OpenAI/Ollama. El demo exige
   determinismo; producción exige un LLM real. El puerto resuelve ambas sin forks del código.
2. **Simulado como modo por defecto.** Reproduce con reglas el comportamiento esperado del
   modelo (tipificación, extracción, penalizaciones de confianza). Permite evaluar la
   gobernanza del flujo sin costo ni red.
3. **Confianza de dos niveles.** Por campo (¿el NIT es explícito o inferido?) y global
   (promedio ponderado con penalizaciones explícitas: −0.15 NIT parcial, −0.12 dominio no
   autorizado, −0.20 otrosí sin contrato válido). La matriz de decisión es:
   **≥ 0.85 auto · 0.60–0.84 HITL · < 0.60 escalamiento sin ejecutar**.
4. **HITL como tipo de acción (`EJECUTAR`/`ESCALAR`), no como parche.** En la web el turno
   del agente queda **bloqueado** hasta que un humano resuelve (encuesta sobre el estado
   persistido); en el demo el confirmador es un callback scripted. Ambos caminos usan el
   mismo store persistente (`hitl-pendientes.json`).
5. **Maestro append-only en la práctica.** Nunca se borra: los otrosíes incrementan `version`
   y mueven el estado a `MODIFICADO`. La semilla `maestro-contratos.base.csv` permite
   restaurar el entorno (`POST /api/reiniciar` o `npm run demo`) en cualquier momento.
6. **Reloj inyectable (`PROC_DEMO_FECHA`).** Los timestamps de auditoría del demo usan una
   fecha fija → dos ejecuciones producen salidas idénticas (salvo el azar del sufijo del
   `id_op`, que no afecta el proceso).
7. **TypeScript estricto extremo a extremo.** `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`;
   ESM con `NodeNext`; verificación con `tsc --noEmit`. Zod valida toda frontera de datos
   (inputs de herramientas y normalización de salidas del LLM).

---

## 6. Análisis de costos del modelo

El costo se concentra en el **paso 2 (extracción)**; el resto del ciclo es código determinista.
Estimación ilustrativa con precios públicos de referencia (ajustar a los vigentes al contratar):

| Etapa | Entrada/salida aproximada | Modelo sugerido | Costo ≈ por correo |
|---|---|---|---|
| Clasificación rápida (opcional, triage) | ~350 in / 20 out tokens | gpt-4o-mini / Haiku | ~$0.0001 |
| Extracción estructurada (JSON) | ~900 in / 250 out tokens | gpt-4o-mini | ~$0.0003 |
| Extracción compleja (msg-005 tipo) | ~1.100 in / 350 out tokens | gpt-4o (solo si confianza del mini < 0.7) | ~$0.006 |
| **Total típico (90% mini + 10% grande)** | | **enrutado por dificultad** | **≈ $0.0004–0.001** |

Proyección a escala (volumen típico de un área jurídica comercial):

- **1.000 correos/mes** → ≈ **$0.4–1.0/mes** con enrutado; ≈ $3/mes si todo va al modelo grande.
- **10.000 correos/mes** → ≈ **$4–10/mes** con enrutado; ≈ $30/mes sin él.
- **Modo simulado u Ollama local** → **$0** de API (Ollama solo cuesta infra: un nodo de 16 GB
  RAM procesa decenas de miles de correos/mes con llama3.1-8B).

**Palancas de optimización ya implementadas o previstas:**

1. *Envelope mínimo*: se envía solo front-matter + cuerpo (nunca hilos completos).
2. *Salida JSON estricta* (`format: json` en Ollama, `temperature: 0`) → menos reintentos.
3. *Cortocircuito*: los correos NO_RELEVANTE no llegan nunca a extracción costosa.
4. *Caché por hash de contenido*: reenvíos (como `msg-003`) reutilizan la extracción previa.
5. *Batching nocturno* para correos de baja prioridad (50% del volumen con modelos off-peak).

Conclusión: el costo del LLM es **insignificante frente al costo horario de un analista
humano**; la propuesta de valor es que el humano solo revisa los casos en frontera (≈ 20–30%
del volumen en nuestros fixtures, típicamente 10–15% en datos reales).

---

## 7. Regla de gobierno corporativo (propuesta obligatoria)

> **Política "Un Contrato, Una Verdad, Una Historia" (UCUV)** — rige el ciclo de vida
> completo de todo contrato que entra por el buzón.

**7.1 Máquina de estados obligatoria**

```
BORRADOR ──registro──▶ ACTIVO ──otrosí──▶ MODIFICADO ──otrosí──▶ MODIFICADO(v+1)…
   │                     │                      │
   └── rechazo HITL      ├── vencimiento ──▶ VENCIDO
                         └── mutuo acuerdo ─▶ CERRADO
```

- Ningún contrato salta estados; todo cambio de estado exige una **fila de auditoría**
  (`operaciones.jsonl`) con `origen` (`AGENTE`/`HUMANO`), `confianza` e `id_op`.
- `CERRADO` y `VENCIDO` son **terminales**: rechazan otrosíes por diseño
  (`registrarOtrosi` devuelve `CONFLICTO`).

**7.2 Reglas de oro**

1. **Inmutabilidad**: no se edita ni borra historia; las correcciones son nuevos registros
   con versión incrementada. El maestro actual es siempre la suma de su semilla + operaciones.
2. **Umbral de doble aprobación**: todo otrosí cuyo nuevo valor mensual supere
   **COP 50.000.000** exige dos aprobaciones humanas (propietario del contrato + jefe
   comercial), independientemente de la confianza del extractor.
3. **Autoría verificada**: solo altas con asesor activo del directorio y dominio autorizado.
   Solicitudes de remitentes externos requieren aprobación humana (origen `HUMANO`) siempre.
4. **Anti-duplicado global**: NIT exacto o cliente con similitud ≥ 0.85 bloquea la alta;
   la herramienta de escritura revalida aunque el agente se equivoque (defensa en profundidad).
5. **Conciliación periódica**: tarea programada semanal que verifica
   `maestro-contratos.csv` ↔ `operaciones.jsonl` ↔ sistema fuente (ERP). Toda divergencia
   abre una incidencia HITL automáticamente.
6. **Retención**: `operaciones.jsonl` y solicitudes HITL se conservan ≥ 5 años (requisito
   de auditoría); el buzón se archiva tras procesar.
7. **Métricas de gobierno** (panel mensual): % automatización, % escalamientos, tasa de
   rechazo HITL, tiempo medio de resolución, divergencias de conciliación. Meta razonable:
   ≥ 70% automatizado, < 2% rechazos humanos.

**7.3 Implementación en este repositorio**

Las reglas 1–4 ya están aplicadas en código (`src/tools/contratos.ts` + `src/agent/loop.ts` +
`UMBRAL_OTROSI_DOBLE_APROBACION_COP` en `src/config.ts`); las 5–7 quedan especificadas como
roadmap en §9.

---

## 8. Frontend y API

**Frontend** (`npm run client` → http://localhost:4173): SPA sin build step con:

- **Buzón** clicable; entrada libre `msg-00N` + Enter.
- **Chat/timeline en vivo** vía SSE: cada `EventoAgente` pinta su nodo (extracción con
  confianzas por campo, llamadas a herramientas con args/resultado, decisión, HITL).
- **Tarjetas HITL** con entidades extraídas, riesgos y botones Aprobar/Rechazar; el turno
  del agente espera la resolución real (bloqueo por encuesta del estado persistido).
- **Maestro de contratos** con versión, estado y montos; botón "Reiniciar maestro".

**API**: `POST /api/chat {mensaje_id}` · `GET /api/events` (SSE) · `POST /api/hitl {id,aprobar}` ·
`POST /api/hitl/crear` · `GET /api/estado` · `GET /api/mensaje?id=…` · `POST /api/reiniciar`.

**Variables de entorno**: `LLM_MODO=simulado|openai|ollama`, `OPENAI_API_KEY`,
`OPENAI_BASE_URL`, `OPENAI_MODELO`, `OLLAMA_URL`, `OLLAMA_MODELO`, `PUERTO`.

---

## 9. Roadmap breve

1. Conciliación programada maestro↔operaciones (regla 5) con alertas.
2. Autenticación y roles en el frontend (operador vs. jefe para doble aprobación).
3. Caché de extracción por hash + enrutado mini/grande según confianza inicial.
4. Tests de regresión sobre los 6 fixtures + casos de borde adicionales (fechas invertidas,
   montos negativos, asesor inactivo).
5. Exportación del maestro al ERP vía webhook firmado.

---

## 10. Estructura del repositorio

```
├── agent/prompt.md                 # system prompt del agente
├── demo.ts                         # demo determinista (6 casos)
├── SOLUCION.md                     # este documento
├── package.json / tsconfig.json
├── src/
│   ├── config.ts                   # rutas, umbrales, reloj inyectable
│   ├── types.ts                    # tipos de dominio
│   ├── tools/contratos.ts          # 9 herramientas con Zod
│   ├── llm/adapter.ts              # puerto + Simulado/OpenAI/Ollama
│   ├── agent/loop.ts               # ciclo del agente
│   ├── agent/hitl.ts               # store de solicitudes HITL
│   └── client/                     # servidor HTTP+SSE y SPA pública
└── fixtures/reto-02/
    ├── buzon/msg-001…006.md
    ├── maestro-contratos.base.csv  # semilla inmutable
    ├── maestro-contratos.csv       # estado vivo (restaurable)
    ├── comerciales.json
    ├── operaciones.jsonl           # auditoría append-only
    └── hitl-pendientes.json
```
