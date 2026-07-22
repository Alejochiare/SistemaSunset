/* ============================================================
   VISTA · Alquileres Temporales
   ============================================================ */
import { getState, actions, subscribe } from '../store.js';
import { icon } from '../config.js';
import { esc, fmtFechaCorta, fmtMontoInput, valorMonto, parseFechaLocal } from '../lib.js';
import { openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { imprimirReciboTemporal, imprimirResumenOcupacion, generarPDFInformeOcupacion } from '../imprimir.js';

const ESTADOS = [
  { id: 'confirmado', label: 'Confirmado', color: 'var(--primary)' },
  { id: 'activo',     label: 'Activo',     color: 'var(--success)' },
  { id: 'completado', label: 'Completado', color: 'var(--text-soft)' },
  { id: 'cancelado',  label: 'Cancelado',  color: 'var(--danger)' },
];

// Etiquetas al estilo agenda de ocupación (Disponible / Reservado / Ocupado)
const AGENDA_LABELS = { confirmado: 'Reservado', activo: 'Ocupado', completado: 'Completado' };

const METODOS_PAGO = ['Efectivo', 'Transferencia', 'Cheque', 'Débito', 'Otro'];

function estadoInfo(id) { return ESTADOS.find(e => e.id === id) || ESTADOS[0]; }

export function noches(t) {
  if (!t.checkIn || !t.checkOut) return 0;
  const a = parseFechaLocal(t.checkIn), b = parseFechaLocal(t.checkOut);
  return Math.max(0, Math.round((b - a) / 86400000));
}

export function totalReserva(t) {
  const base = t.precioTotal || (noches(t) * (t.precioPorNoche || 0));
  return base + (t.montoExtension || 0);
}

/** Saldo de una reserva: total, seña, lo ya cobrado del resto (vía Caja, sumando pagosResto) y lo que falta cobrar. */
function saldoReserva(t) {
  const total = totalReserva(t);
  const senia = t.senia || 0;
  const restoCobrado = (t.pagosResto || []).reduce((s, p) => s + (Number(p.monto) || 0), 0);
  const resta = Math.max(0, Math.round((total - senia - restoCobrado) * 100) / 100);
  return { total, senia, restoCobrado, resta };
}

export const CUENTAS_DESTINO = [
  { id: 'gaston',      label: 'Cuenta de Gastón (inmobiliaria)' },
  { id: 'propietario', label: 'Cuenta del dueño del depto' },
];
export function cuentaLabel(id) { return CUENTAS_DESTINO.find(c => c.id === id)?.label || '—'; }

function siguienteDiaISO(fechaStr) {
  const d = parseFechaLocal(fechaStr);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Busca una reserva (no cancelada) de la misma propiedad cuyas fechas se superpongan
 *  con el rango [checkIn, checkOut) dado. El día de checkOut queda libre (no se cuenta
 *  como noche ocupada), así que una entrada el mismo día que otra salida NO es conflicto. */
function reservaSuperpuesta(propiedadId, checkIn, checkOut, excludeId) {
  const { temporales } = getState();
  return temporales.find(t =>
    t.id !== excludeId &&
    t.propiedadId === propiedadId &&
    t.estado !== 'cancelado' &&
    t.checkIn < checkOut && checkIn < t.checkOut
  );
}

/** Reserva (no cancelada) de la misma propiedad cuya salida cae justo el mismo día
 *  que el check-in dado (recambio el mismo día). */
function salidaMismoDia(propiedadId, checkIn, excludeId) {
  const { temporales } = getState();
  return temporales.find(t =>
    t.id !== excludeId &&
    t.propiedadId === propiedadId &&
    t.estado !== 'cancelado' &&
    t.checkOut === checkIn
  );
}

export default function temporales(root) {
  root.innerHTML = `<div class="view" id="vTemp"></div>`;

  let vista  = 'agenda'; // 'agenda' | 'lista' | 'informe'
  let filtro = 'activos'; // 'activos' | 'todos' | 'completados' (solo para vista lista)
  const hoyD = new Date();
  let anioAgenda = hoyD.getFullYear();
  let mesAgenda  = hoyD.getMonth(); // 0-indexado
  let histPropietarioId = null;
  let histMes = `${hoyD.getFullYear()}-${String(hoyD.getMonth() + 1).padStart(2, '0')}`;

  const render = () => pintarTemporales(root.querySelector('#vTemp'), { vista, filtro, anioAgenda, mesAgenda, histPropietarioId, histMes });
  render();
  const unsub = subscribe(render);

  root.querySelector('#vTemp').addEventListener('change', e => {
    if (e.target.id === 'histPropietario') { histPropietarioId = e.target.value; render(); return; }
    if (e.target.id === 'histMes') { histMes = e.target.value; render(); return; }
  });

  root.querySelector('#vTemp').addEventListener('click', e => {
    if (e.target.closest('#btnNuevoTemp')) { abrirFormTemporal(null, render); return; }

    const vt = e.target.closest('[data-vista-temp]');
    if (vt) { vista = vt.dataset.vistaTemp; render(); return; }

    const pf = e.target.closest('[data-filtro-temp]');
    if (pf) { filtro = pf.dataset.filtroTemp; render(); return; }

    if (e.target.closest('#btnMesAnterior')) {
      mesAgenda--; if (mesAgenda < 0) { mesAgenda = 11; anioAgenda--; }
      render(); return;
    }
    if (e.target.closest('#btnMesSiguiente')) {
      mesAgenda++; if (mesAgenda > 11) { mesAgenda = 0; anioAgenda++; }
      render(); return;
    }
    if (e.target.closest('#btnMesHoy')) {
      anioAgenda = hoyD.getFullYear(); mesAgenda = hoyD.getMonth();
      render(); return;
    }

    const editarAgenda = e.target.closest('[data-editar-agenda]');
    if (editarAgenda) {
      const t = getState().temporales.find(x => x.id === editarAgenda.dataset.editarAgenda);
      if (t) abrirDetalleTemporal(t, render);
      return;
    }

    const editar = e.target.closest('[data-editar]');
    if (editar) {
      const t = getState().temporales.find(x => x.id === editar.dataset.editar);
      if (t) abrirFormTemporal(t, render);
      return;
    }
    const eliminar = e.target.closest('[data-eliminar]');
    if (eliminar) {
      if (confirm('¿Eliminar esta reserva?')) actions.deleteTemporal(eliminar.dataset.eliminar);
      return;
    }
    const cambiarEstado = e.target.closest('[data-estado-id]');
    if (cambiarEstado) {
      const { id, estadoId } = cambiarEstado.dataset;
      actions.updateTemporal(id, { estado: estadoId });
      return;
    }

    const btnImprimirInforme = e.target.closest('#btnImprimirInforme');
    if (btnImprimirInforme) {
      const propietarioIdActual = root.querySelector('#histPropietario')?.value || histPropietarioId;
      const mesActual = root.querySelector('#histMes')?.value || histMes;
      const { propietarios } = getState();
      const propietario = propietarios.find(p => p.id === propietarioIdActual);
      const { props, filas } = reservasDelDuenoEnMes(propietarioIdActual, mesActual);
      imprimirResumenOcupacion({ propietario, mes: mesActual, propiedades: props, filas });
      return;
    }

    const btnDescargarInforme = e.target.closest('#btnDescargarInforme');
    if (btnDescargarInforme) {
      const propietarioIdActual = root.querySelector('#histPropietario')?.value || histPropietarioId;
      const mesActual = root.querySelector('#histMes')?.value || histMes;
      const { propietarios } = getState();
      const propietario = propietarios.find(p => p.id === propietarioIdActual);
      const { props, filas } = reservasDelDuenoEnMes(propietarioIdActual, mesActual);
      descargarInformeTemporal({ propietario, mes: mesActual, propiedades: props, filas });
      return;
    }
  });

  return unsub;
}

function pintarTemporales(el, { vista, filtro, anioAgenda, mesAgenda, histPropietarioId, histMes }) {
  const { temporales } = getState();
  const activos = temporales.filter(t => t.estado === 'activo' || t.estado === 'confirmado');

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">Temporales</h1>
        <p class="view-sub">${activos.length} reserva${activos.length!==1?'s':''} activa${activos.length!==1?'s':''}</p>
      </div>
      <button class="btn btn-primary" id="btnNuevoTemp">${icon('plus')} Nueva reserva</button>
    </div>

    <!-- Selector de vista -->
    <div style="display:flex;gap:.5rem;margin-bottom:1.25rem;flex-wrap:wrap">
      ${[
        { id:'agenda',  label:'📅 Agenda' },
        { id:'lista',   label:'☰ Lista' },
        { id:'informe', label:'📋 Informe mensual' },
      ].map(v => {
        const act = vista === v.id;
        return `<button data-vista-temp="${v.id}" style="
          padding:.35rem .9rem;border-radius:999px;font-size:.8rem;font-weight:600;cursor:pointer;border:none;
          background:${act?'var(--primary)':'var(--surface-2)'};
          color:${act?'#fff':'var(--text-soft)'};transition:all .15s">
          ${v.label}
        </button>`;
      }).join('')}
    </div>

    <div id="vTempBody"></div>`;

  const body = el.querySelector('#vTempBody');
  if (vista === 'agenda') pintarAgenda(body, anioAgenda, mesAgenda);
  else if (vista === 'informe') pintarInformeTemporal(body, histPropietarioId, histMes);
  else pintarLista(body, filtro);
}

/* ── Vista Agenda: grilla de días × propiedades, como un libro de reservas ── */
function pintarAgenda(el, anio, mes) {
  const { temporales, propiedades } = getState();
  const propsTemp = propiedades
    .filter(p => p.habilitadaTemporal)
    .sort((a, b) => (a.nombreTemporal || a.direccion || '').localeCompare(b.nombreTemporal || b.direccion || '', 'es', { numeric: true }));

  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const diasSemana = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const hoy = new Date().toISOString().slice(0, 10);

  const header = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:.6rem">
      <div style="display:flex;align-items:center;gap:.5rem">
        <button class="btn btn-ghost btn-sm" id="btnMesAnterior">‹</button>
        <div style="font-weight:700;min-width:150px;text-align:center;text-transform:capitalize">${meses[mes]} ${anio}</div>
        <button class="btn btn-ghost btn-sm" id="btnMesSiguiente">›</button>
        <button class="btn btn-ghost btn-sm" id="btnMesHoy">Hoy</button>
      </div>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;font-size:.78rem">
        ${['confirmado','activo','completado'].map(id => {
          const est = estadoInfo(id);
          return `<div style="display:flex;align-items:center;gap:.35rem">
            <span style="width:11px;height:11px;border-radius:3px;background:${est.color};display:inline-block"></span>
            ${AGENDA_LABELS[id]}
          </div>`;
        }).join('')}
        <div style="display:flex;align-items:center;gap:.35rem">
          <span style="width:11px;height:11px;border-radius:3px;background:linear-gradient(to bottom,var(--text-soft) 50%,var(--primary) 50%);display:inline-block"></span>
          Recambio el mismo día
        </div>
      </div>
    </div>`;

  if (!propsTemp.length) {
    el.innerHTML = header + `
    <div class="card" style="padding:2.5rem;text-align:center;color:var(--text-faint)">
      <div style="font-size:2rem;margin-bottom:.5rem">🏖</div>
      <div style="font-weight:600;margin-bottom:.25rem">No hay propiedades habilitadas para temporales</div>
      <div style="font-size:.82rem">Habilitalas desde Propiedades → editar → "¿Qué operaciones querés hacer?" → Alquiler temporal.</div>
    </div>`;
    return;
  }

  const totalDias = new Date(anio, mes + 1, 0).getDate();
  const primerDiaMes = `${anio}-${String(mes + 1).padStart(2, '0')}-01`;
  const ultimoDiaMes = `${anio}-${String(mes + 1).padStart(2, '0')}-${String(totalDias).padStart(2, '0')}`;
  const limiteSup = siguienteDiaISO(ultimoDiaMes); // primer día del mes siguiente

  // grilla[propiedadId][día del mes] = { tipo:'normal', t, isStart, span, continuaAntes, continuaDespues }
  //                                  | { tipo:'turnover', saliente, entrante }  (recambio el mismo día)
  //                                  | null
  const grilla = {};
  propsTemp.forEach(p => { grilla[p.id] = new Array(totalDias + 1).fill(null); });

  // Mapa de check-outs que caen dentro del mes visible, por propiedad y día,
  // para detectar cuándo un check-in pisa el mismo día que otra salida.
  const salidaEnDia = {};
  temporales.forEach(t => {
    if (t.estado === 'cancelado') return;
    if (!t.propiedadId || !grilla[t.propiedadId]) return;
    if (!t.checkOut) return;
    if (t.checkOut < primerDiaMes || t.checkOut >= limiteSup) return;
    salidaEnDia[`${t.propiedadId}|${Number(t.checkOut.slice(8, 10))}`] = t;
  });

  temporales.forEach(t => {
    if (t.estado === 'cancelado') return;
    if (!t.propiedadId || !grilla[t.propiedadId]) return;
    if (!t.checkIn || !t.checkOut) return;
    if (t.checkOut <= primerDiaMes || t.checkIn >= limiteSup) return; // sin superposición con el mes visible

    const desde = t.checkIn < primerDiaMes ? primerDiaMes : t.checkIn;
    const hasta = t.checkOut > limiteSup ? limiteSup : t.checkOut;
    if (hasta <= desde) return;

    let diaInicio = Number(desde.slice(8, 10));
    const diaFin = hasta === limiteSup ? totalDias : Number(hasta.slice(8, 10)) - 1;
    if (diaFin < diaInicio) return;

    const continuaAntes   = t.checkIn < primerDiaMes;
    const continuaDespues = t.checkOut > limiteSup;

    // Recambio el mismo día: otro huésped se va justo el día que este entra.
    // Ese día se pinta mitad y mitad; el resto de la estadía arranca al día siguiente.
    const saliente = !continuaAntes ? salidaEnDia[`${t.propiedadId}|${diaInicio}`] : null;
    if (saliente && saliente.id !== t.id) {
      grilla[t.propiedadId][diaInicio] = { tipo: 'turnover', saliente, entrante: t };
      diaInicio += 1;
    }
    if (diaInicio > diaFin) return; // toda la estadía visible era el día de recambio

    const span = diaFin - diaInicio + 1;
    for (let d = diaInicio; d <= diaFin; d++) {
      grilla[t.propiedadId][d] = { tipo: 'normal', t, isStart: d === diaInicio, span, continuaAntes, continuaDespues };
    }
  });

  const filas = Array.from({ length: totalDias }, (_, i) => i + 1).map(dia => {
    const fechaStr = `${anio}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    const esHoy = fechaStr === hoy;
    const diaSemana = diasSemana[new Date(anio, mes, dia).getDay()];

    const celdas = propsTemp.map(p => {
      const celda = grilla[p.id][dia];
      if (!celda) {
        return `<td style="padding:.4rem .6rem;border-bottom:1px solid var(--border);border-left:1px solid var(--border);${esHoy ? 'background:color-mix(in srgb,var(--primary) 6%,transparent)' : ''}"></td>`;
      }

      if (celda.tipo === 'turnover') {
        const estS = estadoInfo(celda.saliente.estado);
        const estE = estadoInfo(celda.entrante.estado);
        return `<td style="padding:0;border-bottom:1px solid var(--border);border-left:1px solid var(--border);vertical-align:top">
          <div style="display:flex;flex-direction:column">
            <div data-editar-agenda="${celda.saliente.id}" style="padding:.25rem .5rem;cursor:pointer;background:color-mix(in srgb,${estS.color} 20%,transparent);border-bottom:1px dashed var(--border);overflow:hidden;display:flex;justify-content:space-between;align-items:baseline;gap:.4rem">
              <span style="font-size:.68rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">⟵ ${esc(celda.saliente.huesped || '—')}</span>
              <span style="font-size:.58rem;color:var(--text-soft);flex-shrink:0">Sale</span>
            </div>
            <div data-editar-agenda="${celda.entrante.id}" style="padding:.25rem .5rem;cursor:pointer;background:color-mix(in srgb,${estE.color} 20%,transparent);overflow:hidden;display:flex;justify-content:space-between;align-items:baseline;gap:.4rem">
              <span style="font-size:.68rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(celda.entrante.huesped || '—')} ⟶</span>
              <span style="font-size:.58rem;color:var(--text-soft);flex-shrink:0">Entra</span>
            </div>
          </div>
        </td>`;
      }

      if (!celda.isStart) return ''; // cubierta por el rowspan de una fila anterior

      const est = estadoInfo(celda.t.estado);
      return `<td rowspan="${celda.span}" data-editar-agenda="${celda.t.id}"
          style="padding:.4rem .6rem;border-bottom:1px solid var(--border);border-left:1px solid var(--border);cursor:pointer;vertical-align:top;background:color-mix(in srgb,${est.color} 16%,transparent)">
        <div style="font-weight:700;font-size:.78rem;line-height:1.25">${celda.continuaAntes ? '⟵ ' : ''}${esc(celda.t.huesped || '—')}${celda.continuaDespues ? ' ⟶' : ''}</div>
        <div style="font-size:.68rem;color:var(--text-soft);margin-top:.15rem">${AGENDA_LABELS[celda.t.estado] || est.label}</div>
      </td>`;
    }).join('');

    return `
      <tr>
        <td style="padding:.4rem .6rem .4rem .5rem;border-bottom:1px solid var(--border);border-left:${esHoy ? '3px solid var(--primary)' : '3px solid transparent'};position:sticky;left:0;background:${esHoy ? 'color-mix(in srgb,var(--primary) 10%,var(--surface))' : 'var(--surface)'};font-weight:${esHoy ? 700 : 400};white-space:nowrap;z-index:1">
          ${String(dia).padStart(2, '0')}/${String(mes + 1).padStart(2, '0')} ${diaSemana}
        </td>
        ${celdas}
      </tr>`;
  }).join('');

  el.innerHTML = header + `
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:var(--r-md)">
      <table style="width:100%;border-collapse:collapse;font-size:.8rem">
        <thead>
          <tr style="background:var(--surface-2)">
            <th style="padding:.5rem .6rem;text-align:left;border-bottom:1px solid var(--border);position:sticky;left:0;background:var(--surface-2);min-width:90px;z-index:2">Día</th>
            ${propsTemp.map(p => `<th style="padding:.5rem .6rem;text-align:left;border-bottom:1px solid var(--border);border-left:1px solid var(--border);min-width:130px">${esc(p.nombreTemporal || p.direccion)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;
}

/* ── Vista Lista: tarjetas (comportamiento original) ── */
function pintarLista(el, filtro) {
  const { temporales, propiedades } = getState();
  const hoy = new Date().toISOString().slice(0, 10);

  const lista = [...temporales].sort((a, b) => (a.checkIn || '').localeCompare(b.checkIn || ''));

  const activos     = lista.filter(t => t.estado === 'activo' || t.estado === 'confirmado');
  const completados = lista.filter(t => t.estado === 'completado' || t.estado === 'cancelado');

  const visible = filtro === 'todos' ? lista : filtro === 'completados' ? completados : activos;
  const counts = { activos: activos.length, completados: completados.length, todos: lista.length };

  el.innerHTML = `
    <div style="display:flex;gap:.5rem;margin-bottom:1.25rem;flex-wrap:wrap">
      ${[
        { id: 'activos',     label: 'Activas / Confirmadas' },
        { id: 'completados', label: 'Historial' },
        { id: 'todos',       label: 'Todas' },
      ].map(p => {
        const activo = filtro === p.id;
        return `<button data-filtro-temp="${p.id}" style="
          padding:.35rem .9rem;border-radius:999px;font-size:.8rem;font-weight:600;cursor:pointer;border:none;
          background:${activo ? 'var(--primary)' : 'var(--surface-2)'};
          color:${activo ? '#fff' : 'var(--text-soft)'};transition:all .15s">
          ${p.label} <span style="opacity:.7">(${counts[p.id]})</span>
        </button>`;
      }).join('')}
    </div>

    ${visible.length ? `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem">
      ${visible.map(t => renderCard(t, propiedades, hoy)).join('')}
    </div>` : `
    <div class="card" style="padding:2.5rem;text-align:center;color:var(--text-faint)">
      <div style="font-size:2rem;margin-bottom:.5rem">🏖</div>
      <div style="font-weight:600;margin-bottom:.25rem">Sin reservas</div>
      <div style="font-size:.82rem">Agregá la primera con el botón de arriba</div>
    </div>`}`;
}

function renderCard(t, propiedades, hoy) {
  const prop  = propiedades.find(p => p.id === t.propiedadId);
  const est   = estadoInfo(t.estado);
  const noct  = noches(t);
  const { total, senia, resta } = saldoReserva(t);

  const checkInPasado = t.checkIn && t.checkIn <= hoy;
  const checkOutPasado = t.checkOut && t.checkOut <= hoy;

  // Auto-sugerir cambio de estado
  const sugerirActivo     = t.estado === 'confirmado' && checkInPasado && !checkOutPasado;
  const sugerirCompletado = (t.estado === 'activo' || t.estado === 'confirmado') && checkOutPasado;

  return `
    <div class="card" style="padding:0;overflow:hidden">
      <!-- Header con color de estado -->
      <div style="background:color-mix(in srgb,${est.color} 12%,transparent);padding:.85rem 1.1rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:.7rem;font-weight:600;color:${est.color};text-transform:uppercase;letter-spacing:.05em">${est.label}</div>
          <div style="font-weight:700;font-size:.95rem;margin-top:.1rem">${esc(t.huesped || '—')}</div>
        </div>
        <div style="display:flex;gap:.25rem">
          <button class="btn btn-xs btn-ghost" data-editar="${t.id}">${icon('edit')}</button>
          <button class="btn btn-xs btn-ghost" data-eliminar="${t.id}">${icon('trash')}</button>
        </div>
      </div>

      <!-- Cuerpo -->
      <div style="padding:.9rem 1.1rem;display:flex;flex-direction:column;gap:.55rem">
        ${prop ? `<div style="font-size:.82rem;color:var(--text-soft)">${icon('home')} ${esc(prop.nombreTemporal ? prop.nombreTemporal + ' — ' + prop.direccion : prop.direccion)}</div>` : ''}

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.4rem">
          <div style="background:var(--surface-2);border-radius:var(--r-sm);padding:.5rem .7rem">
            <div style="font-size:.65rem;color:var(--text-soft);text-transform:uppercase;letter-spacing:.04em">Check-in</div>
            <div style="font-size:.88rem;font-weight:600;margin-top:.1rem">${t.checkIn ? fmtFechaCorta(t.checkIn) : '—'}${t.horaCheckIn ? ` · ${t.horaCheckIn}` : ''}</div>
          </div>
          <div style="background:var(--surface-2);border-radius:var(--r-sm);padding:.5rem .7rem">
            <div style="font-size:.65rem;color:var(--text-soft);text-transform:uppercase;letter-spacing:.04em">Check-out</div>
            <div style="font-size:.88rem;font-weight:600;margin-top:.1rem">${t.checkOut ? fmtFechaCorta(t.checkOut) : '—'}${t.horaCheckOut ? ` · ${t.horaCheckOut}` : ''}</div>
          </div>
        </div>

        ${noct ? `<div style="font-size:.78rem;color:var(--text-soft);text-align:center">${noct} noche${noct !== 1 ? 's' : ''}</div>` : ''}

        ${t.extension ? `<div style="font-size:.75rem;background:color-mix(in srgb,var(--warning) 12%,transparent);border:1px solid var(--warning);border-radius:var(--r-sm);padding:.4rem .6rem">
          🕐 Estadía extendida hasta las ${esc(t.horaCheckOutExtendido || '—')}${t.montoExtension ? ` · +$${Number(t.montoExtension).toLocaleString('es-AR')}` : ''}
        </div>` : ''}

        <!-- Precio -->
        <div style="border-top:1px solid var(--border);padding-top:.55rem;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:.7rem;color:var(--text-soft)">Total</div>
            <div style="font-size:1.05rem;font-weight:700;color:var(--primary)">${total ? '$' + total.toLocaleString('es-AR') : '—'}</div>
          </div>
          ${senia ? `<div style="text-align:right">
            <div style="font-size:.7rem;color:var(--text-soft)">Seña cobrada</div>
            <div style="font-size:.85rem;font-weight:600;color:var(--success)">$${senia.toLocaleString('es-AR')}</div>
            ${resta > 0 ? `<div style="font-size:.7rem;color:var(--warning)">Resta: $${resta.toLocaleString('es-AR')}</div>` : ''}
          </div>` : ''}
        </div>

        ${t.notas ? `<div style="font-size:.75rem;color:var(--text-soft);font-style:italic">${esc(t.notas)}</div>` : ''}

        <!-- Acciones de estado -->
        ${sugerirCompletado ? `
        <button data-estado-id="completado" data-id="${t.id}" class="btn btn-xs" style="background:var(--success);color:#fff;width:100%;justify-content:center">
          ✓ Marcar como completado
        </button>` : sugerirActivo ? `
        <button data-estado-id="activo" data-id="${t.id}" class="btn btn-xs btn-primary" style="width:100%;justify-content:center">
          Marcar como activo (ya hizo check-in)
        </button>` : ''}
      </div>
    </div>`;
}

const MESES_LARGO = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
function mesLabelLargo(mes) {
  if (!mes) return '—';
  const [y, m] = mes.split('-');
  return `${MESES_LARGO[+m - 1]} ${y}`;
}

/** Junta, para un dueño y un mes dados, sus propiedades de alquiler temporal y
 *  todas las reservas (no canceladas) cuya estadía se superpone con ese mes —
 *  para armar el informe mensual que se le manda al dueño. */
function reservasDelDuenoEnMes(propietarioId, mes) {
  const { propiedades, temporales } = getState();
  const props = propiedades
    .filter(p => p.propietarioId === propietarioId && p.habilitadaTemporal)
    .sort((a, b) => (a.nombreTemporal || a.direccion || '').localeCompare(b.nombreTemporal || b.direccion || '', 'es', { numeric: true }));

  const [anio, mesNum] = (mes || '').split('-').map(Number);
  const totalDias = anio && mesNum ? new Date(anio, mesNum, 0).getDate() : 30;
  const primerDiaMes = `${mes}-01`;
  const ultimoDiaMes = `${mes}-${String(totalDias).padStart(2, '0')}`;
  const limite = siguienteDiaISO(ultimoDiaMes);

  const filas = [];
  props.forEach(prop => {
    temporales
      .filter(t => t.propiedadId === prop.id && t.estado !== 'cancelado' && t.checkIn && t.checkOut)
      .filter(t => t.checkOut > primerDiaMes && t.checkIn < limite)
      .forEach(t => filas.push({ prop, t }));
  });
  filas.sort((a, b) =>
    (a.prop.nombreTemporal || a.prop.direccion || '').localeCompare(b.prop.nombreTemporal || b.prop.direccion || '', 'es', { numeric: true })
    || a.t.checkIn.localeCompare(b.t.checkIn));

  return { props, filas, totalDias, primerDiaMes, limite };
}

/** Genera el PDF del informe y lo descarga directo (sin abrir ventana de impresión). */
async function descargarInformeTemporal({ propietario, mes, propiedades, filas }) {
  try {
    const blob = await generarPDFInformeOcupacion({ propietario, mes, propiedades, filas });
    const nombreArchivo = `Informe ${mesLabelLargo(mes)} - ${propietario?.nombre || 'propiedad'}.pdf`.replace(/[\\/:*?"<>|]/g, '');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombreArchivo;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.warn('No se pudo generar el PDF del informe:', err);
    toast('No se pudo generar el PDF (revisá la conexión a internet)', { tipo: 'danger' });
  }
}

/* ── Vista Informe mensual: resumen de ocupación para mandarle al dueño ── */
function pintarInformeTemporal(el, propietarioIdSel, mesSel) {
  const { propietarios, propiedades } = getState();
  const propsTemp = propiedades.filter(p => p.habilitadaTemporal && p.propietarioId);
  const dueñosIds = [...new Set(propsTemp.map(p => p.propietarioId))];
  const dueños = dueñosIds
    .map(id => propietarios.find(p => p.id === id))
    .filter(Boolean)
    .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es'));

  if (!dueños.length) {
    el.innerHTML = `
    <div class="card" style="padding:2.5rem;text-align:center;color:var(--text-faint)">
      <div style="font-size:2rem;margin-bottom:.5rem">📋</div>
      <div style="font-weight:600;margin-bottom:.25rem">No hay propiedades de alquiler temporal con dueño asignado</div>
    </div>`;
    return;
  }

  const propietarioId = propietarioIdSel && dueños.some(d => d.id === propietarioIdSel) ? propietarioIdSel : dueños[0].id;
  const own = dueños.find(d => d.id === propietarioId);
  const { props, filas, totalDias, primerDiaMes, limite } = reservasDelDuenoEnMes(propietarioId, mesSel);

  const nochesPorProp = {};
  const totalPorProp = {};
  props.forEach(p => { nochesPorProp[p.id] = 0; totalPorProp[p.id] = 0; });
  filas.forEach(({ prop, t }) => {
    const desde = t.checkIn < primerDiaMes ? primerDiaMes : t.checkIn;
    const hasta = t.checkOut > limite ? limite : t.checkOut;
    const n = Math.max(0, Math.round((parseFechaLocal(hasta) - parseFechaLocal(desde)) / 86400000));
    nochesPorProp[prop.id] += n;
    totalPorProp[prop.id] += totalReserva(t);
  });
  const totalGeneral = props.reduce((s, p) => s + (totalPorProp[p.id] || 0), 0);

  el.innerHTML = `
    <div class="form-grid" style="margin-bottom:1rem">
      <div class="form-group">
        <label>Dueño</label>
        <select id="histPropietario">${dueños.map(d => `<option value="${d.id}" ${d.id === propietarioId ? 'selected' : ''}>${esc(d.nombre)}</option>`).join('')}</select>
      </div>
      <div class="form-group">
        <label>Mes</label>
        <input id="histMes" type="month" value="${mesSel}">
      </div>
    </div>

    <div class="card" style="padding:1rem 1.25rem;margin-bottom:1rem">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.6rem">
        <div>
          <div style="font-weight:700;font-size:1.05rem">${esc(own?.nombre || '—')}</div>
          <div style="font-size:.8rem;color:var(--text-soft);text-transform:capitalize">${mesLabelLargo(mesSel)} · ${props.length} propiedad${props.length !== 1 ? 'es' : ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:.68rem;color:var(--text-soft);text-transform:uppercase;letter-spacing:.04em">Total facturado</div>
          <div style="font-size:1.2rem;font-weight:900;color:var(--primary)">$${Math.round(totalGeneral).toLocaleString('es-AR')}</div>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="btn btn-ghost" id="btnImprimirInforme">${icon('file')} Imprimir / PDF</button>
          <button class="btn btn-primary" id="btnDescargarInforme">${icon('download')} Descargar PDF</button>
        </div>
      </div>
    </div>

    ${props.map(p => {
      const nn = nochesPorProp[p.id] || 0;
      const filasProp = filas.filter(f => f.prop.id === p.id);
      return `
      <div class="card" style="margin-bottom:1rem">
        <div class="card-head">
          <h3>${esc(p.nombreTemporal || p.direccion)}</h3>
          <div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
            <span class="badge badge-info">${nn} / ${totalDias} noches ocupadas</span>
            <span class="badge badge-success">$${Math.round(totalPorProp[p.id] || 0).toLocaleString('es-AR')}</span>
          </div>
        </div>
        ${filasProp.length ? `
        <div style="padding:0">
          ${filasProp.map(({ t }) => {
            const total = totalReserva(t);
            const { senia, resta } = saldoReserva(t);
            return `
            <div class="list-row">
              <div class="list-info">
                <div class="list-name">${esc(t.huesped || '—')}</div>
                <div class="text-xs text-soft">
                  ${fmtFechaCorta(t.checkIn)} → ${fmtFechaCorta(t.checkOut)} · ${noches(t)} noche${noches(t) !== 1 ? 's' : ''} · ${estadoInfo(t.estado).label}
                  ${t.precioPorNoche ? ` · $${Number(t.precioPorNoche).toLocaleString('es-AR')}/noche` : ''}
                  ${t.extension ? ` · +estadía extendida${t.montoExtension ? ' ($' + Number(t.montoExtension).toLocaleString('es-AR') + ')' : ''}` : ''}
                </div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-weight:700;color:var(--primary)">${total ? '$' + Math.round(total).toLocaleString('es-AR') : '—'}</div>
                ${senia ? `<div style="font-size:.7rem;color:var(--text-soft)">Seña: $${senia.toLocaleString('es-AR')}</div>` : ''}
                ${resta > 0 ? `<div style="font-size:.7rem;color:var(--warning)">Resta: $${resta.toLocaleString('es-AR')}</div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>` : `<div class="empty-sm" style="padding:.9rem 1.1rem;color:var(--text-faint);font-size:.85rem">Sin reservas este mes</div>`}
      </div>`;
    }).join('')}
  `;
}

/* ---- Detalle del contrato (se abre al tocar una celda de la agenda) ---- */
function abrirDetalleTemporal(t, onDone) {
  const { propiedades } = getState();
  const prop  = propiedades.find(p => p.id === t.propiedadId);
  const est   = estadoInfo(t.estado);
  const noct  = noches(t);
  const { total, senia, restoCobrado, resta } = saldoReserva(t);

  const fila = (label, val) => val ? `
    <div style="display:flex;justify-content:space-between;gap:1rem;padding:.4rem 0;border-bottom:1px solid var(--border);font-size:.85rem">
      <span style="color:var(--text-soft)">${label}</span><span style="font-weight:600;text-align:right">${val}</span>
    </div>` : '';

  openModal({
    title: 'Detalle de la reserva',
    size: 'lg',
    bodyHTML: `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1.1rem">
        <div>
          <div style="font-size:1.2rem;font-weight:700">${esc(t.huesped || '—')}</div>
          <div style="font-size:.78rem;font-weight:700;color:${est.color};text-transform:uppercase;letter-spacing:.05em;margin-top:.15rem">${est.label}</div>
        </div>
      </div>

      <h3 class="form-section-title">Huésped</h3>
      ${fila('DNI', t.dni ? esc(t.dni) : null)}
      ${fila('Teléfono', t.telefono ? esc(t.telefono) : null)}
      ${!t.dni && !t.telefono ? `<div style="font-size:.8rem;color:var(--text-faint)">Sin datos adicionales</div>` : ''}

      <h3 class="form-section-title" style="margin-top:1.1rem">Propiedad y fechas</h3>
      ${fila('Propiedad', prop ? esc(prop.nombreTemporal ? `${prop.nombreTemporal} — ${prop.direccion}` : prop.direccion) : '—')}
      ${fila('Check-in', `${t.checkIn ? fmtFechaCorta(t.checkIn) : '—'}${t.horaCheckIn ? ' · ' + esc(t.horaCheckIn) : ''}`)}
      ${fila('Check-out', `${t.checkOut ? fmtFechaCorta(t.checkOut) : '—'}${t.horaCheckOut ? ' · ' + esc(t.horaCheckOut) : ''}`)}
      ${fila('Noches', noct || null)}
      ${t.extension ? fila('Estadía extendida', `Hasta las ${esc(t.horaCheckOutExtendido || '—')}${t.montoExtension ? ' · +$' + Number(t.montoExtension).toLocaleString('es-AR') : ''}`) : ''}

      <h3 class="form-section-title" style="margin-top:1.1rem">Precios</h3>
      ${fila('Precio por noche', t.precioPorNoche ? '$' + Number(t.precioPorNoche).toLocaleString('es-AR') : null)}
      ${fila('Total', total ? '$' + total.toLocaleString('es-AR') : '—')}
      ${fila('Seña cobrada', senia ? `$${senia.toLocaleString('es-AR')} · ${cuentaLabel(t.cuentaSenia || 'gaston')}` : null)}
      ${fila('Resto cobrado', restoCobrado ? '$' + restoCobrado.toLocaleString('es-AR') + ' (ver detalle abajo)' : null)}
      ${fila('Resta cobrar', resta > 0 ? '$' + resta.toLocaleString('es-AR') : null)}
      ${(t.pagosResto || []).length ? `
      <div style="margin-top:.5rem;display:flex;flex-direction:column;gap:.3rem">
        ${t.pagosResto.map(p => `
        <div style="display:flex;justify-content:space-between;font-size:.78rem;color:var(--text-soft);background:var(--surface-2);border-radius:var(--r-sm);padding:.35rem .6rem">
          <span>${fmtFechaCorta(p.fecha)} · ${esc(p.metodoPago)} · ${cuentaLabel(p.cuentaDestino)}</span>
          <span style="font-weight:700;color:var(--text)">$${Number(p.monto).toLocaleString('es-AR')}</span>
        </div>`).join('')}
      </div>` : ''}

      ${t.notas ? `<h3 class="form-section-title" style="margin-top:1.1rem">Notas</h3><div style="font-size:.85rem;color:var(--text-soft);font-style:italic">${esc(t.notas)}</div>` : ''}
    `,
    footerHTML: `
      <button class="btn btn-ghost" data-close>Cerrar</button>
      <button class="btn btn-ghost" id="btnImprimirRecTemp">${icon('file')} Imprimir recibo</button>
      ${resta > 0 ? `<button class="btn btn-ghost" id="btnCobrarResto" style="color:var(--success)">💰 Cobrar resto</button>` : ''}
      <button class="btn btn-primary" id="btnEditarDesdeDetalle">${icon('edit')} Editar contrato</button>`,
    onMount(ctx) {
      ctx.overlay.querySelector('#btnImprimirRecTemp').addEventListener('click', () => {
        imprimirReciboTemporal({ temporal: t, propiedad: prop });
      });
      ctx.overlay.querySelector('#btnCobrarResto')?.addEventListener('click', () => {
        ctx.close();
        abrirCobroRestoTemporal(t, onDone);
      });
      ctx.overlay.querySelector('#btnEditarDesdeDetalle').addEventListener('click', () => {
        ctx.close();
        abrirFormTemporal(t, onDone);
      });
    },
  });
}

/* ---- Cobro del resto (saldo pendiente) → va directo a Caja ---- */
function abrirCobroRestoTemporal(t, onDone) {
  const { resta } = saldoReserva(t);

  openModal({
    title: 'Registrar cobro del resto',
    bodyHTML: `
      <form id="fResto">
        <div class="form-grid">
          <div class="form-group">
            <label>Monto a cobrar $</label>
            <input name="monto" type="text" inputmode="numeric" class="input-monto" value="${fmtMontoInput(resta)}" style="font-weight:700;font-size:1.05rem" autofocus>
          </div>
          <div class="form-group">
            <label>Forma de pago</label>
            <select name="metodoPago">${METODOS_PAGO.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
          </div>
          <div class="form-group full">
            <label>¿A qué cuenta fue este cobro?</label>
            <select name="cuentaDestino">${CUENTAS_DESTINO.map(c => `<option value="${c.id}">${c.label}</option>`).join('')}</select>
          </div>
          <div class="form-group full">
            <label>Referencia</label>
            <input name="referencia" placeholder="Opcional">
          </div>
        </div>
        <p style="font-size:.75rem;color:var(--text-soft)">Este cobro se registra directo en Control de caja.</p>
      </form>`,
    footerHTML: `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="btnConfirmarResto">Registrar cobro</button>`,
    onMount({ overlay, close }) {
      const f = overlay.querySelector('#fResto');
      overlay.querySelector('#btnConfirmarResto').addEventListener('click', async () => {
        const monto = valorMonto(f.monto.value);
        if (!monto || monto <= 0) { toast('Indicá un monto válido', { tipo: 'warning' }); return; }
        await actions.registrarCobroRestoTemporal(t.id, {
          monto, metodoPago: f.metodoPago.value, referencia: f.referencia.value || null, cuentaDestino: f.cuentaDestino.value,
        });
        toast('Cobro registrado en Caja');
        close();
        onDone?.();
      });
    },
  });
}

/* ---- Formulario ---- */
function abrirFormTemporal(t, onDone) {
  const ed  = !!t; t = t || {};
  const { propiedades } = getState();
  // Solo propiedades habilitadas para temporal
  const propsTemp = propiedades.filter(p => p.habilitadaTemporal);

  openModal({
    title: ed ? 'Editar reserva' : 'Nueva reserva temporal',
    size: 'lg',
    bodyHTML: `
      <form id="fTemp">
        <h3 class="form-section-title">Datos del huésped</h3>
        <div class="form-grid">
          <div class="form-group full">
            <label>Nombre y apellido <span class="req">*</span></label>
            <input name="huesped" value="${esc(t.huesped||'')}" placeholder="Nombre del huésped" autofocus>
          </div>
          <div class="form-group">
            <label>DNI</label>
            <input name="dni" value="${esc(t.dni||'')}" placeholder="Ej. 30123456">
          </div>
          <div class="form-group">
            <label>Teléfono / WhatsApp</label>
            <input name="telefono" value="${esc(t.telefono||'')}" placeholder="Opcional">
          </div>
        </div>

        <h3 class="form-section-title" style="margin-top:1.25rem">Propiedad y fechas</h3>
        <div class="form-grid">
          <div class="form-group full">
            <label>Propiedad</label>
            <select name="propiedadId">
              <option value="">— Sin asignar —</option>
              ${propsTemp.length
                ? propsTemp.map(p => `<option value="${p.id}" ${t.propiedadId===p.id?'selected':''}>${esc(p.nombreTemporal ? p.nombreTemporal + ' — ' + p.direccion : p.direccion)}</option>`).join('')
                : `<option disabled>No hay propiedades habilitadas para temporales</option>`}
            </select>
            ${!propsTemp.length ? `<p style="font-size:.75rem;color:var(--warning);margin-top:.3rem">Habilitá propiedades para temporales desde la sección Propiedades → editar → Tipo de uso.</p>` : ''}
          </div>
          <div class="form-group">
            <label>Check-in <span class="req">*</span></label>
            <input name="checkIn" id="tCheckIn" type="date" value="${t.checkIn||''}">
          </div>
          <div class="form-group">
            <label>Check-out <span class="req">*</span></label>
            <input name="checkOut" id="tCheckOut" type="date" value="${t.checkOut||''}">
          </div>
        </div>
        <div id="warnSuperposicion" style="display:none;margin-top:.6rem;padding:.6rem .8rem;border-radius:var(--r-sm);background:color-mix(in srgb,var(--danger) 12%,transparent);border:1px solid var(--danger);font-size:.8rem;color:var(--danger)"></div>

        <h3 class="form-section-title" style="margin-top:1.25rem">Horarios</h3>
        <div class="form-grid">
          <div class="form-group">
            <label>Hora de check-in</label>
            <input name="horaCheckIn" type="time" value="${t.horaCheckIn || '12:00'}">
          </div>
          <div class="form-group">
            <label>Hora de check-out</label>
            <input name="horaCheckOut" type="time" value="${t.horaCheckOut || '09:30'}">
          </div>
        </div>

        <div style="margin-top:.75rem;padding:.85rem 1rem;border-radius:var(--r-md);background:var(--surface-2);border:1px solid var(--border)">
          <label style="display:flex;align-items:center;gap:.6rem;cursor:pointer;font-weight:600">
            <input type="checkbox" id="chkExtension" ${t.extension ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer">
            🕐 Estadía extendida (medio día adicional)
          </label>
          <div id="blkExtension" style="display:${t.extension ? 'grid' : 'none'};grid-template-columns:1fr 1fr;gap:.6rem;margin-top:.65rem">
            <div class="form-group" style="margin:0">
              <label>Hasta qué hora</label>
              <input name="horaCheckOutExtendido" type="time" value="${t.horaCheckOutExtendido || '18:00'}">
            </div>
            <div class="form-group" style="margin:0">
              <label>Monto cobrado $</label>
              <input name="montoExtension" type="text" inputmode="numeric" class="input-monto" value="${fmtMontoInput(t.montoExtension)}">
            </div>
          </div>
        </div>

        <h3 class="form-section-title" style="margin-top:1.25rem">Precios</h3>
        <div class="form-grid">
          <div class="form-group">
            <label>Precio por noche $</label>
            <input name="precioPorNoche" id="tPPN" type="text" inputmode="numeric" class="input-monto" value="${fmtMontoInput(t.precioPorNoche)}">
          </div>
          <div class="form-group">
            <label>Noches</label>
            <input id="tNoches" type="number" readonly style="background:var(--surface-2)" value="">
          </div>
          <div class="form-group">
            <label style="font-weight:700;color:var(--primary)">Total $</label>
            <input name="precioTotal" id="tTotal" type="text" inputmode="numeric" class="input-monto" value="${fmtMontoInput(t.precioTotal)}" style="font-weight:700;font-size:1.05rem">
          </div>
          <div class="form-group">
            <label>Seña cobrada $</label>
            <input name="senia" type="text" inputmode="numeric" class="input-monto" value="${fmtMontoInput(t.senia)}">
          </div>
          <div class="form-group">
            <label>Forma de pago de la seña</label>
            <select name="metodoPagoSenia">${METODOS_PAGO.map(m => `<option value="${m}" ${(t.metodoPagoSenia||'Efectivo')===m?'selected':''}>${m}</option>`).join('')}</select>
          </div>
          <div class="form-group full">
            <label>¿A qué cuenta fue la seña?</label>
            <select name="cuentaSenia">${CUENTAS_DESTINO.map(c => `<option value="${c.id}" ${(t.cuentaSenia||'gaston')===c.id?'selected':''}>${c.label}</option>`).join('')}</select>
          </div>
        </div>
        <p style="font-size:.75rem;color:var(--text-soft);margin-top:-.4rem">La seña se manda sola a Control de caja al guardar. El resto se registra después, desde el detalle de la reserva.</p>

        <h3 class="form-section-title" style="margin-top:1.25rem">Notas</h3>
        <div class="form-group">
          <textarea name="notas" rows="2">${esc(t.notas||'')}</textarea>
        </div>
      </form>`,
    footerHTML: `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="btnGuardarTemp">${ed ? 'Guardar cambios' : 'Crear reserva'}</button>`,
    onMount({ overlay, close }) {
      const q = sel => overlay.querySelector(sel);

      const recalcular = () => {
        const ci  = q('#tCheckIn').value;
        const co  = q('#tCheckOut').value;
        const ppn = valorMonto(q('#tPPN').value);
        if (ci && co && co > ci) {
          const n = Math.round((parseFechaLocal(co) - parseFechaLocal(ci)) / 86400000);
          q('#tNoches').value = n;
          if (ppn) q('#tTotal').value = fmtMontoInput(n * ppn);
        } else {
          q('#tNoches').value = '';
        }
      };

      // Aviso en vivo si la propiedad elegida todavía está ocupada en esas fechas
      const avisar = (texto, tipo) => {
        const warn = q('#warnSuperposicion');
        const esWarning = tipo === 'warning';
        warn.style.background = `color-mix(in srgb,var(--${esWarning ? 'warning' : 'danger'}) 12%,transparent)`;
        warn.style.borderColor = `var(--${esWarning ? 'warning' : 'danger'})`;
        warn.style.color = `var(--${esWarning ? 'warning' : 'danger'})`;
        warn.textContent = texto;
        warn.style.display = '';
      };

      const chequearDisponibilidad = () => {
        const warn = q('#warnSuperposicion');
        const propiedadId = q('[name="propiedadId"]').value;
        const ci = q('#tCheckIn').value;
        const co = q('#tCheckOut').value;
        if (propiedadId && ci && co && co > ci) {
          // Conflicto real: se pisan las fechas (el día de checkOut queda libre, no cuenta)
          const conflicto = reservaSuperpuesta(propiedadId, ci, co, ed ? t.id : null);
          if (conflicto) {
            avisar(`⚠ Esa propiedad todavía está ocupada/reservada por ${conflicto.huesped || 'otro huésped'} del ${fmtFechaCorta(conflicto.checkIn)} al ${fmtFechaCorta(conflicto.checkOut)}. Elegí otras fechas.`, 'danger');
            return;
          }
          // Recambio el mismo día: no es conflicto, pero si el que se va tiene estadía
          // extendida hay que confirmar que el horario de entrada no se pise con el de salida.
          const salida = salidaMismoDia(propiedadId, ci, ed ? t.id : null);
          if (salida && salida.extension) {
            const horaEntrada = q('[name="horaCheckIn"]').value || '12:00';
            avisar(`ℹ️ ${salida.huesped || 'El huésped anterior'} se va ese mismo día con estadía extendida hasta las ${salida.horaCheckOutExtendido || '—'}. Confirmá que la entrada de este huésped (${horaEntrada}) sea después de esa hora.`, 'warning');
            return;
          }
        }
        warn.style.display = 'none';
      };

      q('#tCheckIn').addEventListener('change', () => { recalcular(); chequearDisponibilidad(); });
      q('#tCheckOut').addEventListener('change', () => { recalcular(); chequearDisponibilidad(); });
      q('#tPPN').addEventListener('input', recalcular);
      q('[name="propiedadId"]').addEventListener('change', chequearDisponibilidad);
      q('[name="horaCheckIn"]').addEventListener('change', chequearDisponibilidad);
      recalcular();
      chequearDisponibilidad();

      q('#chkExtension').addEventListener('change', (e) => {
        q('#blkExtension').style.display = e.target.checked ? 'grid' : 'none';
      });

      q('#btnGuardarTemp').addEventListener('click', async () => {
        const get = n => (q(`[name="${n}"]`)?.value || '').trim();
        const num = n => valorMonto(q(`[name="${n}"]`)?.value);

        const huesped    = get('huesped');
        const checkIn    = get('checkIn');
        const checkOut   = get('checkOut');
        const propiedadId = get('propiedadId');
        if (!huesped)             { q('[name="huesped"]').focus(); return; }
        if (!checkIn || !checkOut){ return; }
        if (checkOut <= checkIn)  { alert('El check-out debe ser posterior al check-in'); return; }

        if (propiedadId) {
          const conflicto = reservaSuperpuesta(propiedadId, checkIn, checkOut, ed ? t.id : null);
          if (conflicto) {
            toast(`Esa propiedad todavía está ocupada/reservada por ${conflicto.huesped || 'otro huésped'} del ${fmtFechaCorta(conflicto.checkIn)} al ${fmtFechaCorta(conflicto.checkOut)}`, { tipo: 'danger' });
            return;
          }
        }

        // Estado se calcula automáticamente por fechas
        const hoy = new Date().toISOString().slice(0, 10);
        let estado = 'confirmado';
        if (checkIn <= hoy && checkOut > hoy) estado = 'activo';
        else if (checkOut <= hoy)             estado = 'completado';

        const extension = q('#chkExtension').checked;

        const data = {
          huesped, checkIn, checkOut,
          dni:           get('dni') || null,
          telefono:      get('telefono') || null,
          propiedadId:   propiedadId || null,
          horaCheckIn:   get('horaCheckIn') || null,
          horaCheckOut:  get('horaCheckOut') || null,
          extension,
          horaCheckOutExtendido: extension ? (get('horaCheckOutExtendido') || null) : null,
          montoExtension:        extension ? (num('montoExtension') || null) : null,
          precioPorNoche: num('precioPorNoche') || null,
          precioTotal:   num('precioTotal') || null,
          senia:         num('senia') || null,
          metodoPagoSenia: get('metodoPagoSenia') || 'Efectivo',
          cuentaSenia:   get('cuentaSenia') || 'gaston',
          estado,
          notas:         get('notas') || null,
        };

        if (ed) await actions.updateTemporal(t.id, data);
        else    await actions.createTemporal(data);
        close();
        onDone();
      });
    },
  });
}

