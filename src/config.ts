/**
 * Configuración central del sistema: rutas, umbrales de confianza y entorno.
 * Todas las rutas son relativas a la raíz del proyecto y se resuelven una sola vez.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Raíz del proyecto (directorio que contiene package.json). */
export const RAIZ_PROYECTO: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directorio base de los fixtures del reto. */
export const DIR_FIXTURES = path.join(RAIZ_PROYECTO, 'fixtures', 'reto-02');

/** Rutas de datos. */
export const RUTAS = {
  buzon: path.join(DIR_FIXTURES, 'buzon'),
  maestro: path.join(DIR_FIXTURES, 'maestro-contratos.csv'),
  maestroBase: path.join(DIR_FIXTURES, 'maestro-contratos.base.csv'),
  comerciales: path.join(DIR_FIXTURES, 'comerciales.json'),
  operaciones: path.join(DIR_FIXTURES, 'operaciones.jsonl'),
  hitl: path.join(DIR_FIXTURES, 'hitl-pendientes.json'),
} as const;

/** Umbrales de confianza del ciclo de decisión del agente. */
export const UMBRALES = {
  /** ≥ a este nivel: el agente actúa automáticamente. */
  auto: 0.85,
  /** [media, auto): requiere confirmación humana (HITL). */
  media: 0.6,
  /** < media: no actúa; escala con clasificación AMBIGUO. */
  baja: 0.6,
} as const;

/**
 * Umbral económico (COP) para exigir doble aprobación en otrosíes,
 * según la regla de gobierno corporativo documentada en SOLUCION.md.
 */
export const UMBRAL_OTROSI_DOBLE_APROBACION_COP = 50_000_000;

/**
 * Dominios de correo considerados internos/autorizados de Periferia.
 * Remitentes externos pueden proponer contratos, pero sus mensajes
 * reciben una penalización de confianza y siempre pasan por HITL.
 */
export const DOMINIOS_AUTORIZADOS = ['periferia.com'] as const;

/** Fuente de extracción: simulada (determinista) o LLM real. */
export type ModoLlm = 'simulado' | 'openai' | 'ollama';

/** Lee el modo LLM desde variables de entorno (por defecto: simulado). */
export function modoLlmDesdeEntorno(): ModoLlm {
  const modo = (process.env.LLM_MODO ?? 'simulado').toLowerCase();
  if (modo === 'openai' || modo === 'ollama' || modo === 'simulado') return modo;
  return 'simulado';
}

/**
 * preparaEntorno(): garantiza que el maestro exista (lo restaura desde la
 * semilla .base.csv si falta o está vacío) y que el directorio de fixtures
 * sea utilizable. Idempotente; se llama al iniciar demo y servidor.
 */
export function prepararEntorno(): void {
  try {
    if (!fs.existsSync(RUTAS.maestro) || fs.statSync(RUTAS.maestro).size === 0) {
      fs.copyFileSync(RUTAS.maestroBase, RUTAS.maestro);
    }
    if (!fs.existsSync(RUTAS.buzon)) {
      throw new Error(`El buzón no existe en ${RUTAS.buzon}`);
    }
  } catch (error) {
    throw new Error(
      `No se pudo preparar el entorno de fixtures: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Restaura el maestro a su estado semilla (útil entre ejecuciones del demo). */
export function restablecerMaestro(): void {
  fs.copyFileSync(RUTAS.maestroBase, RUTAS.maestro);
}

/**
 * Reloj determinista: el reloj real del sistema es útil para el servidor,
 * pero el demo (y los tests) fijan PROC_DEMO_FECHA para que las marcas de
 * tiempo de auditoría y de nuevas operaciones sean reproducibles.
 */
export function ahora(): Date {
  const fija = process.env.PROC_DEMO_FECHA;
  if (fija) {
    const d = new Date(fija);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Nivel de confianza derivado de un score 0..1. */
export function nivelDeConfianza(score: number): 'ALTA' | 'MEDIA' | 'BAJA' {
  if (score >= UMBRALES.auto) return 'ALTA';
  if (score >= UMBRALES.media) return 'MEDIA';
  return 'BAJA';
}
