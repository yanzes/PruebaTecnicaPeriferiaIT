/**
 * Tipos de dominio del Reto 2 — Gestión Inteligente de Contratos.
 * Todas las estructuras que cruzan fronteras (herramientas, adaptador LLM,
 * eventos del ciclo del agente) están tipadas aquí y validadas con Zod
 * en las fronteras (ver src/tools/contratos.ts).
 */

/** Clasificación de relevancia de un mensaje del buzón. */
export type ClasificacionMensaje = 'CONTRATO_NUEVO' | 'OTROSI' | 'NO_RELEVANTE' | 'AMBIGUO';

/** Estado del ciclo de vida de un contrato (ver regla de gobierno en SOLUCION.md). */
export type EstadoContrato = 'BORRADOR' | 'ACTIVO' | 'MODIFICADO' | 'CERRADO' | 'VENCIDO';

/** Nivel de confianza de una extracción o decisión (0..1). */
export type NivelConfianza = 'ALTA' | 'MEDIA' | 'BAJA';

/** Origen de la decisión: automática del agente o humana (HITL). */
export type OrigenDecision = 'AGENTE' | 'HUMANO';

/**
 * Origen del texto analizado. Cuando la extracción proviene del adaptador
 * simulado, `fuente_extraccion` es 'SIMULADA'; con LLM real es 'LLM'.
 */
export type FuenteExtraccion = 'LLM' | 'SIMULADA';

/** Contrato del maestro (fila del CSV). */
export interface Contrato {
  id: string;                       // CT-AAAA-NNN
  cliente: string;
  nit: string;
  asesor_email: string;
  valor_mensual_cop: number;
  monto_total_cop: number;
  fecha_inicio: string;             // ISO yyyy-mm-dd
  fecha_fin: string;                // ISO yyyy-mm-dd
  estado: EstadoContrato;
  tipo: 'BASE' | 'SUSCRIPCION';
  /** Versión del contrato; se incrementa con cada otrosí aplicado. */
  version: number;
}

/** Asesor comercial del directorio comerciales.json. */
export interface Asesor {
  email: string;
  nombre_completo: string;
  zona: string;
  activo: boolean;
}

/** Mensaje del buzón de entrada (front-matter + cuerpo). */
export interface MensajeBuzon {
  id: string;                       // msg-00N
  de: string;                       // campo "de" crudo del front-matter
  remitente_nombre: string;         // nombre para mostrar
  remitente_email: string;          // email extraído entre < >
  fecha: string;                    // ISO con offset
  asunto: string;
  cuerpo: string;
}

/** Entidades extraídas de un mensaje, con confianza por campo. */
export interface ExtraccionContrato {
  tipo_operacion: 'CONTRATO_NUEVO' | 'OTROSI' | 'DESCONOCIDO';
  cliente?: string;
  nit?: string;
  asesor_email?: string;
  valor_mensual_cop?: number;
  monto_total_cop?: number;
  fecha_inicio?: string;
  fecha_fin?: string;
  tipo_contrato?: 'BASE' | 'SUSCRIPCION';
  /** Referencia explícita a un contrato existente (para otrosíes). */
  contrato_referenciado?: string;
  /** Confianza por campo extraído (0..1). */
  confianza_campos: Record<string, number>;
  /** Confianza global de la extracción (0..1). */
  confianza_global: number;
  /** Notas del extractor: supuestos, ambigüedades, advertencias. */
  notas: string[];
}

/** Acción propuesta por el agente sobre una herramienta del dominio. */
export interface AccionPropuesta {
  herramienta: NombreHerramienta;
  args: Record<string, unknown>;
  /** EJECUTAR llama a la herramienta; ESCALAR solo genera solicitud humana. */
  tipo?: 'EJECUTAR' | 'ESCALAR';
  /** Si true, la acción requiere confirmación humana antes de ejecutarse. */
  requiere_confirmacion: boolean;
  razon_confirmacion?: string;
}

/** Decisión del agente para un mensaje. */
export interface DecisionAgente {
  clasificacion: ClasificacionMensaje;
  confianza: number;
  acciones: AccionPropuesta[];
  justificacion: string;
}

export type NombreHerramienta =
  | 'listarMensajesBuzon'
  | 'leerMensaje'
  | 'consultarMaestro'
  | 'validarDuplicado'
  | 'detectarOtrosi'
  | 'resolverAsesor'
  | 'registrarContrato'
  | 'registrarOtrosi'
  | 'registrarOperacion'
  /** Pseudo-herramienta de auditoría del propio ciclo del agente. */
  | 'cicloAgente';

/** Evento emitido por el ciclo del agente para UI/auditoría en vivo. */
export interface EventoAgente {
  tipo:
    | 'turno_inicio'
    | 'clasificacion'
    | 'extraccion'
    | 'tool_call'
    | 'tool_result'
    | 'confianza'
    | 'hitl_request'
    | 'hitl_resuelta'
    | 'decision'
    | 'turno_fin'
    | 'error';
  mensaje_id: string | null;
  timestamp: string;
  data: unknown;
}

/** Solicitud de confirmación humana (Human-in-the-Loop). */
export interface SolicitudHitl {
  id: string;                       // hitl-001…
  mensaje_id: string;
  tipo: 'REGISTRO_CONTRATO' | 'REGISTRO_OTROSI';
  resumen: string;
  extraccion: ExtraccionContrato | null;
  riesgos: string[];
  estado: 'PENDIENTE' | 'APROBADA' | 'RECHAZADA';
  creada_en: string;
  resuelta_en?: string;
  resuelta_por?: string;
}

/** Fila del registro de operaciones (auditoría append-only JSONL). */
export interface RegistroOperacion {
  id_op: string;
  timestamp: string;
  mensaje_id: string | null;
  herramienta: NombreHerramienta;
  args: Record<string, unknown>;
  resultado: 'OK' | 'ERROR' | 'RECHAZADA_HUMANO';
  confianza: number | null;
  origen: OrigenDecision;
  detalle: string;
}
