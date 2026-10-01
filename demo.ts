/**
 * Demo determinista del Reto 2 — Gestión Inteligente de Contratos.
 *
 * Procesa los 6 mensajes del buzón (msg-001…msg-006) llamando directamente
 * a las herramientas y al ciclo del agente con el adaptador SIMULADO
 * (sin llamadas de red ni API keys). Imprime por consola:
 *   - la extracción con sus niveles de confianza,
 *   - las validaciones (duplicados, otrosíes, asesor),
 *   - la decisión (automática vs Human-in-the-Loop),
 *   - el estado resultante del maestro de contratos.
 *
 * Ejecución:  npm run demo     (o: npx tsx demo.ts)
 */
import { prepararEntorno, restablecerMaestro, UMBRALES } from './src/config.js';
import { crearAdaptador } from './src/llm/adapter.js';
import { procesarMensaje, type OpcionesAgente } from './src/agent/loop.js';
import { listarMensajesBuzon, cargarMaestro, registrarContrato } from './src/tools/contratos.js';
import { listarSolicitudes, resolverSolicitud } from './src/agent/hitl.js';
import fs from 'node:fs';
import { RUTAS } from './src/config.js';

/** Colores ANSI ligeros para la salida de consola. */
const c = {
  dim: (s: string): string => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string): string => `\x1b[1m${s}\x1b[0m`,
  verde: (s: string): string => `\x1b[32m${s}\x1b[0m`,
  amarillo: (s: string): string => `\x1b[33m${s}\x1b[0m`,
  rojo: (s: string): string => `\x1b[31m${s}\x1b[0m`,
  cian: (s: string): string => `\x1b[36m${s}\x1b[0m`,
};

/** Línea divisoria de secciones. */
function regla(titulo: string): void {
  console.log(`\n${c.bold('─'.repeat(8))} ${c.cian(titulo)} ${'─'.repeat(8)}`);
}

/** Formatea montos en COP. */
function cop(n: number): string {
  return n.toLocaleString('es-CO');
}

