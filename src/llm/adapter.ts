/**
 * Puerto LLMAdapter + implementaciones: Simulado (determinista), OpenAI
 * (compatible con endpoints OpenAI-style) y Ollama (local).
 *
 * El resto del sistema solo depende del puerto; el modo se elige con la
 * variable de entorno LLM_MODO=simulado|openai|ollama.
 */
import type { ExtraccionContrato, MensajeBuzon } from '../types.js';
import { DOMINIOS_AUTORIZADOS, modoLlmDesdeEntorno } from '../config.js';

/** Mensaje de conversación genérico para el adaptador. */
export interface MensajeLlm {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Puerto del adaptador LLM: una única operación de extracción. */
export interface LLMAdapter {
  readonly nombre: string;
  /** Devuelve la extracción estructurada del mensaje del buzón. */
  extraer(mensaje: MensajeBuzon): Promise<ExtraccionContrato>;
}

/** Convierte texto del LLM en JSON tolerante a vallas de código. */
export function parseJsonTolerante(texto: string): unknown {
  const limpio = texto.replace(/```json|```/g, '').trim();
  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio === -1 || fin === -1 || fin <= inicio) {
    throw new Error('La respuesta del LLM no contiene un objeto JSON válido');
  }
  return JSON.parse(limpio.slice(inicio, fin + 1)) as unknown;
}

