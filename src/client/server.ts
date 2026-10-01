/**
 * Servidor web del Reto 2: expone el agente de contratos como aplicación de
 * chat con visualización en vivo de tool-calls (SSE) y confirmaciones
 * Human-in-the-Loop. Sin frameworks ni build step: Node 20+ + ficheros estáticos.
 *
 *   npm run client   →  http://localhost:4173
 *
 * Variables de entorno:
 *   LLM_MODO=simulado|openai|ollama   (por defecto simulado)
 *   PUERTO=4173
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUTAS, prepararEntorno, restablecerMaestro, modoLlmDesdeEntorno, ahora } from '../config.js';
import { crearAdaptador } from '../llm/adapter.js';
import { procesarMensaje, type OyenteEventos } from '../agent/loop.js';
import { listarMensajesBuzon, cargarMaestro, leerMensaje } from '../tools/contratos.js';
import {
  listarSolicitudes,
  resolverSolicitud,
  buscarSolicitud,
  crearSolicitud,
} from '../agent/hitl.js';
import type { EventoAgente } from '../types.js';

const PUERTO = Number(process.env['PUERTO'] ?? 4173);
const DIR_PUBLICO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

/** Tipos MIME mínimos para el frontend estático. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Estado global de sesiones de chat (en memoria; el persistente vive en fixtures). */
interface SesionChat {
  id: string;
  mensaje_id: string;
  lineas: Array<{ rol: 'usuario' | 'agente' | 'sistema'; texto: string; ts: string }>;
  creada_en: string;
}
const sesiones = new Map<string, SesionChat>();

/** Suscriptores SSE activos. */
const clientesSse = new Set<http.ServerResponse>();

