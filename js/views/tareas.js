/* ============================================================
   VISTA · Tareas pendientes — listado global de tareas (problemas/
   incidencias y mantenimiento) creadas desde Alquileres y Temporales.
   ============================================================ */
import { getState, sel, actions, subscribe } from '../store.js';
import { icon, ESTADOS_TAREA, PASOS_TAREA } from '../config.js';
import { esc, fmtFechaCorta, debounce } from '../lib.js';
import { navegar } from '../router.js';
import { openTareaForm, openTareaDetalle } from './forms.js';
import { toast } from '../components/toast.js';

export default function tareas(root) {
  root.innerHTML = `<div class="view" id="vTareas"></div>`;
  let tab = 'pendientes'; // 'pendientes' | 'vencidas' | 'todas'
  let filtro = '';
  let filtroPropiedadId = '';
  let filtroClienteId = '';

  const render = () => pintarTareas(root.querySelector('#vTareas'), tab, filtro, filtroPropiedadId, filtroClienteId);
  render();
  const unsub = subscribe(render);

  root.querySelector('#vTareas').addEventListener('click', (e) => {
    if (e.target.closest('#btnNuevaTarea')) { openTareaForm(null, () => {}); return; }

    const tb = e.target.closest('[data-tab]');
    if (tb) { tab = tb.dataset.tab; render(); return; }

    const verTarea = e.target.closest('[data-ver-tarea]');
    if (verTarea) {
      const t = getState().tareas.find(x => x.id === verTarea.dataset.verTarea);
      if (t) openTareaDetalle(t);
      return;
    }
    const editar = e.target.closest('[data-editar-tarea]');
    if (editar) {
      const t = getState().tareas.find(x => x.id === editar.dataset.editarTarea);
      if (t) openTareaForm(t, () => {});
      return;
    }
    const eliminar = e.target.closest('[data-eliminar-tarea]');
    if (eliminar) {
      if (confirm('¿Eliminar esta tarea?')) actions.deleteTarea(eliminar.dataset.eliminarTarea);
      return;
    }
    const pasoTarea = e.target.closest('[data-cambiar-estado-tarea]');
    if (pasoTarea) {
      const nuevoEstado = pasoTarea.dataset.estado;
      actions.updateTarea(pasoTarea.dataset.cambiarEstadoTarea, { estado: nuevoEstado }).then(() => {
        if (nuevoEstado === 'listo') toast('Tarea marcada como lista');
      });
      return;
    }
    const ir = e.target.closest('[data-ir]');
    if (ir) { navegar(ir.dataset.ir); return; }
  });

  root.querySelector('#vTareas').addEventListener('input', debounce((e) => {
    if (e.target.id === 'buscarTarea') { filtro = e.target.value.toLowerCase(); render(); }
  }, 150));

  root.querySelector('#vTareas').addEventListener('change', (e) => {
    if (e.target.id === 'filtroPropTarea') { filtroPropiedadId = e.target.value; render(); }
    if (e.target.id === 'filtroCliTarea')  { filtroClienteId = e.target.value; render(); }
  });

  return unsub;
}

