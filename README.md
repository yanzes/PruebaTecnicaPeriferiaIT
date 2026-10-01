# Reto 2 — Gestión Inteligente de Contratos y Buzón de Entrada

**Solución para Periferia IT Group** · Agente autónomo que procesa el buzón compartido de
solicitudes contractuales, las valida contra las fuentes de verdad y decide por **niveles de
confianza**: actúa solo cuando puede justificarlo, pide confirmación humana cuando duda y
bloquea lo inválido. Cada decisión queda auditada.

> 📄 Documento técnico completo (arquitectura, decisiones de diseño, costos del modelo y regla
> de gobierno corporativo): **[SOLUCION.md](SOLUCION.md)** ·
> 🎤 Guion de presentación: **[GUION-PRESENTACION.md](GUION-PRESENTACION.md)**

---

## 🧩 El problema

El buzón de entrada del área jurídico-comercial recibe:

- **Altas de contratos nuevos** escritos en lenguaje humano (*"el valor sería de unos ocho
  millones quinientos mil pesos al mes"*, *"el NIT no lo tengo a la mano, creo que termina en -9"*).
- **Otrosíes** (modificaciones de valor o vigencia) que referencian contratos existentes.
- **Ruido**: cadenas internas, felicitaciones, spam.
- **Errores**: reenvíos duplicados, referencias a contratos que no existen, remitentes con
  dominios mal escritos.

Procesar eso a mano es lento y propenso a errores. Este agente lo automatiza **con control**:
nunca inventa datos, nunca escribe sin justificación, y deja rastro de quién decidió qué.

## ⚙️ Cómo funciona

Cada correo del buzón recorre el ciclo **percibir → extraer → validar → decidir → actuar → auditar**:

1. **Extrae** las entidades (cliente, NIT, montos, vigencia, asesor) con una **confianza por
   campo (0–1)**. Los datos explícitos puntúan alto; los inferidos o aproximados, bajo
   (penalizaciones explícitas: −0.15 NIT parcial, −0.12 dominio no autorizado, −0.20 otrosí
   sin contrato válido).
2. **Valida** contra el maestro de contratos (`validarDuplicado`, `detectarOtrosi`) y el
   directorio comercial (`resolverAsesor`, tolerante a typos de dominio).
3. **Decide** con la matriz de confianza:

   | Confianza | Datos completos | Acción |
   |---|---|---|
   | ≥ 0.85 | Sí | ✅ **Automática**: registra y audita |
   | 0.60 – 0.84 | Sí | 🙋 **HITL**: propone y espera confirmación humana |
   | < 0.60 | No | 🚨 **Escalamiento**: no ejecuta nada, clasifica `AMBIGUO` |

4. **Escribe** solo si pasó todas las validaciones — y las herramientas de escritura
   **revalidan todo de nuevo** (defensa en profundidad): duplicados, asesor activo, dominio
   autorizado, fechas coherentes.
5. **Audita** cada operación en `fixtures/reto-02/operaciones.jsonl` (append-only), con
   origen `AGENTE` o `HUMANO`, confianza y detalle.

### Resultados sobre los 6 casos de prueba

| Mensaje | Escenario | Resultado |
|---|---|---|
| `msg-001` | Contrato nuevo completo | ✅ Alta automática (confianza 0.90) → `CT-2025-001` |
| `msg-002` | Otrosí de `CT-2024-001` | ✅ Aplicado: v1→v2, estado `MODIFICADO` |
| `msg-003` | Reenvío duplicado | 🛑 Bloqueado: coincide con `CT-2024-002` |
| `msg-004` | Correo de cumpleaños | 🗄️ `NO_RELEVANTE`, cero escrituras |
| `msg-005` | Datos ambiguos, remitente externo | 🙋 HITL (confianza 0.28) → operador aprueba → `CT-2025-002` origen `HUMANO` |
| `msg-006` | Otrosí de contrato inexistente | 🚨 Excepción controlada → escalamiento y rechazo |

## 🚀 Inicio rápido

**Requisitos:** Node.js 20+ (probado en Node 24). Sin API keys, sin servicios externos.

```bash
git clone https://github.com/yanzes/PruebaTecnicaPeriferiaIT.git
cd PruebaTecnicaPeriferiaIT
npm install
```

| Comando | Qué hace |
|---|---|
| `npm run demo` | **Demo determinista** de los 6 casos en consola: extracción, confianzas, validaciones, HITL y maestro resultante. Sin red. |
| `npm run client` | **Frontend web** en http://localhost:4173: chat, timeline en vivo de tool-calls (SSE) y tarjetas Aprobar/Rechazar (HITL). |
| `npm run typecheck` | Verificación TypeScript estricta (`strict`, `noImplicitAny`, `noUncheckedIndexedAccess`). |

El demo se **auto-reinicia** desde la semilla (`maestro-contratos.base.csv`) en cada ejecución:
siempre produce el mismo resultado. En la web, el botón *"Reiniciar maestro"* hace lo mismo.

### LLM real (opcional)

Por defecto la extracción usa un **adaptador simulado** (heurísticas deterministas, offline, $0).
El mismo ciclo corre con un modelo real cambiando una variable de entorno:

```bash
LLM_MODO=openai OPENAI_API_KEY=sk-... npm run client      # OpenAI (o cualquier endpoint compatible)
LLM_MODO=ollama OLLAMA_MODELO=llama3.1 npm run client     # Ollama local (http://localhost:11434)
```

## 🏗️ Arquitectura

```
Frontend SPA (src/client/public)  ──HTTP/SSE──▶  Servidor (src/client/server.ts)
                                                        │
                                          Ciclo del agente (src/agent/loop.ts)
                                          percibir → extraer → validar → decidir → actuar
                                                │                       │
                        Herramientas (src/tools/contratos.ts)   Puerto LLMAdapter
                        9 herramientas tipadas con Zod:          (src/llm/adapter.ts)
                        buzón · maestro · duplicados ·           simulado | OpenAI | Ollama
                        otrosíes · asesores · registro · auditoría
                                                │
                        Fixtures (fixtures/reto-02/): buzon/ · maestro · comerciales.json
                                                      · operaciones.jsonl · hitl-pendientes.json
```

- **El LLM no escribe nada**: solo extrae y propone. Las escrituras pasan por herramientas
  con validación Zod en la frontera y reglas de negocio duras (anti-duplicado, autorización,
  estados del contrato).
- **HITL real**: en la web, el turno del agente queda bloqueado hasta que un humano resuelve
  la solicitud (persistida en `hitl-pendientes.json`); la resolución queda auditada.
- **Regla de gobierno "UCUV"** (detallada en [SOLUCION.md §7](SOLUCION.md)): máquina de
  estados `BORRADOR→ACTIVO→MODIFICADO→CERRADO/VENCIDO`, historia inmutable, doble aprobación
  para otrosíes > COP 50.000.000, y conciliación maestro↔operaciones.

## 📁 Estructura

```
├── agent/prompt.md                  # System prompt del agente (directrices y excepciones)
├── demo.ts                          # Demo determinista de los 6 casos
├── SOLUCION.md                      # Documento técnico completo
├── GUION-PRESENTACION.md            # Guion de presentación (5 min)
├── src/
│   ├── config.ts                    # Rutas, umbrales de confianza, reloj inyectable
│   ├── types.ts                     # Tipos de dominio
│   ├── tools/contratos.ts           # 9 herramientas de negocio (Zod)
│   ├── llm/adapter.ts               # Puerto LLMAdapter + Simulado/OpenAI/Ollama
│   ├── agent/loop.ts                # Ciclo del agente + emisión de eventos
│   ├── agent/hitl.ts                # Store persistente de solicitudes HITL
│   └── client/                      # Servidor HTTP+SSE y SPA (sin build step)
└── fixtures/reto-02/
    ├── buzon/msg-001…006.md         # Correos de prueba
    ├── maestro-contratos.base.csv   # Semilla inmutable del maestro
    └── comerciales.json             # Directorio de asesores
```

> `maestro-contratos.csv`, `operaciones.jsonl` y `hitl-pendientes.json` son **estado generado
> en ejecución** y están ignorados por git; se regeneran solos al correr el demo o el cliente.

## 🛠️ Stack

- **TypeScript** estricto (ESM, `NodeNext`) sobre **Node 20+**, ejecutado con `tsx`.
- **Zod** para validación de toda frontera de datos (entradas/salidas de herramientas).
- **Sin framework web**: `node:http` + Server-Sent Events; el frontend es una SPA estática
  sin build step.
- Dependencias en runtime: solo `zod`.