/** Normaliza un objeto crudo del LLM a ExtraccionContrato con valores seguros. */
export function normalizarExtraccion(crudo: unknown): ExtraccionContrato {
  const o = (crudo ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'string' ? Number(v.replace(/[^\d.-]/g, '')) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  const confCampos = (o.confianza_campos ?? {}) as Record<string, unknown>;
  const confianzaCampos: Record<string, number> = {};
  for (const [k, v] of Object.entries(confCampos)) {
    const n = num(v);
    if (n !== undefined) confianzaCampos[k] = Math.min(1, Math.max(0, n));
  }
  return {
    tipo_operacion:
      o.tipo_operacion === 'CONTRATO_NUEVO' || o.tipo_operacion === 'OTROSI' ? o.tipo_operacion : 'DESCONOCIDO',
    cliente: str(o.cliente),
    nit: str(o.nit),
    asesor_email: str(o.asesor_email),
    valor_mensual_cop: num(o.valor_mensual_cop),
    monto_total_cop: num(o.monto_total_cop),
    fecha_inicio: str(o.fecha_inicio),
    fecha_fin: str(o.fecha_fin),
    tipo_contrato: o.tipo_contrato === 'BASE' || o.tipo_contrato === 'SUSCRIPCION' ? o.tipo_contrato : undefined,
    contrato_referenciado: str(o.contrato_referenciado),
    confianza_campos: confianzaCampos,
    confianza_global: num(o.confianza_global) ?? 0.5,
    notas: Array.isArray(o.notas) ? (o.notas as unknown[]).filter((n): n is string => typeof n === 'string') : [],
  };
}

/** Instrucción de extracción reutilizable por los adaptadores reales. */
export const INSTRUCCION_EXTRACCION = `Eres un extractor de datos de contratos. Devuelve SOLO un objeto JSON con las claves:
tipo_operacion (CONTRATO_NUEVO|OTROSI|DESCONOCIDO), cliente, nit, asesor_email,
valor_mensual_cop (número), monto_total_cop (número), fecha_inicio (YYYY-MM-DD),
fecha_fin (YYYY-MM-DD), tipo_contrato (BASE|SUSCRIPCION), contrato_referenciado (ID CT-...),
confianza_campos (objeto campo->0..1), confianza_global (0..1), notas (lista de strings).
Omite las claves cuyo valor no aparezca en el texto. Los montos van en COP sin separadores.`;

/* ------------------------------------------------------------------ */
/* Heurísticas deterministas del adaptador SIMULADO                    */
/* ------------------------------------------------------------------ */

/** Números escritos en palabra usados en el dominio del reto. */
const NUMEROS_PALABRA: Record<string, number> = {
  un: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
  quince: 15, dieciseis: 16, dieciséis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintidós: 22,
  veinticuatro: 24, treinta: 30, 'treinta y seis': 36, 'cuarenta y ocho': 48,
};

/** Convierte montos escritos en palabras ("ocho millones quinientos mil") a número. */
function montoDesdePalabras(texto: string): number | undefined {
  const t = texto.toLowerCase();
  const m = t.match(/([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)\s*millones?/);
  if (m?.[1]) {
    const palabras = m[1].split(/\s+/);
    const ultimo = palabras[palabras.length - 1];
    const n = ultimo ? NUMEROS_PALABRA[ultimo] : undefined;
    if (n !== undefined) {
      let total = n * 1_000_000;
      const anterior = palabras.length >= 2 ? palabras[palabras.length - 2] : undefined;
      if (anterior && NUMEROS_PALABRA[anterior] !== undefined && n === 1) {
        // "veinticuatro millones" ya cubierto; "un millones" no aplica
      }
      if (/quinientos\s+mil/.test(t)) total += 500_000;
      return total;
    }
  }
  const miles = t.match(/([a-záéíóúñ]+)\s*mil(?!\w)/);
  if (miles?.[1] && NUMEROS_PALABRA[miles[1]] !== undefined) {
    return (NUMEROS_PALABRA[miles[1]] as number) * 1_000;
  }
  return undefined;
}

/** Extrae montos "COP 9.500.000" / "9,500,000" / "9500000" (>= 100.000). */
function montoDesdeCifra(texto: string): number | undefined {
  const matches = [...texto.matchAll(/(?:COP\s*)?(\d{1,3}(?:[.,]\d{3})+|\d{6,})/g)];
  for (const m of matches) {
    const n = Number((m[1] ?? '').replace(/[.,]/g, ''));
    if (Number.isFinite(n) && n >= 100_000) return n;
  }
  return undefined;
}

/** Quita NITs ("900123456-1") para que no se confundan con montos. */
function textoSinNits(texto: string): string {
  return texto.replace(/\b\d{7,10}-\d\b/g, '');
}

/** Detecta el ID de contrato CT-AAAA-NNN citado en el texto. */
function idContratoEn(texto: string): string | undefined {
  return texto.match(/\bCT-\d{4}-\d{3}\b/)?.[0];
}

/** Extrae fechas dd/mm/yyyy → ISO (también acepta ISO directo). */
function fechasISO(texto: string): string[] {
  const res: string[] = [];
  for (const m of texto.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const d = m[1] ?? '';
    const mes = m[2] ?? '';
    const y = m[3] ?? '';
    res.push(`${y}-${mes.padStart(2, '0')}-${d.padStart(2, '0')}`);
  }
  if (res.length === 0) {
    const iso = texto.match(/\b\d{4}-\d{2}-\d{2}\b/);
    if (iso) res.push(iso[0]);
  }
  return res;
}

/** Extrae el primer email del texto, priorizando dominios autorizados. */
function emailAsesor(texto: string): string | undefined {
  const matches = [...texto.matchAll(/[\w.-]+@[\w.-]+\.\w+/g)].map((m) => m[0].toLowerCase());
  return matches.find((e) => DOMINIOS_AUTORIZADOS.some((d) => e.endsWith(`@${d}`))) ?? matches[0];
}

/** Detecta NIT "900123456-1" o pistas parciales ("termina en -9"). */
function detectarNit(texto: string): { nit?: string; parcial: boolean } {
  const completo = texto.match(/\b(\d{7,10}-\d)\b/);
  if (completo?.[1]) return { nit: completo[1], parcial: false };
  if (/termina en\s*-?\d/i.test(texto) || /sin nit|no lo tengo a la mano/i.test(texto)) {
    return { parcial: true };
  }
  return { parcial: false };
}

/** Extrae el nombre del cliente descartando IDs de contrato en negrilla. */
function extraerCliente(texto: string): string | undefined {
  const candidatos: string[] = [];
  for (const m of texto.matchAll(/\*\*([^*]+)\*\*/g)) candidatos.push((m[1] ?? '').trim());
  const mCon = texto.match(/contrato\s+[A-Z0-9-]+\s+con\s+([A-ZÁÉÍÓÚÑ][^,\n]*?(?:S\.A\.S\.|Ltda|S\.A\.))/);
  if (mCon?.[1]) candidatos.push(mCon[1].trim());
  const mDe = texto.match(/\bde\s+([A-ZÁÉÍÓÚÑ][^,\n]*?(?:S\.A\.S\.|Ltda|S\.A\.))/);
  if (mDe?.[1]) candidatos.push(mDe[1].trim());
  return candidatos.find((c) => c.length > 2 && !/^CT-\d{4}-\d{3}$/.test(c));
}

/**
 * Adaptador SIMULADO: reproduce con reglas deterministas el comportamiento
 * que se espera del LLM. Es el modo por defecto del demo (offline y $0).
 */
export class AdaptadorSimulado implements LLMAdapter {
  readonly nombre = 'simulado';

  async extraer(mensaje: MensajeBuzon): Promise<ExtraccionContrato> {
    const texto = `${mensaje.asunto}\n${mensaje.cuerpo}`;
    const notas: string[] = [];
    const confianzaCampos: Record<string, number> = {};

    // 1) ¿Es un correo relevante para el dominio de contratos?
    const palabrasClave = ['contrato', 'otrosí', 'otrosi', 'nit', 'vigencia', 'cop', 'formalización'];
    const hits = palabrasClave.filter((p) => texto.toLowerCase().includes(p));
    if (hits.length === 0) {
      return {
        tipo_operacion: 'DESCONOCIDO',
        confianza_campos: {},
        confianza_global: 0.95,
        notas: ['El correo no contiene términos propios de gestión de contratos.'],
      };
    }

    const tipo: 'CONTRATO_NUEVO' | 'OTROSI' = /otros[íi]/i.test(texto) ? 'OTROSI' : 'CONTRATO_NUEVO';
    confianzaCampos['tipo_operacion'] = 0.9;

    const ref = idContratoEn(texto);
    if (ref) confianzaCampos['contrato_referenciado'] = 0.98;

    const { nit, parcial } = detectarNit(texto);
    if (nit) {
      confianzaCampos['nit'] = 0.95;
    } else if (parcial) {
      confianzaCampos['nit'] = 0.3;
      notas.push('NIT no proporcionado; el remitente da solo una pista parcial.');
    }

    const cliente = extraerCliente(texto);
    if (cliente) {
      confianzaCampos['cliente'] = 0.85;
    } else {
      notas.push('Nombre del cliente no identificado con claridad.');
    }

    const asesor = emailAsesor(texto);
    if (asesor) {
      const autorizado = DOMINIOS_AUTORIZADOS.some((d) => asesor.endsWith(`@${d}`));
      confianzaCampos['asesor_email'] = autorizado ? 0.9 : 0.45;
      if (!autorizado) notas.push(`El correo ${asesor} no pertenece a un dominio autorizado de Periferia.`);
    } else {
      notas.push('No se identificó asesor comercial en el correo.');
    }

    // Montos: se calculan sobre el texto sin NITs para evitar falsos positivos.
    const limpio = textoSinNits(texto);
    const segmentoValor =
      texto.split(/nuevo valor mensual|valor mensual|valor sería|sería de/i)[1] ?? limpio;
    let valorMensual = montoDesdeCifra(segmentoValor) ?? montoDesdePalabras(limpio);
    if (valorMensual !== undefined) {
      const explicito = /al mes|mensual/i.test(texto);
      const aproximado = /\bunos\b|aprox|más o menos/i.test(segmentoValor);
      confianzaCampos['valor_mensual_cop'] = explicito ? (aproximado ? 0.7 : 0.9) : 0.55;
      if (aproximado) notas.push('El valor mensual está expresado de forma aproximada.');
      else if (!explicito) notas.push('El valor mensual se infirió del contexto; no está explícito.');
    }

    const montos = [...limpio.matchAll(/(?:COP\s*)?(\d{1,3}(?:[.,]\d{3})+|\d{6,})/g)]
      .map((m) => Number((m[1] ?? '').replace(/[.,]/g, '')))
      .filter((n) => n >= 1_000_000);
    const montoTotal = montos.sort((a, b) => b - a)[0];
    if (montoTotal !== undefined && montoTotal !== valorMensual) {
      confianzaCampos['monto_total_cop'] = 0.85;
    }

    // Fechas explícitas dd/mm/yyyy; si no, inferencia relativa controlada.
    const fechas = fechasISO(limpio);
    let fechaInicio: string | undefined;
    let fechaFin: string | undefined;
    if (fechas.length >= 2) {
      fechaInicio = fechas[0];
      fechaFin = fechas[1];
      confianzaCampos['fecha_inicio'] = 0.92;
      confianzaCampos['fecha_fin'] = 0.92;
    } else if (fechas.length === 1) {
      fechaFin = fechas[0];
      confianzaCampos['fecha_fin'] = 0.7;
      notas.push('Solo se encontró una fecha; se asume como nueva fecha de terminación.');
    } else {
      if (/primer[o]?\s+del\s+mes\s+entrante/i.test(texto)) {
        const ahoraUtc = new Date(mensaje.fecha);
        const anio = ahoraUtc.getUTCFullYear();
        const mes = ahoraUtc.getUTCMonth();
        fechaInicio = new Date(Date.UTC(anio, mes + 1, 1)).toISOString().slice(0, 10);
        confianzaCampos['fecha_inicio'] = 0.6;
        notas.push('Fecha de inicio inferida de "primero del mes entrante".');
      }
      const dur = texto.match(/duraci[oó]n de ([a-záéíóúñ]+) meses/i);
      const meses = dur?.[1] ? NUMEROS_PALABRA[dur[1].toLowerCase()] : undefined;
      if (fechaInicio && meses !== undefined) {
        const [y, m, d] = fechaInicio.split('-').map(Number);
        const fin = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
        fin.setUTCMonth(fin.getUTCMonth() + meses);
        fechaFin = fin.toISOString().slice(0, 10);
        confianzaCampos['fecha_fin'] = 0.55;
        notas.push('Fecha de fin inferida de la duración en meses.');
      }
    }

    const tipoContrato = /suscripci[oó]n/i.test(texto) ? 'SUSCRIPCION' : 'BASE';

    // Confianza global: promedio de campos con penalizaciones explícitas.
    const valores = Object.values(confianzaCampos);
    const promedio = valores.length > 0 ? valores.reduce((a, b) => a + b, 0) / valores.length : 0.5;
    let global = promedio;
    if (parcial) global -= 0.15;
    const remitenteAutorizado = DOMINIOS_AUTORIZADOS.some((d) => mensaje.remitente_email.endsWith(`@${d}`));
    if (!remitenteAutorizado) global -= 0.12;
    if (tipo === 'OTROSI' && !ref) {
      global -= 0.2;
      notas.push('Otrosí sin referencia válida a un contrato existente.');
    }
    global = Math.min(1, Math.max(0, Number(global.toFixed(2))));

    return {
      tipo_operacion: tipo,
      cliente,
      nit,
      asesor_email: asesor,
      valor_mensual_cop: valorMensual,
      monto_total_cop: montoTotal !== undefined && montoTotal !== valorMensual ? montoTotal : undefined,
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      tipo_contrato: tipoContrato,
      contrato_referenciado: ref,
      confianza_campos: confianzaCampos,
      confianza_global: global,
      notas,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Adaptador OpenAI-compatible (activable con LLM_MODO=openai)         */
/* ------------------------------------------------------------------ */

export class AdaptadorOpenAI implements LLMAdapter {
  readonly nombre = 'openai';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelo: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string; modelo?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = opts?.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    this.modelo = opts?.modelo ?? process.env.OPENAI_MODELO ?? 'gpt-4o-mini';
    if (!this.apiKey) throw new Error('OPENAI_API_KEY no está definida');
  }

  async extraer(mensaje: MensajeBuzon): Promise<ExtraccionContrato> {
    const respuesta = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelo,
        temperature: 0,
        messages: [
          { role: 'system', content: INSTRUCCION_EXTRACCION },
          {
            role: 'user',
            content: `De: ${mensaje.remitente_nombre} <${mensaje.remitente_email}>\nAsunto: ${mensaje.asunto}\n\n${mensaje.cuerpo}`,
          },
        ],
      }),
    });
    if (!respuesta.ok) {
      throw new Error(`OpenAI respondió ${respuesta.status}: ${await respuesta.text()}`);
    }
    const json = (await respuesta.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const contenido = json.choices?.[0]?.message?.content ?? '';
    return normalizarExtraccion(parseJsonTolerante(contenido));
  }
}

/* ------------------------------------------------------------------ */
/* Adaptador Ollama local (activable con LLM_MODO=ollama)              */
/* ------------------------------------------------------------------ */

export class AdaptadorOllama implements LLMAdapter {
  readonly nombre = 'ollama';
  private readonly baseUrl: string;
  private readonly modelo: string;

  constructor(opts?: { baseUrl?: string; modelo?: string }) {
    this.baseUrl = opts?.baseUrl ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
    this.modelo = opts?.modelo ?? process.env.OLLAMA_MODELO ?? 'llama3.1';
  }

  async extraer(mensaje: MensajeBuzon): Promise<ExtraccionContrato> {
    const respuesta = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelo,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: INSTRUCCION_EXTRACCION },
          {
            role: 'user',
            content: `De: ${mensaje.remitente_nombre} <${mensaje.remitente_email}>\nAsunto: ${mensaje.asunto}\n\n${mensaje.cuerpo}`,
          },
        ],
      }),
    });
    if (!respuesta.ok) {
      throw new Error(`Ollama respondió ${respuesta.status}: ${await respuesta.text()}`);
    }
    const json = (await respuesta.json()) as { message?: { content?: string } };
    return normalizarExtraccion(parseJsonTolerante(json.message?.content ?? ''));
  }
}

/** Fábrica del adaptador según el modo configurado. */
export function crearAdaptador(modo = modoLlmDesdeEntorno()): LLMAdapter {
  switch (modo) {
    case 'openai':
      return new AdaptadorOpenAI();
    case 'ollama':
      return new AdaptadorOllama();
    case 'simulado':
    default:
      return new AdaptadorSimulado();
  }
}
