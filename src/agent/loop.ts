/**
 * Ciclo del agente de contratos: percibir → extraer → validar → decidir →
 * actuar → auditar. Emite eventos en cada paso (para consola, UI o auditoría)
 * y solicita confirmación humana (HITL) cuando la confianza o las reglas de
 * gobierno no permiten actuar de forma automática.
 *
 * El agente depende del puerto LLMAdapter; con el adaptador simulado el ciclo
 * es 100% determinista (modo demo), y con OpenAI/Ollama se comporta igual
 * pero con extracción neuronal real.
 */
import { UMBRALES, UMBRAL_OTROSI_DOBLE_APROBACION_COP, DOMINIOS_AUTORIZADOS, ahora } from '../config.js';
import type { LLMAdapter } from '../llm/adapter.js';
import {
  leerMensaje,
  validarDuplicado,
  detectarOtrosi,
  resolverAsesor,
  registrarContrato,
  registrarOtrosi,
  registrarOperacion,
  type ResultadoHerramienta,
} from '../tools/contratos.js';
import { crearSolicitud, resolverSolicitud } from './hitl.js';
import type {
  AccionPropuesta,
  Contrato,
  DecisionAgente,
  EventoAgente,
  ExtraccionContrato,
  MensajeBuzon,
  SolicitudHitl,
} from '../types.js';

/** Oyente de eventos (consola en el demo, SSE en el servidor web). */
export type OyenteEventos = (evento: EventoAgente) => void;

export interface TurnoResultado {
  mensaje_id: string;
  clasificacion: DecisionAgente['clasificacion'];
  confianza: number;
  nivel: 'ALTA' | 'MEDIA' | 'BAJA';
  acciones_ejecutadas: Array<{ herramienta: string; ok: boolean; resumen: string }>;
  hitl: SolicitudHitl | null;
  justificacion: string;
}

/** Callback de confirmación humana: devuelve true si el humano aprueba. */
export type ConfirmadorHumano = (solicitud: SolicitudHitl) => Promise<boolean>;

export interface OpcionesAgente {
  adaptador: LLMAdapter;
  oyente?: OyenteEventos;
  /** Confirmador humano; si se omite, el modo es no-interactivo (demo usa el suyo). */
  confirmador?: ConfirmadorHumano;
  /** Nombre del operador que resuelve HITL (para auditoría). */
  operador?: string;
}

/** Emite un evento al oyente registrando el instante. */
function emitir(oyente: OyenteEventos | undefined, tipo: EventoAgente['tipo'], mensajeId: string | null, data: unknown): void {
  if (!oyente) return;
  oyente({ tipo, mensaje_id: mensajeId, timestamp: ahora().toISOString(), data });
}

/** Nivel de confianza a partir del score. */
function nivel(score: number): 'ALTA' | 'MEDIA' | 'BAJA' {
  if (score >= UMBRALES.auto) return 'ALTA';
  if (score >= UMBRALES.media) return 'MEDIA';
  return 'BAJA';
}

/** Serializa un resultado de herramienta para eventos/auditoría. */
function resumenResultado<T>(r: ResultadoHerramienta<T>): string {
  return r.ok ? JSON.stringify(r.data) : `ERROR[${r.codigo}]: ${r.error}`;
}

/**
 * Procesa un mensaje del buzón y ejecuta el ciclo completo.
 * Devuelve el resumen del turno para consola/UI.
 */