function pintarTareas(el, tab, filtro, filtroPropiedadId, filtroClienteId) {
  const { tareas: todas, clientes, propiedades, temporales } = getState();
  const pendientes = sel.tareasPendientes();
  const vencidas    = sel.tareasVencidas();
  const base = tab === 'vencidas' ? vencidas : tab === 'todas' ? todas : pendientes;

  const lista = base
    .filter(t => !filtro || `${t.titulo} ${t.asignadoA||''}`.toLowerCase().includes(filtro))
    .filter(t => !filtroPropiedadId || t.propiedadId === filtroPropiedadId)
    .filter(t => !filtroClienteId || t.clienteId === filtroClienteId)
    .slice()
    .sort((a, b) => (a.fecha||'').localeCompare(b.fecha||''));

  // Solo se ofrecen para filtrar las propiedades/clientes que efectivamente tienen alguna tarea cargada.
  const propsConTarea = propiedades.filter(p => todas.some(t => t.propiedadId === p.id))
    .sort((a, b) => (a.direccion||'').localeCompare(b.direccion||'', 'es'));
  const clientesConTarea = clientes.filter(c => todas.some(t => t.clienteId === c.id))
    .sort((a, b) => (a.nombre||'').localeCompare(b.nombre||'', 'es'));

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">Tareas pendientes</h1>
        <p class="view-sub">${pendientes.length} pendiente${pendientes.length!==1?'s':''} · ${vencidas.length} vencida${vencidas.length!==1?'s':''}</p>
      </div>
      <button class="btn btn-primary" id="btnNuevaTarea">${icon('plus')} Nueva tarea</button>
    </div>

    <div class="tabs" style="margin-bottom:1rem">
      <button class="tab ${tab==='pendientes'?'active':''}" data-tab="pendientes">Pendientes (${pendientes.length})</button>
      <button class="tab ${tab==='vencidas'?'active':''}" data-tab="vencidas">Vencidas (${vencidas.length})</button>
      <button class="tab ${tab==='todas'?'active':''}" data-tab="todas">Todas (${todas.length})</button>
    </div>

    <div class="toolbar" style="flex-wrap:wrap;gap:.6rem">
      <div class="search-bar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="buscarTarea" placeholder="Buscar por título o responsable…" value="${esc(filtro)}">
      </div>
      <select id="filtroPropTarea" class="field" style="max-width:220px">
        <option value="">Todas las cabañas / propiedades</option>
        ${propsConTarea.map(p => `<option value="${p.id}" ${filtroPropiedadId===p.id?'selected':''}>${esc(p.nombreTemporal || p.direccion)}</option>`).join('')}
      </select>
      <select id="filtroCliTarea" class="field" style="max-width:220px">
        <option value="">Todos los clientes</option>
        ${clientesConTarea.map(c => `<option value="${c.id}" ${filtroClienteId===c.id?'selected':''}>${esc(c.nombre)}</option>`).join('')}
      </select>
    </div>

    ${lista.length ? `
    <div class="card" style="padding:0">
      ${lista.map(t => renderFila(t, { clientes, propiedades, temporales })).join('')}
    </div>` : `
    <div class="empty">
      ${icon('alert')}
      <h3>No hay tareas${(filtro || filtroPropiedadId || filtroClienteId) ? ' con ese filtro' : tab==='vencidas' ? ' vencidas' : tab==='pendientes' ? ' pendientes' : ''}</h3>
      <p>${(filtro || filtroPropiedadId || filtroClienteId) ? 'Probá con otro criterio.' : 'Se cargan desde el detalle de un contrato de Alquileres o desde Temporales → Mantenimiento.'}</p>
    </div>`}`;
}

function renderFila(t, { clientes, propiedades, temporales }) {
  const hoy = new Date().toISOString().slice(0, 10);
  const vencida = !['listo', 'cerrado'].includes(t.estado) && t.fecha && t.fecha < hoy;
  const cliente = t.clienteId   ? clientes.find(c => c.id === t.clienteId)     : null;
  const prop    = t.propiedadId ? propiedades.find(p => p.id === t.propiedadId) : null;
  const reserva = t.temporalId  ? temporales.find(x => x.id === t.temporalId)   : null;
  const ruta = t.origen === 'alquiler' && t.alquilerId ? `alquileres/${t.alquilerId}`
    : t.temporalId ? `temporales/${t.temporalId}`
    : 'temporales';

  const partes = [
    fmtFechaCorta(t.fecha) + (t.hora ? ' · ' + t.hora : ''),
    t.origen === 'alquiler' ? 'Alquileres' : 'Temporales',
    cliente?.nombre,
    reserva?.huesped,
    prop?.direccion,
    t.asignadoA ? '👤 ' + t.asignadoA : null,
  ].filter(Boolean).join(' · ');

  return `
    <div class="list-row list-row-hover" data-ir="${ruta}" style="cursor:pointer;flex-wrap:wrap;gap:.6rem">
      <div class="list-info" style="flex:1;min-width:0">
        <div class="list-name">${esc(t.titulo)}${vencida ? ' <span class="badge badge-danger" style="font-size:.65rem">Vencida</span>' : ''}</div>
        <div class="text-xs text-soft truncate">${esc(partes)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:.6rem;flex-shrink:0">
        ${renderPasadorEstado(t)}
        <button class="btn btn-xs btn-ghost" data-ver-tarea="${t.id}" title="Ver detalle">${icon('eye')}</button>
        <button class="btn btn-xs btn-ghost" data-editar-tarea="${t.id}" title="Editar">${icon('edit')}</button>
        <button class="btn btn-xs btn-ghost" data-eliminar-tarea="${t.id}" title="Eliminar" style="color:var(--danger)">${icon('trash')}</button>
      </div>
    </div>`;
}

/* Pasador de estado: pendiente → en proceso → listo (clic en un paso lo aplica directo).
   "cerrado" es un cierre manual aparte, se muestra como badge fijo sin pasador. */
function renderPasadorEstado(t) {
  if (t.estado === 'cerrado') {
    const estadoObj = ESTADOS_TAREA.find(e => e.id === 'cerrado');
    return `<span class="badge ${estadoObj?.badge || 'badge-neutral'}" style="flex-shrink:0">${estadoObj?.label || 'Cerrado'}</span>`;
  }
  const idx = Math.max(0, PASOS_TAREA.findIndex(p => p.id === t.estado));
  return `
    <div class="pasador-estado">
      ${PASOS_TAREA.map((p, i) => `
        ${i > 0 ? `<span class="pasador-linea ${i <= idx ? 'is-done' : ''}"></span>` : ''}
        <button type="button" class="pasador-paso ${i < idx ? 'is-done' : ''} ${i === idx ? 'is-current' : ''} ${p.id === 'listo' ? 'pasador-paso-listo' : ''}"
          data-cambiar-estado-tarea="${t.id}" data-estado="${p.id}" title="Marcar como ${p.label}">
          <span class="pasador-dot"></span><span class="pasador-label">${p.label}</span>
        </button>`).join('')}
    </div>`;
}
