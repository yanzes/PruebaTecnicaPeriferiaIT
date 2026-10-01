# Guion de presentación — 5 minutos
**Reto 2: Gestión Inteligente de Contratos y Buzón de Entrada · Periferia IT Group**

> Regla de oro: **mostrar primero, explicar después**. El evaluador debe ver el demo funcionando
> antes de la arquitectura. Ensayado, este guion dura 4:40 — deja 20 segundos de colchón.

---

## ⏱ Minuto 0:00–0:30 — Apertura y problema (hablar sin pantallas)

**Qué decir:**
> "El buzón compartido de Periferia recibe contratos y otrosíes mezclados con ruido, escritos
> en lenguaje humano: montos en palabras, NITs incompletos, remitentes con typos. Hoy eso lo
> procesa una persona a mano. Construí un agente autónomo que hace ese trabajo con reglas de
> confianza explícitas: **actúa solo cuando puede justificarlo y escala a un humano cuando no**.
> Todo queda auditado. Son dos demos: primero la ejecución determinista de los 6 casos de prueba,
> luego la interfaz web con Human-in-the-Loop en vivo."

---

## ⏱ Minuto 0:30–2:00 — Demo 1: consola determinista

**Acción:** ejecutar `npm run demo` (tarda ~2 s). Dejar la salida en pantalla y señalar mientras comentas.

**Qué decir, en este orden (señala cada sección):**
1. *"El buzón tiene los 6 mensajes del reto."* → señala la lista msg-001…006.
2. *"msg-001, contrato nuevo con datos completos: el agente extrae cada campo con su confianza,
   valida duplicado y asesor, y registra solo: confianza 0.90, por encima del umbral 0.85."*
3. *"msg-002 es un otrosí sobre CT-2024-001: compara contra el maestro, detecta los dos cambios
   — valor y vigencia — y aplica la modificación subiendo la versión a 2 y el estado a MODIFICADO."*
4. *"msg-003 es un reenvío: el bloqueo de duplicados lo detecta por NIT y lo rechaza citando el
   contrato existente. Nunca se crea un segundo contrato para el mismo cliente."*
5. *"msg-004 es un correo de cumpleaños: clasificado NO_RELEVANTE, cero escrituras."*
6. *"msg-005 es el caso interesante: remitente externo, NIT a medias, montos en palabras.
   La confianza cae a 0.28 y el agente NO actúa: escala. El operador aprueba y completa el dato
   faltante — el registro queda con origen HUMANO, la auditoría distingue quién decidió qué."*
7. *"Y msg-006: un otrosí sobre un contrato que no existe. Excepción controlada: se escala y el
   operador rechaza. Ninguna escritura sucia."*
8. Cerrar señalando el maestro final: *"Este es el estado resultante: 4 contratos, uno modificado,
   y 7 operaciones auditadas en JSONL."*

**Si preguntan por qué repite resultados:** el demo es determinista a propósito — reloj fijo vía
`PROC_DEMO_FECHA` y adaptador simulado; se autoreinicia desde la semilla en cada ejecución.

---

## ⏱ Minuto 2:00–3:30 — Demo 2: frontend con HITL en vivo

**Acción:** abrir `http://localhost:4173` (si no está corriendo: `npm run client`).

**Qué hacer y decir:**
1. *"Esta es la operación del día a día: buzón a la izquierda, el ciclo del agente al centro,
   confirmaciones humanas y maestro a la derecha."*
2. **Procesa `msg-001`** → *"Miren el timeline: cada llamada a herramienta con sus argumentos y
   resultado en vivo por Server-Sent Events. La extracción muestra confianza por campo, no solo
   un número global."* Señala la fila nueva del maestro.
3. **Procesa `msg-005`** → *"Y aquí está el Human-in-the-Loop real: el turno del agente queda
   esperando. La tarjeta muestra qué se extrajo y por qué es riesgoso."*
4. **Presiona "Aprobar"** → *"El humano resolvió; el agente continúa y el maestro se actualiza.
   Aprobar o rechazar queda en la bitácora con nombre del operador."*
5. Si hay tiempo: botón **"Reiniciar maestro"** — *"todo el entorno es reproducible."*

---

## ⏱ Minuto 3:30–4:40 — Arquitectura en 4 ideas (mostrar SOLUCION.md §2 si ayuda)

