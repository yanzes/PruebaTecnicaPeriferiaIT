/**
 * Herramientas de negocio del Reto 2 — Gestión Inteligente de Contratos.
 *
 * Cada herramienta:
 *  - Valida su ENTRADA con un esquema Zod (frontera estricta).
 *  - Ejecuta la lógica contra fixtures (buzón, maestro CSV, comerciales).
 *  - Devuelve un resultado tipado `ResultadoHerramienta<T>` (ok/error).
 *  - Registra la operación en el registro de auditoría JSONL (append-only)
 *    mediante `registrarOperacion` cuando corresponde (escrituras).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RUTAS, UMBRAL_OTROSI_DOBLE_APROBACION_COP, DOMINIOS_AUTORIZADOS, ahora } from '../config.js';
import type {
  Asesor,
  Contrato,
  MensajeBuzon,
  NombreHerramienta,
  RegistroOperacion,
} from '../types.js';

/* ------------------------------------------------------------------ */
/* Tipos de resultado                                                  */
/* ------------------------------------------------------------------ */

export type ResultadoHerramienta<T> = { ok: true; data: T } | { ok: false; error: string; codigo: CodigoError };

export type CodigoError =
  | 'ENTRADA_INVALIDA'
  | 'NO_ENCONTRADO'
  | 'DUPLICADO'
  | 'CONFLICTO'
  | 'NO_AUTORIZADO'
  | 'ERROR_IO';

/* ------------------------------------------------------------------ */
/* Esquemas Zod de entrada                                             */
/* ------------------------------------------------------------------ */

export const EsquemaListarMensajes = z.object({}).strict();

export const EsquemaLeerMensaje = z
  .object({ mensaje_id: z.string().regex(/^msg-\d{3}$/, 'Formato esperado: msg-00N') })
  .strict();

export const EsquemaConsultarMaestro = z
  .object({
    contrato_id: z.string().regex(/^CT-\d{4}-\d{3}$/).optional(),
    cliente: z.string().min(2).optional(),
    nit: z.string().min(3).optional(),
  })
  .strict()
  .refine((v) => v.contrato_id || v.cliente || v.nit, {
    message: 'Debe proporcionar contrato_id, cliente o nit',
  });

export const EsquemaValidarDuplicado = z
  .object({
    cliente: z.string().min(2),
    nit: z.string().optional(),
    fecha_inicio: z.string().optional(),
  })
  .strict();

export const EsquemaDetectarOtrosi = z
  .object({
    contrato_referenciado: z.string().regex(/^CT-\d{4}-\d{3}$/).optional(),
    cliente: z.string().optional(),
    nuevo_valor_mensual: z.number().positive().optional(),
    nueva_fecha_fin: z.string().optional(),
  })
  .strict()
  .refine((v) => v.contrato_referenciado || v.cliente, {
    message: 'Debe proporcionar contrato_referenciado o cliente',
  });

export const EsquemaResolverAsesor = z
  .object({
    email: z.string().email().optional(),
    nombre: z.string().min(2).optional(),
    zona: z.string().optional(),
  })
  .strict()
  .refine((v) => v.email || v.nombre || v.zona, {
    message: 'Debe proporcionar email, nombre o zona',
  });

export const EsquemaRegistrarContrato = z
  .object({
    cliente: z.string().min(2),
    nit: z.string().regex(/^\d{7,10}-\d$/),
    asesor_email: z.string().email(),
    valor_mensual_cop: z.number().positive(),
    monto_total_cop: z.number().positive(),
    fecha_inicio: z.string().date(),
    fecha_fin: z.string().date(),
    tipo: z.enum(['BASE', 'SUSCRIPCION']),
    mensaje_id: z.string().optional(),
    confianza: z.number().min(0).max(1).optional(),
    origen: z.enum(['AGENTE', 'HUMANO']).default('AGENTE'),
  })
  .strict();