/** Difunde un evento SSE a todos los clientes conectados. */
function difundir(evento: string, data: unknown): void {
  const payload = `event: ${evento}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clientesSse) {
    try {
      res.write(payload);
    } catch {
      clientesSse.delete(res);
    }
  }
}

/** Espera la confirmación humana de una solicitud HITL (long-polling interno). */
function esperarConfirmacion(id: string, timeoutMs = 300_000): Promise<boolean> {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const temporizador = setInterval(() => {
      const s = buscarSolicitud(id);
      if (s && s.estado !== 'PENDIENTE') {
        clearInterval(temporizador);
        resolve(s.estado === 'APROBADA');
      } else if (Date.now() - inicio > timeoutMs) {
        clearInterval(temporizador);
        resolve(false);
      }
    }, 500);
  });
}

/** Cuerpo JSON de una petición POST con límite de tamaño. */
function leerCuerpo(req: http.IncomingMessage, limite = 1_000_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let datos = '';
    req.on('data', (c: Buffer) => {
      datos += c.toString('utf-8');
      if (datos.length > limite) {
        reject(new Error('Cuerpo demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(datos ? (JSON.parse(datos) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on('error', reject);
  });
}

/** Respuesta JSON estándar. */
function json(res: http.ServerResponse, codigo: number, data: unknown): void {
  const cuerpo = JSON.stringify(data);
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(cuerpo) });
  res.end(cuerpo);
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PUERTO}`);
  const ruta = url.pathname;

  /* ---------------- API ---------------- */

  if (ruta === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: conectado\ndata: {}\n\n`);
    clientesSse.add(res);
    req.on('close', () => clientesSse.delete(res));
    return;
  }

  if (ruta === '/api/estado' && req.method === 'GET') {
    return json(res, 200, {
      modo_llm: modoLlmDesdeEntorno(),
      buzon: listarMensajesBuzon({}),
      maestro: cargarMaestro(),
      hitl: listarSolicitudes(),
    });
  }

  if (ruta === '/api/mensaje' && req.method === 'GET') {
    const id = url.searchParams.get('id') ?? '';
    const r = leerMensaje({ mensaje_id: id });
    return json(res, r.ok ? 200 : 400, r);
  }

  if (ruta === '/api/chat' && req.method === 'POST') {
    void (async () => {
      try {
        const cuerpo = await leerCuerpo(req);
        const mensajeId = typeof cuerpo['mensaje_id'] === 'string' ? cuerpo['mensaje_id'] : '';
        if (!/^msg-\d{3}$/.test(mensajeId)) {
          return json(res, 400, { ok: false, error: 'mensaje_id inválido (se esperaba msg-00N)' });
        }
        const sesionId = `ses-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const oyente: OyenteEventos = (e: EventoAgente) => difundir('agente_evento', e);
        const adaptador = crearAdaptador();
        const resultado = await procesarMensaje(mensajeId, {
          adaptador,
          oyente,
          // Con confirmador: el turno queda "colgado" hasta que el humano
          // resuelva la solicitud vía /api/hitl (mejor HITL real).
          confirmador: async (solicitud: import('../types.js').SolicitudHitl) => {
            difundir('hitl_request', solicitud);
            return esperarConfirmacion(solicitud.id);
          },
          operador: 'operador-web',
        });
        const sesion: SesionChat = {
          id: sesionId,
          mensaje_id: mensajeId,
          lineas: [
            { rol: 'usuario', texto: `Procesar ${mensajeId}`, ts: ahora().toISOString() },
            { rol: 'agente', texto: `${resultado.clasificacion} (confianza ${resultado.confianza.toFixed(2)}): ${resultado.justificacion}`, ts: ahora().toISOString() },
          ],
          creada_en: ahora().toISOString(),
        };
        sesiones.set(sesionId, sesion);
        return json(res, 200, { ok: true, sesion, resultado });
      } catch (error) {
        return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return;
  }

  if (ruta === '/api/hitl' && req.method === 'POST') {
    void (async () => {
      try {
        const cuerpo = await leerCuerpo(req);
        const id = typeof cuerpo['id'] === 'string' ? cuerpo['id'] : '';
        const aprobar = cuerpo['aprobar'] === true;
        const resuelta = resolverSolicitud(id, aprobar, typeof cuerpo['operador'] === 'string' ? (cuerpo['operador'] as string) : 'operador-web');
        if (!resuelta) return json(res, 404, { ok: false, error: 'Solicitud no encontrada o ya resuelta' });
        difundir('hitl_resuelta', resuelta);
        return json(res, 200, { ok: true, solicitud: resuelta });
      } catch (error) {
        return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return;
  }

  if (ruta === '/api/hitl/crear' && req.method === 'POST') {
    void (async () => {
      try {
        const cuerpo = await leerCuerpo(req);
        const mensajeId = typeof cuerpo['mensaje_id'] === 'string' ? cuerpo['mensaje_id'] : '';
        const lectura = leerMensaje({ mensaje_id: mensajeId });
        if (!lectura.ok) return json(res, 400, lectura);
        const solicitud = crearSolicitud({
          mensaje_id: mensajeId,
          tipo: 'REGISTRO_CONTRATO',
          resumen: 'Escalado manualmente desde la interfaz web',
          extraccion: null,
          riesgos: ['Solicitud manual del operador'],
        });
        difundir('hitl_request', solicitud);
        return json(res, 200, { ok: true, solicitud });
      } catch (error) {
        return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return;
  }

  if (ruta === '/api/reiniciar' && req.method === 'POST') {
    restablecerMaestro();
    difundir('maestro_actualizado', cargarMaestro());
    return json(res, 200, { ok: true, maestro: cargarMaestro() });
  }

  /* ---------------- Estáticos ---------------- */

  if (req.method === 'GET' && (ruta === '/' || ruta === '/index.html')) {
    const archivo = path.join(DIR_PUBLICO, 'index.html');
    try {
      const html = fs.readFileSync(archivo, 'utf-8');
      res.writeHead(200, { 'Content-Type': MIME['.html'] ?? 'text/html' });
      return res.end(html);
    } catch {
      res.writeHead(500);
      return res.end('No se encontró el frontend (src/client/public/index.html)');
    }
  }

  if (req.method === 'GET' && ruta.startsWith('/public/')) {
    const relativa = ruta.slice('/public/'.length);
    const objetivo = path.normalize(path.join(DIR_PUBLICO, relativa));
    if (!objetivo.startsWith(DIR_PUBLICO)) {
      res.writeHead(403);
      return res.end('Prohibido');
    }
    try {
      const contenido = fs.readFileSync(objetivo);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(objetivo)] ?? 'application/octet-stream' });
      return res.end(contenido);
    } catch {
      res.writeHead(404);
      return res.end('No encontrado');
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 — ruta no encontrada');
});

prepararEntorno();
servidor.listen(PUERTO, () => {
  console.log(`✅ Servidor del agente de contratos en http://localhost:${PUERTO} (LLM_MODO=${modoLlmDesdeEntorno()})`);
  console.log(`   Buzón: ${RUTAS.buzon}`);
});