**Qué decir (una frase por idea):**
1. **Puerto LLM**: *"El ciclo del agente no sabe qué modelo lo asiste. `LLMAdapter` tiene tres
   implementaciones — simulado por defecto, OpenAI-compatible y Ollama local. Cambiar de modo
   es una variable de entorno; el dominio no se toca."*
2. **Confianza como contrato**: *"Toda extracción trae confianza por campo y global, con
   penalizaciones explícitas: −0.15 NIT parcial, −0.12 dominio no autorizado, −0.20 otrosí sin
   contrato. La matriz es ≥ 0.85 automático, 0.60–0.84 HITL, < 0.60 escalamiento."*
3. **Defensa en profundidad**: *"El agente propone, pero las herramientas de escritura
   revalidan: duplicados, asesor activo, dominio autorizado, fechas coherentes. Si el agente se
   equivoca, la herramienta lo bloquea."*
4. **Gobierno**: *"Estados BORRADOR→ACTIVO→MODIFICADO→CERRADO/VENCIDO, historia append-only,
   doble aprobación para otrosíes sobre 50 millones de COP, y conciliación maestro↔operaciones
   especificada en SOLUCION.md."*

**Cierre (15 s):**
> "En costo: modo simulado u Ollama es $0; con OpenAI y enrutado por dificultad, del orden de
> un dólar por mil correos. El valor real es que el humano solo revisa la frontera."

---

## 🎤 Preguntas técnicas probables (y respuesta corta)

| Pregunta del evaluador | Respuesta en 20 segundos |
|---|---|
| **¿Por qué un adaptador simulado y no LLM real?** | El reto exige determinismo y reproducibilidad; el simulado implementa las mismas heurísticas de confianza que pedirlé al modelo (mismo contrato `ExtraccionContrato`, validado al normalizar). Con `LLM_MODO=openai` u `ollama` corre el mismo ciclo con un modelo real, temperature 0 y salida JSON estricta. |
| **¿Cómo evitas alucinaciones del LLM?** | Tres capas: salida normalizada con Zod (los campos inventados que no pasan el schema se descartan), penalización de confianza para datos inferidos o aproximados, y revalidación dura en las herramientas de escritura. El LLM nunca escribe: solo propone. |
| **¿Por qué Zod en todas las herramientas?** | Las herramientas son la frontera del sistema; todo input se parsea (`safeParse`) y los errores vuelven como valores tipados (`ENTRADA_INVALIDA`, `DUPLICADO`, `CONFLICTO`…), no excepciones. TypeScript estricto + Zod = contratos de datos verificables en compilación y ejecución. |
| **¿Qué pasa si dos operadores procesan el mismo mensaje a la vez?** | El maestro se revalida en la escritura (anti-duplicado duro), así que el segundo intento recibe `DUPLICADO`. Para producción real: lock por contrato o transacción sobre el almacén — está en el roadmap con la migración a base de datos. |
| **¿Cómo escalaría esto a producción?** | Cambios de infraestructura, no de diseño: el CSV pasa a Postgres con historial, el store HITL a una cola con notificaciones, autenticación con roles (operador vs. jefe para doble aprobación), y la conciliación semanal como job programado. El ciclo del agente queda igual. |
| **¿Cómo mediste/limitarías el costo del LLM?** | SOLUCION.md §6: envelope mínimo (~900 tokens), cortocircuito para NO_RELEVANTE, caché por hash de contenido para reenvíos, y enrutado mini→grande solo si la confianza del primero es baja. ≈ $0.4–1 por mil correos. |
| **¿Por qué la confianza es un promedio y no algo más sofisticado?** | Es deliberado: con penalizaciones explícitas y trazables es auditable y explicable ante jurídica. Un modelo calibrado (log-probs o un clasificador de confianza) es un improvement plug-in: cambia `nivelDeConfianza`, no el ciclo. |
| **¿Qué es lo más débil de tu solución?** | Honesto: el matching difuso por bigramas es simple; con miles de clientes conviene un índice aproximado o embeddings. Y el modo web permite un solo turno en espera por pestaña — para paralelismo real, colas por sesión. |

---

## ✅ Checklist 2 minutos antes

- [ ] `npm run demo` corre limpio (última verificación).
- [ ] Cliente web arriba: `http://localhost:4173` responde.
- [ ] `SOLUCION.md` abierto en la sección de arquitectura (§2) por si piden diagrama.
- [ ] `agent/prompt.md` a mano por si preguntan por las directrices del agente.
- [ ] Cerrar pestañas personales del navegador; fuente del editor a tamaño legible.