export const EsquemaRegistrarOtrosi = z
  .object({
    contrato_id: z.string().regex(/^CT-\d{4}-\d{3}$/),
    nuevo_valor_mensual: z.number().positive().optional(),
    nuevo_monto_total: z.number().positive().optional(),
    nueva_fecha_fin: z.string().date().optional(),
    mensaje_id: z.string().optional(),
    confianza: z.number().min(0).max(1).optional(),
    origen: z.enum(['AGENTE', 'HUMANO']).default('AGENTE'),
  })
  .strict()
  .refine((v) => v.nuevo_valor_mensual !== undefined || v.nueva_fecha_fin !== undefined, {
    message: 'El otrosí debe modificar al menos el valor mensual o la fecha de fin',
  });

export const EsquemaRegistrarOperacion = z
  .object({
    herramienta: z.string().min(2),
    mensaje_id: z.string().nullable().default(null),
    args: z.record(z.unknown()).default({}),
    resultado: z.enum(['OK', 'ERROR', 'RECHAZADA_HUMANO']),
    confianza: z.number().min(0).max(1).nullable().default(null),
    origen: z.enum(['AGENTE', 'HUMANO']).default('AGENTE'),
    detalle: z.string().default(''),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Utilidades de carga y persistencia                                  */
/* ------------------------------------------------------------------ */

/** Error tipado del dominio de contratos. */
export class ContratosToolError extends Error {
  readonly codigo: CodigoError;
  constructor(codigo: CodigoError, mensaje: string) {
    super(mensaje);
    this.name = 'ContratosToolError';
    this.codigo = codigo;
  }
}

/** Envuelve una operación en ResultadoHerramienta capturando errores. */
function envolver<T>(fn: () => T): ResultadoHerramienta<T> {
  try {
    return { ok: true, data: fn() };
  } catch (error) {
    if (error instanceof ContratosToolError) {
      return { ok: false, error: error.message, codigo: error.codigo };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      codigo: 'ERROR_IO',
    };
  }
}

/** Convierte un error Zod en mensaje legible. */
function mensajeZod(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ');
}

/** Parsea una entrada con Zod y lanza ContratosToolError ENTRADA_INVALIDA. */
function parsear<T>(esquema: z.ZodType<T>, entrada: unknown): T {
  const r = esquema.safeParse(entrada);
  if (!r.success) throw new ContratosToolError('ENTRADA_INVALIDA', mensajeZod(r.error));
  return r.data;
}

/** Lee y parsea el maestro de contratos (CSV con cabecera fija). */
export function cargarMaestro(): Contrato[] {
  const crudo = fs.readFileSync(RUTAS.maestro, 'utf-8');
  const lineas = crudo.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lineas.length === 0) return [];
  const cabeceras = (lineas[0] ?? '').split(',').map((h) => h.trim());
  return lineas.slice(1).map((linea) => {
    const partes = linea.split(',');
    const fila: Record<string, string> = {};
    cabeceras.forEach((h, i) => {
      fila[h] = (partes[i] ?? '').trim();
    });
    return {
      id: fila['id'] ?? '',
      cliente: fila['cliente'] ?? '',
      nit: fila['nit'] ?? '',
      asesor_email: fila['asesor_email'] ?? '',
      valor_mensual_cop: Number(fila['valor_mensual_cop'] ?? 0),
      monto_total_cop: Number(fila['monto_total_cop'] ?? 0),
      fecha_inicio: fila['fecha_inicio'] ?? '',
      fecha_fin: fila['fecha_fin'] ?? '',
      estado: (fila['estado'] ?? 'ACTIVO') as Contrato['estado'],
      tipo: (fila['tipo'] ?? 'BASE') as Contrato['tipo'],
      version: Number(fila['version'] ?? 1),
    };
  });
}

/** Persiste el maestro completo (escritura atómica simple). */
function guardarMaestro(contratos: Contrato[]): void {
  const cabecera = 'id,cliente,nit,asesor_email,valor_mensual_cop,monto_total_cop,fecha_inicio,fecha_fin,estado,tipo,version';
  const lineas = contratos.map((c) =>
    [c.id, c.cliente, c.nit, c.asesor_email, c.valor_mensual_cop, c.monto_total_cop, c.fecha_inicio, c.fecha_fin, c.estado, c.tipo, c.version].join(','),
  );
  fs.writeFileSync(RUTAS.maestro, [cabecera, ...lineas, ''].join('\n'), 'utf-8');
}

/** Siguiente ID de contrato disponible (CT-AAAA-NNN, secuencial por año). */
function siguienteContratoId(contratos: Contrato[]): string {
  const anio = ahora().getFullYear();
  const prefijo = `CT-${anio}-`;
  const maximo = contratos
    .filter((c) => c.id.startsWith(prefijo))
    .map((c) => Number(c.id.slice(prefijo.length)))
    .reduce((a, b) => Math.max(a, b), 0);
  return `${prefijo}${String(maximo + 1).padStart(3, '0')}`;
}

/** Carga el directorio de asesores comerciales. */
export function cargarAsesores(): Asesor[] {
  const crudo = fs.readFileSync(RUTAS.comerciales, 'utf-8');
  const json = JSON.parse(crudo) as { asesores?: Asesor[] };
  return Array.isArray(json.asesores) ? json.asesores : [];
}

/** Normaliza cadenas para comparación difusa (minúsculas, sin acentos). */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Similitud 0..1 entre dos cadenas (bigramas de caracteres). */
function similitud(a: string, b: string): number {
  const sa = normalizar(a);
  const sb = normalizar(b);
  if (sa === sb) return 1;
  const bigramas = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigramas(sa);
  const mb = bigramas(sb);
  let interseccion = 0;
  for (const [bg, n] of ma) interseccion += Math.min(n, mb.get(bg) ?? 0);
  const total = (sa.length + sb.length - 2) / 2 || 1;
  return Math.min(1, interseccion / total);
}

/** Registro de operaciones: append-only JSONL. */
export function registrarOperacion(entrada: unknown): ResultadoHerramienta<RegistroOperacion> {
  return envolver(() => {
    const e = parsear(EsquemaRegistrarOperacion, entrada);
    const registro: RegistroOperacion = {
      id_op: `op-${ahora().getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: ahora().toISOString(),
      mensaje_id: e.mensaje_id ?? null,
      herramienta: e.herramienta as NombreHerramienta,
      args: e.args ?? {},
      resultado: e.resultado,
      confianza: e.confianza ?? null,
      origen: e.origen ?? 'AGENTE',
      detalle: e.detalle ?? '',
    };
    fs.appendFileSync(RUTAS.operaciones, `${JSON.stringify(registro)}\n`, 'utf-8');
    return registro;
  });
}

/** Envoltorio interno que audita escrituras sin ensuciar el API público. */
function auditar(
  herramienta: NombreHerramienta,
  mensajeId: string | null,
  args: Record<string, unknown>,
  resultado: 'OK' | 'ERROR' | 'RECHAZADA_HUMANO',
  confianza: number | null,
  origen: 'AGENTE' | 'HUMANO',
  detalle: string,
): void {
  const r = registrarOperacion({ herramienta, mensaje_id: mensajeId, args, resultado, confianza, origen, detalle });
  if (!r.ok) {
    // La auditoría nunca debe tumbar la operación principal; se deja rastro en stderr.
    console.error(`[auditoría] no se pudo registrar la operación: ${r.error}`);
  }
}

/* ------------------------------------------------------------------ */
/* HERRAMIENTAS — Buzón                                                */
/* ------------------------------------------------------------------ */

/** Parsea un archivo .md con front-matter `clave: valor` + cuerpo. */
function parsearMensaje(ruta: string, contenido: string): MensajeBuzon {
  const m = contenido.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new ContratosToolError('ERROR_IO', `El mensaje ${ruta} no tiene front-matter válido`);
  const meta = m[1] ?? '';
  const cuerpo = (m[2] ?? '').trim();
  const campos: Record<string, string> = {};
  for (const linea of meta.split(/\r?\n/)) {
    const idx = linea.indexOf(':');
    if (idx > 0) campos[linea.slice(0, idx).trim()] = linea.slice(idx + 1).trim().replace(/^"|"$/g, '');
  }
  const de = campos['de'] ?? '';
  const mm = de.match(/^(.*?)<([^>]+)>/);
  return {
    id: campos['id'] ?? path.basename(ruta, '.md'),
    de,
    remitente_nombre: (mm?.[1] ?? de).trim(),
    remitente_email: (mm?.[2] ?? de).trim().toLowerCase(),
    fecha: campos['fecha'] ?? '',
    asunto: campos['asunto'] ?? '',
    cuerpo,
  };
}

/** Lista los mensajes del buzón ordenados por id. */
export function listarMensajesBuzon(entrada: unknown): ResultadoHerramienta<Array<{ id: string; asunto: string; de: string }>> {
  return envolver(() => {
    parsear(EsquemaListarMensajes, entrada);
    return fs
      .readdirSync(RUTAS.buzon)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => {
        const msg = parsearMensaje(path.join(RUTAS.buzon, f), fs.readFileSync(path.join(RUTAS.buzon, f), 'utf-8'));
        return { id: msg.id, asunto: msg.asunto, de: msg.de };
      });
  });
}

/** Lee un mensaje del buzón completo. */
export function leerMensaje(entrada: unknown): ResultadoHerramienta<MensajeBuzon> {
  return envolver(() => {
    const { mensaje_id } = parsear(EsquemaLeerMensaje, entrada);
    const ruta = path.join(RUTAS.buzon, `${mensaje_id}.md`);
    if (!fs.existsSync(ruta)) {
      throw new ContratosToolError('NO_ENCONTRADO', `El mensaje ${mensaje_id} no existe en el buzón`);
    }
    return parsearMensaje(ruta, fs.readFileSync(ruta, 'utf-8'));
  });
}

/* ------------------------------------------------------------------ */
/* HERRAMIENTAS — Maestro y validaciones                               */
/* ------------------------------------------------------------------ */

/** Consulta el maestro por id exacto o búsqueda difusa por cliente/nit. */
export function consultarMaestro(
  entrada: unknown,
): ResultadoHerramienta<Array<{ contrato: Contrato; score: number }>> {
  return envolver(() => {
    const e = parsear(EsquemaConsultarMaestro, entrada);
    const contratos = cargarMaestro();
    if (e.contrato_id) {
      const exacto = contratos.filter((c) => c.id === e.contrato_id);
      if (exacto.length === 0) {
        throw new ContratosToolError('NO_ENCONTRADO', `No existe el contrato ${e.contrato_id} en el maestro`);
      }
      return exacto.map((contrato) => ({ contrato, score: 1 }));
    }
    const resultados = contratos
      .map((contrato) => {
        let score = 0;
        if (e.nit && contrato.nit === e.nit) score = 1;
        else if (e.cliente) {
          score = Math.max(score, similitud(e.cliente, contrato.cliente));
          if (e.nit && normalizar(contrato.nit).includes(normalizar(e.nit))) score = Math.max(score, 0.6);
        }
        return { contrato, score: Number(score.toFixed(3)) };
      })
      .filter((r) => r.score >= 0.4)
      .sort((a, b) => b.score - a.score);
    if (resultados.length === 0) {
      throw new ContratosToolError('NO_ENCONTRADO', 'Ningún contrato del maestro coincide con la consulta');
    }
    return resultados;
  });
}

/** Detecta si la solicitud corresponde a un contrato ya registrado. */
export function validarDuplicado(
  entrada: unknown,
): ResultadoHerramienta<{ duplicado: boolean; coincidencias: Array<{ contrato: Contrato; score: number }>; razon: string }> {
  return envolver(() => {
    const e = parsear(EsquemaValidarDuplicado, entrada);
    const contratos = cargarMaestro();
    const coincidencias = contratos
      .map((contrato) => {
        let score = 0;
        if (e.nit && contrato.nit === e.nit) score = 1;
        if (e.cliente) score = Math.max(score, similitud(e.cliente, contrato.cliente));
        const mismasFechas = e.fecha_inicio && contrato.fecha_inicio === e.fecha_inicio;
        return { contrato, score: Number(score.toFixed(3)), mismasFechas: Boolean(mismasFechas) };
      })
      .filter((r) => r.score >= 0.85)
      .map(({ contrato, score }) => ({ contrato, score }));
    return coincidencias.length > 0
      ? {
          duplicado: true,
          coincidencias,
          razon: `Existe un contrato registrado para el mismo cliente/NIT (mejor coincidencia: ${coincidencias[0]?.contrato.id ?? 'N/A'}).`,
        }
      : { duplicado: false, coincidencias: [], razon: 'No se encontraron contratos previos para este cliente/NIT.' };
  });
}

/** Compara la solicitud con el contrato referenciado y enumera cambios. */
export function detectarOtrosi(
  entrada: unknown,
): ResultadoHerramienta<{
  es_otrosi: boolean;
  contrato: Contrato | null;
  cambios: string[];
  requiere_doble_aprobacion: boolean;
}> {
  return envolver(() => {
    const e = parsear(EsquemaDetectarOtrosi, entrada);
    const contratos = cargarMaestro();
    let contrato: Contrato | undefined;
    if (e.contrato_referenciado) {
      contrato = contratos.find((c) => c.id === e.contrato_referenciado);
    } else if (e.cliente) {
      const mejor = contratos
        .map((c) => ({ c, s: similitud(e.cliente ?? '', c.cliente) }))
        .sort((a, b) => b.s - a.s)[0];
      if (mejor && mejor.s >= 0.85) contrato = mejor.c;
    }
    if (!contrato) {
      return { es_otrosi: false, contrato: null, cambios: [], requiere_doble_aprobacion: false };
    }
    const cambios: string[] = [];
    if (e.nuevo_valor_mensual !== undefined && e.nuevo_valor_mensual !== contrato.valor_mensual_cop) {
      cambios.push(
        `valor mensual: ${contrato.valor_mensual_cop.toLocaleString('es-CO')} → ${e.nuevo_valor_mensual.toLocaleString('es-CO')} COP`,
      );
    }
    if (e.nueva_fecha_fin !== undefined && e.nueva_fecha_fin !== contrato.fecha_fin) {
      cambios.push(`fecha de fin: ${contrato.fecha_fin} → ${e.nueva_fecha_fin}`);
    }
    return {
      es_otrosi: cambios.length > 0,
      contrato,
      cambios,
      requiere_doble_aprobacion: cambios.some((c) => c.startsWith('valor mensual') && (e.nuevo_valor_mensual ?? 0) > UMBRAL_OTROSI_DOBLE_APROBACION_COP),
    };
  });
}

/** Resuelve un asesor comercial por email (tolerando typos de dominio). */
export function resolverAsesor(
  entrada: unknown,
): ResultadoHerramienta<{ asesor: Asesor | null; score: number; nota: string }> {
  return envolver(() => {
    const e = parsear(EsquemaResolverAsesor, entrada);
    const asesores = cargarAsesores();
    let mejor: { asesor: Asesor; score: number } | undefined;
    for (const a of asesores) {
      let score = 0;
      if (e.email) {
        if (a.email === e.email) score = 1;
        else {
          const [usuario] = e.email.split('@');
          const [usuarioA] = a.email.split('@');
          const parteUsuario = usuario && usuarioA ? similitud(usuario, usuarioA) : 0;
          // El dominio mal escrito (periberia vs periferia) no invalida la persona.
          score = parteUsuario >= 0.9 ? 0.8 : Math.min(parteUsuario, 0.7);
        }
      }
      if (e.nombre) score = Math.max(score, similitud(e.nombre, a.nombre_completo));
      if (e.zona) score = Math.max(score, normalizar(e.zona) === normalizar(a.zona) ? 0.7 : 0);
      if (!mejor || score > mejor.score) mejor = { asesor: a, score };
    }
    if (!mejor || mejor.score < 0.5) {
      return { asesor: null, score: mejor?.score ?? 0, nota: 'No se pudo resolver el asesor con confianza suficiente.' };
    }
    const nota =
      mejor.asesor.email === e.email
        ? 'Resuelto por email exacto.'
        : `Resuelto por coincidencia parcial (${Math.round(mejor.score * 100)}%); verificar el email del directorio.`;
    const activo = mejor.asesor.activo ? '' : ' (ADVERTENCIA: el asesor está inactivo)';
    return { asesor: mejor.asesor, score: Number(mejor.score.toFixed(3)), nota: `${nota}${activo}` };
  });
}

/* ------------------------------------------------------------------ */
/* HERRAMIENTAS — Registro (escrituras)                                */
/* ------------------------------------------------------------------ */

/** Registra un contrato nuevo en el maestro (alta con validaciones). */
export function registrarContrato(entrada: unknown): ResultadoHerramienta<Contrato> {
  return envolver(() => {
    const e = parsear(EsquemaRegistrarContrato, entrada);
    // Regla de autorización: el asesor debe existir y estar activo.
    const resolucion = resolverAsesor({ email: e.asesor_email });
    if (resolucion.ok && resolucion.data.asesor === null && e.origen === 'AGENTE') {
      throw new ContratosToolError('NO_AUTORIZADO', `El asesor ${e.asesor_email} no consta en el directorio comercial`);
    }
    if (resolucion.ok && resolucion.data.asesor && !resolucion.data.asesor.activo) {
      throw new ContratosToolError('NO_AUTORIZADO', `El asesor ${e.asesor_email} está inactivo`);
    }
    const dominioOk = DOMINIOS_AUTORIZADOS.some((d) => e.asesor_email.endsWith(`@${d}`));
    if (!dominioOk && (e.origen ?? 'AGENTE') === 'AGENTE') {
      throw new ContratosToolError(
        'NO_AUTORIZADO',
        `El email del asesor no pertenece a un dominio autorizado (${DOMINIOS_AUTORIZADOS.join(', ')}); requiere origen HUMANO`,
      );
    }

    const contratos = cargarMaestro();
    // Regla anti-duplicado dura en la capa de escritura.
    const dup = contratos.find((c) => c.nit === e.nit || normalizar(c.cliente) === normalizar(e.cliente));
    if (dup) {
      throw new ContratosToolError(
        'DUPLICADO',
        `Ya existe el contrato ${dup.id} para este cliente/NIT; use registrarOtrosi para modificaciones`,
      );
    }
    if (e.fecha_fin <= e.fecha_inicio) {
      throw new ContratosToolError('CONFLICTO', 'La fecha de fin debe ser posterior a la fecha de inicio');
    }
    const nuevo: Contrato = {
      id: siguienteContratoId(contratos),
      cliente: e.cliente,
      nit: e.nit,
      asesor_email: e.asesor_email,
      valor_mensual_cop: e.valor_mensual_cop,
      monto_total_cop: e.monto_total_cop,
      fecha_inicio: e.fecha_inicio,
      fecha_fin: e.fecha_fin,
      estado: 'ACTIVO',
      tipo: e.tipo,
      version: 1,
    };
    guardarMaestro([...contratos, nuevo]);      auditar('registrarContrato', e.mensaje_id ?? null, { ...e }, 'OK', e.confianza ?? null, e.origen ?? 'AGENTE', `Alta del contrato ${nuevo.id} (${e.cliente})`);
    return nuevo;
  });
}

/** Aplica un otrosí (modificación) sobre un contrato existente. */
export function registrarOtrosi(entrada: unknown): ResultadoHerramienta<Contrato> {
  return envolver(() => {
    const e = parsear(EsquemaRegistrarOtrosi, entrada);
    const contratos = cargarMaestro();
    const contrato = contratos.find((c) => c.id === e.contrato_id);
    if (!contrato) {
      throw new ContratosToolError('NO_ENCONTRADO', `No existe el contrato ${e.contrato_id} en el maestro`);
    }
    if (contrato.estado === 'CERRADO' || contrato.estado === 'VENCIDO') {
      throw new ContratosToolError('CONFLICTO', `El contrato ${contrato.id} está ${contrato.estado}; no admite otrosíes`);
    }
    const nuevaFechaFin = e.nueva_fecha_fin ?? contrato.fecha_fin;
    if (nuevaFechaFin <= contrato.fecha_inicio) {
      throw new ContratosToolError('CONFLICTO', 'La nueva fecha de fin debe ser posterior a la fecha de inicio del contrato');
    }
    const dobleAprobacion =
      e.nuevo_valor_mensual !== undefined && e.nuevo_valor_mensual > UMBRAL_OTROSI_DOBLE_APROBACION_COP;
    const actualizado: Contrato = {
      ...contrato,
      valor_mensual_cop: e.nuevo_valor_mensual ?? contrato.valor_mensual_cop,
      monto_total_cop:
        e.nuevo_monto_total ??
        (e.nuevo_valor_mensual !== undefined
          ? Math.round((contrato.monto_total_cop / contrato.valor_mensual_cop) * e.nuevo_valor_mensual)
          : contrato.monto_total_cop),
      fecha_fin: nuevaFechaFin,
      estado: 'MODIFICADO',
      version: contrato.version + 1,
    };
    guardarMaestro(contratos.map((c) => (c.id === contrato.id ? actualizado : c)));
    auditar(
      'registrarOtrosi',
      e.mensaje_id ?? null,
      { ...e },
      'OK',
      e.confianza ?? null,
      e.origen ?? 'AGENTE',
      `Otrosí aplicado a ${contrato.id} (v${actualizado.version})${dobleAprobacion ? ' [DOBLE APROBACIÓN]' : ''}`,
    );
    return actualizado;
  });
}

/* ------------------------------------------------------------------ */
/* Catálogo de herramientas (para el agente y el LLM real)             */
/* ------------------------------------------------------------------ */

export interface DefinicionHerramienta {
  nombre: NombreHerramienta;
  descripcion: string;
  entrada: z.ZodTypeAny;
  ejecutar: (entrada: unknown) => ResultadoHerramienta<unknown>;
}

/** Catálogo completo de herramientas disponibles para el agente. */
export function catalogoHerramientas(): DefinicionHerramienta[] {
  return [
    { nombre: 'listarMensajesBuzon', descripcion: 'Lista los mensajes del buzón de entrada.', entrada: EsquemaListarMensajes, ejecutar: listarMensajesBuzon },
    { nombre: 'leerMensaje', descripcion: 'Lee un mensaje del buzón por id.', entrada: EsquemaLeerMensaje, ejecutar: leerMensaje },
    { nombre: 'consultarMaestro', descripcion: 'Consulta el maestro de contratos por id, cliente o NIT.', entrada: EsquemaConsultarMaestro, ejecutar: consultarMaestro },
    { nombre: 'validarDuplicado', descripcion: 'Detecta si un contrato ya está registrado (cliente/NIT).', entrada: EsquemaValidarDuplicado, ejecutar: validarDuplicado },
    { nombre: 'detectarOtrosi', descripcion: 'Compara una solicitud con el contrato referenciado y enumera cambios.', entrada: EsquemaDetectarOtrosi, ejecutar: detectarOtrosi },
    { nombre: 'resolverAsesor', descripcion: 'Resuelve el asesor comercial por email/nombre/zona.', entrada: EsquemaResolverAsesor, ejecutar: resolverAsesor },
    { nombre: 'registrarContrato', descripcion: 'Registra un contrato nuevo en el maestro.', entrada: EsquemaRegistrarContrato, ejecutar: registrarContrato },
    { nombre: 'registrarOtrosi', descripcion: 'Aplica un otrosí sobre un contrato existente.', entrada: EsquemaRegistrarOtrosi, ejecutar: registrarOtrosi },
    { nombre: 'registrarOperacion', descripcion: 'Registra una operación en la bitácora de auditoría JSONL.', entrada: EsquemaRegistrarOperacion, ejecutar: registrarOperacion },
  ];
}
