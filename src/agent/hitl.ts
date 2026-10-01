/**
 * Almacén de solicitudes Human-in-the-Loop (HITL).
 * Persiste las confirmaciones pendientes en fixtures/reto-02/hitl-pendientes.json
 * para que sobrevivan reinicios del servidor y sean auditables.
 */
import fs from 'node:fs';
import { RUTAS, ahora } from '../config.js';
import type { SolicitudHitl } from '../types.js';

/** Lee todas las solicitudes HITL conocidas. */
export function listarSolicitudes(): SolicitudHitl[] {
  try {
    if (!fs.existsSync(RUTAS.hitl)) return [];
    const json = JSON.parse(fs.readFileSync(RUTAS.hitl, 'utf-8')) as { solicitudes?: SolicitudHitl[] };
    return Array.isArray(json.solicitudes) ? json.solicitudes : [];
  } catch {
    return [];
  }
}

/** Persiste el listado completo de solicitudes. */
function guardar(solicitudes: SolicitudHitl[]): void {
  fs.writeFileSync(RUTAS.hitl, JSON.stringify({ solicitudes }, null, 2), 'utf-8');
}

/** Crea y persiste una nueva solicitud pendiente. */
export function crearSolicitud(
  datos: Omit<SolicitudHitl, 'id' | 'estado' | 'creada_en'>,
): SolicitudHitl {
  const previas = listarSolicitudes();
  const solicitud: SolicitudHitl = {
    ...datos,
    id: `hitl-${String(previas.length + 1).padStart(3, '0')}`,
    estado: 'PENDIENTE',
    creada_en: ahora().toISOString(),
  };
  guardar([...previas, solicitud]);
  return solicitud;
}

/** Resuelve una solicitud (aprobar/rechazar). Devuelve null si no existe o ya estaba resuelta. */
export function resolverSolicitud(
  id: string,
  aprobar: boolean,
  resueltaPor: string,
): SolicitudHitl | null {
  const solicitudes = listarSolicitudes();
  const idx = solicitudes.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const actual = solicitudes[idx];
  if (!actual || actual.estado !== 'PENDIENTE') return null;
  const resuelta: SolicitudHitl = {
    ...actual,
    estado: aprobar ? 'APROBADA' : 'RECHAZADA',
    resuelta_en: ahora().toISOString(),
    resuelta_por: resueltaPor,
  };
  solicitudes[idx] = resuelta;
  guardar(solicitudes);
  return resuelta;
}

/** Busca una solicitud por id. */
export function buscarSolicitud(id: string): SolicitudHitl | undefined {
  return listarSolicitudes().find((s) => s.id === id);
}