async function main(): Promise<void> {
  // Reloj determinista para auditoría reproducible.
  process.env['PROC_DEMO_FECHA'] = '2025-03-06T12:00:00.000Z';

  prepararEntorno();
  restablecerMaestro();
  if (fs.existsSync(RUTAS.operaciones)) fs.rmSync(RUTAS.operaciones);
  if (fs.existsSync(RUTAS.hitl)) fs.rmSync(RUTAS.hitl);

  console.log(c.bold('\n╔══════════════════════════════════════════════════════════════╗'));
  console.log(c.bold('║  RETO 2 — GESTIÓN INTELIGENTE DE CONTRATOS · Periferia IT    ║'));
  console.log(c.bold('║  Modo: adaptador SIMULADO (determinista, sin llamadas de red) ║'));
  console.log(c.bold('╚══════════════════════════════════════════════════════════════╝'));

  const buzón = listarMensajesBuzon({});
  if (!buzón.ok) {
    console.error(c.rojo(`No se pudo listar el buzón: ${buzón.error}`));
    process.exit(1);
  }
  regla(`BUZÓN DE ENTRADA (${buzón.data.length} mensajes)`);
  for (const m of buzón.data) {
    console.log(`  • ${c.bold(m.id)} — ${m.asunto} ${c.dim(`(de ${m.de})`)}`);
  }

  // El "humano" del demo aprueba automáticamente las solicitudes de baja
  // confianza del msg-005 y rechaza el escalamiento inválido del msg-006,
  // demostrando ambos caminos del Human-in-the-Loop.
  const adaptador = crearAdaptador('simulado');
  const confirmadorDemo = async (solicitud: { id: string; mensaje_id: string; tipo: string }): Promise<boolean> => {
    const aprobar = solicitud.mensaje_id === 'msg-005';
    console.log(
      `  ${c.amarillo(`[HITL ${solicitud.id}]`)} ${aprobar ? c.verde('APROBADA') : c.rojo('RECHAZADA')} por el operador (${solicitud.tipo})`,
    );
    return aprobar;
  };

  const opciones: OpcionesAgente = { adaptador, confirmador: confirmadorDemo };

  const resultados = [];
  for (const m of buzón.data) {
    regla(`PROCESANDO ${m.id.toUpperCase()} — ${m.asunto}`);
    const r = await procesarMensaje(m.id, opciones);
    resultados.push(r);
    console.log(`  Clasificación : ${c.bold(r.clasificacion)}  (confianza ${r.confianza.toFixed(2)} — nivel ${c.bold(r.nivel)})`);
    console.log(`  Justificación : ${r.justificacion}`);
    for (const a of r.acciones_ejecutadas) {
      console.log(
        `  Acción        : ${a.herramienta} → ${a.ok ? c.verde('OK') : c.amarillo(a.resumen)}`,
      );
      if (a.ok) console.log(c.dim(`    ${a.resumen}`));
    }
    if (r.hitl) console.log(`  HITL          : ${c.amarillo(r.hitl.id)} (${r.hitl.estado})`);
  }

  // Estado final del maestro de contratos.
  regla('MAESTRO DE CONTRATOS RESULTANTE');
  const maestro = cargarMaestro();
  for (const ct of maestro) {
    console.log(
      `  ${c.bold(ct.id)}  ${ct.cliente.padEnd(24)} v${ct.version}  ${ct.estado.padEnd(10)} ` +
        `mensual ${cop(ct.valor_mensual_cop)}  total ${cop(ct.monto_total_cop)}  hasta ${ct.fecha_fin}`,
    );
  }

  // Solicitudes HITL generadas.
  regla('SOLICITUDES HUMAN-IN-THE-LOOP');
  const solicitudes = listarSolicitudes();
  if (solicitudes.length === 0) console.log('  (ninguna)');
  for (const s of solicitudes) {
    console.log(`  ${c.bold(s.id)} [${c.verde(s.estado === 'APROBADA' ? 'APROBADA' : s.estado === 'RECHAZADA' ? 'RECHAZADA' : s.estado)}] msg=${s.mensaje_id} tipo=${s.tipo}`);
    if (s.riesgos.length > 0) console.log(c.dim(`     riesgos: ${s.riesgos.join(' | ')}`));
  }

  // Fase de resolución HITL: el operador revisa lo pendiente. Aprueba hitl-001
  // completando el NIT real (origen HUMANO) y rechaza hitl-002 (contrato inexistente).
  regla('RESOLUCIÓN HITL POR EL OPERADOR');
  const pendientes = listarSolicitudes().filter((s) => s.estado === 'PENDIENTE');
  for (const s of pendientes) {
    if (s.mensaje_id === 'msg-005' && s.tipo === 'REGISTRO_CONTRATO') {
      console.log(`  ${c.bold(s.id)}: el operador APRUEBA y completa el NIT real del cliente (origen HUMANO).`);
      const alta = registrarContrato({
        cliente: 'Conexión Andina Ltda',
        nit: '901555444-9',
        asesor_email: 'ana.gomez@periferia.com',
        valor_mensual_cop: 8_500_000,
        monto_total_cop: 204_000_000,
        fecha_inicio: '2025-04-01',
        fecha_fin: '2027-03-31',
        tipo: 'BASE',
        mensaje_id: s.mensaje_id,
        confianza: 1,
        origen: 'HUMANO',
      });
      resolverSolicitud(s.id, true, 'operador-demo');
      console.log(
        alta.ok
          ? `    → Alta confirmada: ${c.verde(alta.data.id)} ${alta.data.cliente} (v${alta.data.version})`
          : `    → ${c.rojo(`ERROR: ${alta.error}`)}`,
      );
    } else {
      resolverSolicitud(s.id, false, 'operador-demo');
      console.log(`  ${c.bold(s.id)}: el operador RECHAZA — el contrato referenciado no existe; se notifica al remitente.`);
    }
  }

  // Registro de operaciones (auditoría).
  regla('REGISTRO DE OPERACIONES (auditoría JSONL)');
  const lineas = fs.existsSync(RUTAS.operaciones) ? fs.readFileSync(RUTAS.operaciones, 'utf-8').trim().split('\n') : [];
  console.log(`  ${lineas.length} operaciones registradas en ${c.dim('fixtures/reto-02/operaciones.jsonl')}`);
  for (const linea of lineas.slice(0, 4)) {
    try {
      const op = JSON.parse(linea) as { id_op: string; herramienta: string; resultado: string; detalle: string };
      console.log(c.dim(`  • ${op.id_op} ${op.herramienta} → ${op.resultado} — ${op.detalle.slice(0, 70)}`));
    } catch {
      // línea incompleta: se ignora en el resumen
    }
  }

  // Resumen final.
  regla('RESUMEN');
  const porClasificacion = new Map<string, number>();
  for (const r of resultados) porClasificacion.set(r.clasificacion, (porClasificacion.get(r.clasificacion) ?? 0) + 1);
  for (const [k, v] of porClasificacion) console.log(`  ${k.padEnd(16)}: ${v}`);
  const automaticas = resultados.filter((r) => r.acciones_ejecutadas.some((a) => a.ok)).length;
  const escaladas = solicitudes.length;
  console.log(`  Acciones automáticas OK : ${c.verde(String(automaticas))}`);
  console.log(`  Escaladas a humano      : ${c.amarillo(String(escaladas))}`);
  console.log(`  Umbral auto/medio       : ${UMBRALES.auto} / ${UMBRALES.media}`);
  console.log(`\n${c.verde('Demo determinista completada sin errores.')} ${c.dim('Documentación completa en SOLUCION.md')}\n`);
}

main().catch((error: unknown) => {
  console.error(c.rojo(`Error fatal del demo: ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