export async function procesarMensaje(mensajeId: string, opciones: OpcionesAgente): Promise<TurnoResultado> {
  const { adaptador, oyente, confirmador } = opciones;
  const accionesEjecutadas: TurnoResultado['acciones_ejecutadas'] = [];
  let hitlCreada: SolicitudHitl | null = null;
  let justificacionFinal = '';

  emitir(oyente, 'turno_inicio', mensajeId, { mensaje_id: mensajeId });

  // 1) PERCIBIR — leer el mensaje del buzón.
  const lectura = leerMensaje({ mensaje_id: mensajeId });
  if (!lectura.ok) {
    emitir(oyente, 'error', mensajeId, lectura);
    registrarOperacion({
      herramienta: 'leerMensaje',
      mensaje_id: mensajeId,
      args: { mensaje_id: mensajeId },
      resultado: 'ERROR',
      confianza: null,
      origen: 'AGENTE',
      detalle: lectura.error,
    });
    return {
      mensaje_id: mensajeId,
      clasificacion: 'NO_RELEVANTE',
      confianza: 0,
      nivel: 'BAJA',
      acciones_ejecutadas: [{ herramienta: 'leerMensaje', ok: false, resumen: lectura.error }],
      hitl: null,
      justificacion: `No se pudo leer el mensaje: ${lectura.error}`,
    };
  }
  const mensaje: MensajeBuzon = lectura.data;
  emitir(oyente, 'tool_call', mensajeId, { herramienta: 'leerMensaje', args: { mensaje_id: mensajeId } });
  emitir(oyente, 'tool_result', mensajeId, { herramienta: 'leerMensaje', resultado: mensaje });

  try {
    // 2) EXTRAER — entidades + confianza por campo (vía adaptador LLM/simulado).
    const ex = await adaptador.extraer(mensaje);
    emitir(oyente, 'extraccion', mensajeId, ex);
    emitir(oyente, 'confianza', mensajeId, { global: ex.confianza_global, campos: ex.confianza_campos, notas: ex.notas });

    // 3) CLASIFICAR + VALIDAR — consultas al maestro según el tipo de operación.
    let decision: DecisionAgente;

    if (ex.tipo_operacion === 'DESCONOCIDO') {
      decision = {
        clasificacion: 'NO_RELEVANTE',
        confianza: ex.confianza_global,
        acciones: [],
        justificacion: 'El correo no corresponde a gestión de contratos; se archiva sin acciones.',
      };
    } else if (ex.tipo_operacion === 'OTROSI') {
      const deteccion = detectarOtrosi({
        contrato_referenciado: ex.contrato_referenciado,
        cliente: ex.cliente,
        nuevo_valor_mensual: ex.valor_mensual_cop,
        nueva_fecha_fin: ex.fecha_fin,
      });
      emitir(oyente, 'tool_call', mensajeId, {
        herramienta: 'detectarOtrosi',
        args: { contrato_referenciado: ex.contrato_referenciado, cliente: ex.cliente },
      });
      emitir(oyente, 'tool_result', mensajeId, { herramienta: 'detectarOtrosi', resultado: deteccion });

      if (!deteccion.ok || !deteccion.data.es_otrosi || !deteccion.data.contrato) {
        // Otrosí sin contrato válido: excepción controlada → escalamiento.
        const razon = !deteccion.ok
          ? deteccion.error
          : deteccion.data.contrato === null
            ? `El contrato referenciado (${ex.contrato_referenciado ?? 'no especificado'}) no existe en el maestro`
            : 'La solicitud no introduce cambios respecto al contrato actual';
        decision = {
          clasificacion: 'OTROSI',
          confianza: Math.min(ex.confianza_global, 0.5),
          acciones: [
            {
              herramienta: 'registrarOtrosi',
              args: { contrato_id: ex.contrato_referenciado ?? null, mensaje_id: mensaje.id, origen: 'AGENTE' },
              tipo: 'ESCALAR',
              requiere_confirmacion: true,
              razon_confirmacion: `EXCEPCIÓN — ${razon}`,
            },
          ],
          justificacion: `EXCEPCIÓN — ${razon}. Se escala a un humano; no se aplica ningún cambio.`,
        };
      } else {
        const { contrato, cambios, requiere_doble_aprobacion } = deteccion.data;
        const acciones: AccionPropuesta[] = [
          {
            herramienta: 'registrarOtrosi',
            args: {
              contrato_id: contrato.id,
              nuevo_valor_mensual: ex.valor_mensual_cop,
              nueva_fecha_fin: ex.fecha_fin,
              mensaje_id: mensaje.id,
              confianza: ex.confianza_global,
              origen: 'AGENTE',
            },
            requiere_confirmacion: ex.confianza_global < UMBRALES.auto || requiere_doble_aprobacion,
            razon_confirmacion: requiere_doble_aprobacion
              ? `El valor del otrosí supera el umbral de doble aprobación (COP ${UMBRAL_OTROSI_DOBLE_APROBACION_COP.toLocaleString('es-CO')})`
              : ex.confianza_global < UMBRALES.auto
                ? `Confianza ${ex.confianza_global} por debajo del umbral automático (${UMBRALES.auto})`
                : undefined,
          },
        ];
        decision = {
          clasificacion: 'OTROSI',
          confianza: ex.confianza_global,
          acciones,
          justificacion: `Otrosí sobre ${contrato.id}: ${cambios.join('; ') || 'sin cambios detectados'}.`,
        };
      }
    } else {
      // CONTRATO_NUEVO: duplicados + resolución del asesor.
      const dup = validarDuplicado({ cliente: ex.cliente ?? '', nit: ex.nit, fecha_inicio: ex.fecha_inicio });
      emitir(oyente, 'tool_call', mensajeId, { herramienta: 'validarDuplicado', args: { cliente: ex.cliente, nit: ex.nit } });
      emitir(oyente, 'tool_result', mensajeId, { herramienta: 'validarDuplicado', resultado: dup });

      if (dup.ok && dup.data.duplicado) {
        decision = {
          clasificacion: 'CONTRATO_NUEVO',
          confianza: ex.confianza_global,
          acciones: [],
          justificacion: `DUPLICADO BLOQUEADO — ${dup.data.razon} No se registra nada.`,
        };
      } else {
        const asesor = ex.asesor_email ? resolverAsesor({ email: ex.asesor_email }) : null;
        if (asesor) {
          emitir(oyente, 'tool_call', mensajeId, { herramienta: 'resolverAsesor', args: { email: ex.asesor_email } });
          emitir(oyente, 'tool_result', mensajeId, { herramienta: 'resolverAsesor', resultado: asesor });
        }
        const asesorResuelto = asesor?.ok === true && asesor.data.asesor !== null;
        const dominioOk = ex.asesor_email ? DOMINIOS_AUTORIZADOS.some((d) => ex.asesor_email?.endsWith(`@${d}`)) : false;

        let confianza = ex.confianza_global;
        const riesgos: string[] = [];
        if (!ex.nit) {
          confianza -= 0.1;
          riesgos.push('NIT del cliente ausente o parcial');
        }
        if (!asesorResuelto) riesgos.push('Asesor comercial no identificado en el directorio');
        if (!dominioOk) riesgos.push('Remitente fuera del dominio autorizado de Periferia');
        if (!ex.fecha_inicio || !ex.fecha_fin) riesgos.push('Vigencia incompleta');
        if (!ex.valor_mensual_cop || !ex.monto_total_cop) riesgos.push('Montos ausentes o inferidos del texto');
        confianza = Math.max(0, Number(confianza.toFixed(2)));

        const completa =
          Boolean(ex.cliente && ex.nit && ex.fecha_inicio && ex.fecha_fin && ex.valor_mensual_cop && ex.monto_total_cop) &&
          asesorResuelto &&
          dominioOk;

        const requiereHITL = !completa || confianza < UMBRALES.auto;
        const razonHITL = requiereHITL ? riesgos.join('; ') : undefined;

        const acciones: AccionPropuesta[] = completa
          ? [
              {
                herramienta: 'registrarContrato',
                args: {
                  cliente: ex.cliente,
                  nit: ex.nit,
                  asesor_email: ex.asesor_email,
                  valor_mensual_cop: ex.valor_mensual_cop,
                  monto_total_cop: ex.monto_total_cop,
                  fecha_inicio: ex.fecha_inicio,
                  fecha_fin: ex.fecha_fin,
                  tipo: ex.tipo_contrato ?? 'BASE',
                  mensaje_id: mensaje.id,
                  confianza,
                  origen: 'AGENTE',
                },
                requiere_confirmacion: requiereHITL,
                razon_confirmacion: razonHITL,
              },
            ]
          : [];
        if (!completa && confianza < UMBRALES.media) {
          // Confianza baja + datos incompletos: escalamiento directo (no auto-ejecuta).
          acciones.push({
            herramienta: 'registrarContrato',
            args: { cliente: ex.cliente ?? null, mensaje_id: mensaje.id, origen: 'AGENTE' },
            tipo: 'ESCALAR',
            requiere_confirmacion: true,
            razon_confirmacion: `Datos insuficientes y confianza ${confianza} < ${UMBRALES.media}: ${riesgos.join('; ')}`,
          });
        }
        decision = {
          clasificacion: confianza < UMBRALES.media ? 'AMBIGUO' : 'CONTRATO_NUEVO',
          confianza,
          acciones,
          justificacion: completa
            ? requiereHITL
              ? `Datos completos pero con riesgos: ${razonHITL}`
              : 'Datos completos, asesor autorizado y sin duplicados: alta automática.'
            : `Datos incompletos o no verificables: ${riesgos.join('; ') || 'faltan campos obligatorios'}.`,
        };
      }
    }

    emitir(oyente, 'clasificacion', mensajeId, {
      clasificacion: decision.clasificacion,
      confianza: decision.confianza,
      nivel: nivel(decision.confianza),
      justificacion: decision.justificacion,
    });

    // 4) DECIDIR + ACTUAR — auto si confianza ALTA y sin riesgos; si no, HITL.
    if (decision.acciones.length === 0) {
      emitir(oyente, 'decision', mensajeId, { accion: 'NINGUNA', justificacion: decision.justificacion });
      justificacionFinal = decision.justificacion;
      registrarOperacion({
        herramienta: 'cicloAgente',
        mensaje_id: mensaje.id,
        args: { clasificacion: decision.clasificacion },
        resultado: 'OK',
        confianza: decision.confianza,
        origen: 'AGENTE',
        detalle: decision.justificacion,
      });
    } else {
      for (const accion of decision.acciones) {
        if (accion.tipo === 'ESCALAR') {
          // Acción de escalamiento: crea la solicitud y no ejecuta nada.
          const solicitud = crearSolicitud({
            mensaje_id: mensaje.id,
            tipo: accion.herramienta === 'registrarContrato' ? 'REGISTRO_CONTRATO' : 'REGISTRO_OTROSI',
            resumen: accion.razon_confirmacion ?? decision.justificacion,
            extraccion: ex,
            riesgos: accion.razon_confirmacion ? [accion.razon_confirmacion] : [],
          });
          hitlCreada = solicitud;
          emitir(oyente, 'hitl_request', mensajeId, solicitud);
          registrarOperacion({
            herramienta: accion.herramienta,
            mensaje_id: mensaje.id,
            args: accion.args,
            resultado: 'RECHAZADA_HUMANO',
            confianza: decision.confianza,
            origen: 'AGENTE',
            detalle: `Escalado a humano como ${solicitud.id}: ${accion.razon_confirmacion ?? ''}`,
          });
          accionesEjecutadas.push({ herramienta: accion.herramienta, ok: false, resumen: `ESCALADO A HUMANO (${solicitud.id})` });
          justificacionFinal = `Escalado a revisión humana (${solicitud.id}): ${accion.razon_confirmacion ?? decision.justificacion}`;
          continue;
        }
        if (accion.requiere_confirmacion && confirmador) {
          const solicitud = crearSolicitud({
            mensaje_id: mensaje.id,
            tipo: accion.herramienta === 'registrarContrato' ? 'REGISTRO_CONTRATO' : 'REGISTRO_OTROSI',
            resumen: decision.justificacion,
            extraccion: ex,
            riesgos: accion.razon_confirmacion ? [accion.razon_confirmacion] : [],
          });
          hitlCreada = solicitud;
          emitir(oyente, 'hitl_request', mensajeId, solicitud);
          const aprobada = await confirmador(solicitud);
          resolverSolicitud(solicitud.id, aprobada, opciones.operador ?? 'operador-web');
          emitir(oyente, 'hitl_resuelta', mensajeId, { id: solicitud.id, aprobada });
          if (!aprobada) {
            registrarOperacion({
              herramienta: accion.herramienta,
              mensaje_id: mensaje.id,
              args: accion.args,
              resultado: 'RECHAZADA_HUMANO',
              confianza: decision.confianza,
              origen: 'HUMANO',
              detalle: 'El operador rechazó la acción propuesta',
            });
            accionesEjecutadas.push({ herramienta: accion.herramienta, ok: false, resumen: 'RECHAZADA POR HUMANO' });
            justificacionFinal = 'La acción fue rechazada por el operador humano.';
            continue;
          }
        } else if (accion.requiere_confirmacion && !confirmador) {
          // Sin confirmador disponible: se deja pendiente y no se actúa.
          const solicitud = crearSolicitud({
            mensaje_id: mensaje.id,
            tipo: accion.herramienta === 'registrarContrato' ? 'REGISTRO_CONTRATO' : 'REGISTRO_OTROSI',
            resumen: decision.justificacion,
            extraccion: ex,
            riesgos: accion.razon_confirmacion ? [accion.razon_confirmacion] : [],
          });
          hitlCreada = solicitud;
          emitir(oyente, 'hitl_request', mensajeId, solicitud);
          justificacionFinal = `Se dejó la solicitud ${solicitud.id} pendiente de confirmación humana.`;
          continue;
        }

        const resultado = ejecutarAccion(accion, ex);
        emitir(oyente, 'tool_call', mensajeId, { herramienta: accion.herramienta, args: accion.args });
        emitir(oyente, 'tool_result', mensajeId, { herramienta: accion.herramienta, resultado });
        accionesEjecutadas.push({
          herramienta: accion.herramienta,
          ok: resultado.ok,
          resumen: resumenResultado(resultado),
        });
        justificacionFinal = resultado.ok
          ? `Acción ejecutada automáticamente: ${decision.justificacion}`
          : `La acción falló: ${resultado.error}`;
      }
    }

    emitir(oyente, 'decision', mensajeId, { accion: hitlCreada ? 'HITL' : 'EJECUTADA', justificacion: justificacionFinal });
    emitir(oyente, 'turno_fin', mensajeId, { acciones: accionesEjecutadas, hitl: hitlCreada?.id ?? null });

    return {
      mensaje_id: mensaje.id,
      clasificacion: decision.clasificacion,
      confianza: decision.confianza,
      nivel: nivel(decision.confianza),
      acciones_ejecutadas: accionesEjecutadas,
      hitl: hitlCreada,
      justificacion: justificacionFinal,
    };
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    emitir(oyente, 'error', mensajeId, { detalle });
    registrarOperacion({
      herramienta: 'cicloAgente',
      mensaje_id: mensaje.id,
      args: { mensaje_id: mensaje.id },
      resultado: 'ERROR',
      confianza: null,
      origen: 'AGENTE',
      detalle,
    });
    return {
      mensaje_id: mensaje.id,
      clasificacion: 'AMBIGUO',
      confianza: 0,
      nivel: 'BAJA',
      acciones_ejecutadas: [],
      hitl: null,
      justificacion: `ERROR DEL CICLO: ${detalle}`,
    };
  }
}

/** Ejecuta una acción propuesta contra la herramienta correspondiente. */
function ejecutarAccion(accion: AccionPropuesta, ex: ExtraccionContrato): ResultadoHerramienta<Contrato> {
  if (accion.herramienta === 'registrarContrato') {
    return registrarContrato(accion.args);
  }
  return registrarOtrosi({ ...accion.args, nuevo_monto_total: ex.monto_total_cop });
}
