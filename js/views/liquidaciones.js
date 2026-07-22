/* ============================================================
   VISTA · Liquidaciones — pagos a propietarios
   ============================================================ */
import { getState, actions, subscribe } from '../store.js';
import { icon } from '../config.js';
import { esc, fmtMontoInput, valorMonto } from '../lib.js';
import { openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { imprimirLiquidacion, imprimirLiquidacionTemporal } from '../imprimir.js';
import { cuentaLabel, noches } from './temporales.js';

function fmtFecha(s) {
  if (!s) return '—';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
function mesLabel(s) {
  if (!s) return '—';
  const [y, m] = s.split('-');
  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  return `${MESES[+m - 1]} ${y}`;
}
function fmt$(n) { return Number(n || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }); }

/* ============================================================
   ALQUILER TEMPORAL — reparto dueño/inmobiliaria + gastos
   ============================================================ */

/** IDs de señas y pagos de resto que ya quedaron incluidos en alguna liquidación
 *  temporal cerrada, para no volver a contarlos en un cierre posterior. */
function pagosYaLiquidados() {
  const { liquidacionesTemporales } = getState();
  const senas = new Set();
  const restos = new Set();
  (liquidacionesTemporales || []).forEach(l => {
    (l.senasIncluidas || []).forEach(id => senas.add(id));
    (l.pagosRestoIncluidos || []).forEach(id => restos.add(id));
  });
  return { senas, restos };
}

/** Calcula el reparto teórico (según el % de cada propiedad, aplicado por igual
 *  al alquiler y a la estadía extendida) contra lo que realmente entró a cada
 *  cuenta (seña + pagos de resto), agrupando TODAS las propiedades temporales
 *  de un mismo dueño en un solo cálculo (una sola liquidación), para un mes
 *  dado. Deja afuera lo que ya haya sido liquidado antes. */
function calcularLiquidacionTemporal(propietarioId, mes) {
  const { temporales, propiedades } = getState();
  const propsDelDueno = propiedades.filter(p => p.propietarioId === propietarioId && p.habilitadaTemporal);
  const { senas: yaSenas, restos: yaRestos } = pagosYaLiquidados();

  let totalBase = 0, totalExtension = 0, realGaston = 0, realPropietario = 0;
  let teoricoDueño = 0, teoricoGaston = 0;
  const detalle = [];
  const senasIncluidas = [];
  const pagosRestoIncluidos = [];

  propsDelDueno.forEach(prop => {
    const pctDueñoProp = prop.pctPropietarioTemporal ?? 70;
    const pctGastonProp = 100 - pctDueñoProp;

    temporales.filter(t => t.propiedadId === prop.id).forEach(t => {
      const base = t.precioTotal || (noches(t) * (t.precioPorNoche || 0));
      const ext = t.montoExtension || 0;
      const total = base + ext;
      if (total <= 0) return;
      const fracBase = base / total;
      const fracExt = ext / total;

      const eventos = [];
      if (t.senia > 0 && t.fechaSenia && t.fechaSenia.slice(0, 7) === mes && !yaSenas.has(t.id)) {
        eventos.push({ tipo: 'senia', monto: t.senia, cuenta: t.cuentaSenia || 'gaston', refId: t.id });
      }
      (t.pagosResto || []).forEach(p => {
        if (p.fecha && p.fecha.slice(0, 7) === mes && !yaRestos.has(p.id)) {
          eventos.push({ tipo: 'resto', monto: p.monto, cuenta: p.cuentaDestino || 'gaston', refId: p.id });
        }
      });
      if (!eventos.length) return;

      eventos.forEach(e => {
        const b = e.monto * fracBase;
        const x = e.monto * fracExt;
        totalBase += b;
        totalExtension += x;
        // La estadía extendida se reparte igual que el alquiler (mismo % del dueño de la propiedad).
        teoricoDueño += e.monto * (pctDueñoProp / 100);
        teoricoGaston += e.monto * (pctGastonProp / 100);
        if (e.cuenta === 'gaston') realGaston += e.monto; else realPropietario += e.monto;
        if (e.tipo === 'senia') senasIncluidas.push(e.refId); else pagosRestoIncluidos.push(e.refId);
      });

      detalle.push({ t, prop, eventos });
    });
  });

  // diffBase > 0: a Gastón le entró de más (le corresponde transferirle al dueño esa diferencia)
  const diffBase = Math.round((realGaston - teoricoGaston) * 100) / 100;
  // % efectivo (ponderado) sobre el total cobrado (alquiler + extensión), para mostrar y
  // para prorratear gastos cuando las propiedades del mismo dueño tuvieran distinto % pactado.
  const totalGeneral = totalBase + totalExtension;
  const pctDueño = totalGeneral > 0 ? Math.round((teoricoDueño / totalGeneral) * 10000) / 100 : (propsDelDueno[0]?.pctPropietarioTemporal ?? 70);
  const pctGaston = 100 - pctDueño;

  return {
    propiedades: propsDelDueno, pctDueño, pctGaston,
    totalBase: Math.round(totalBase), totalExtension: Math.round(totalExtension),
    realGaston: Math.round(realGaston), realPropietario: Math.round(realPropietario),
    teoricoDueño: Math.round(teoricoDueño), teoricoGaston: Math.round(teoricoGaston),
    diffBase, detalle, senasIncluidas, pagosRestoIncluidos,
  };
}

/** Junta, por dueño, todo lo cobrado (seña + resto) de sus propiedades temporales
 *  que todavía no entró en ninguna liquidación cerrada — sin importar el mes —
 *  para mostrar un resumen rápido de "pendientes" antes de elegir el mes exacto. */
function pendientesTemporalesPorDueño() {
  const { propiedades, propietarios, temporales } = getState();
  const propsTemp = propiedades.filter(p => p.habilitadaTemporal && p.propietarioId);
  const { senas: yaSenas, restos: yaRestos } = pagosYaLiquidados();
  const porDueño = {};

  propsTemp.forEach(prop => {
    temporales.filter(t => t.propiedadId === prop.id).forEach(t => {
      let montoPend = 0;
      const meses = new Set();
      if (t.senia > 0 && t.fechaSenia && !yaSenas.has(t.id)) { montoPend += t.senia; meses.add(t.fechaSenia.slice(0, 7)); }
      (t.pagosResto || []).forEach(p => {
        if (p.fecha && !yaRestos.has(p.id)) { montoPend += p.monto; meses.add(p.fecha.slice(0, 7)); }
      });
      if (montoPend <= 0) return;

      const key = prop.propietarioId;
      if (!porDueño[key]) {
        porDueño[key] = { propietarioId: key, own: propietarios.find(x => x.id === key), total: 0, meses: new Set(), props: new Set() };
      }
      porDueño[key].total += montoPend;
      meses.forEach(m => porDueño[key].meses.add(m));
      porDueño[key].props.add(prop.id);
    });
  });

  return Object.values(porDueño)
    .map(g => ({ ...g, meses: [...g.meses].sort(), props: [...g.props] }))
    .sort((a, b) => (a.meses[0] || '').localeCompare(b.meses[0] || ''));
}

/* ── Forma de pago (una o varias líneas: efectivo + transferencia, etc.) ── */
const METODOS_PAGO = [
  { id: 'Efectivo', icon: '💵' },
  { id: 'Transferencia', icon: '🏦' },
  { id: 'Cheque', icon: '📄' },
  { id: 'Otro', icon: '📝' },
];

function pagosBlockHTML() {
  return `
    <div class="form-group full">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <label style="margin:0">Forma de pago</label>
        <button type="button" data-btn-add-pago class="btn btn-xs btn-ghost">${icon('plus')} Dividir pago</button>
      </div>
      <div data-pagos-blk></div>
    </div>`;
}

/** Gestiona las líneas de pago dentro de un modal. `getTotal` debe devolver el total a pagar vigente. */
function montarPagos(ctx, { getTotal }) {
  const ov = ctx.overlay;
  const mostrarRef = (m) => ['Transferencia', 'Cheque'].includes(m);
  let pagos = [{ metodoPago: 'Efectivo', monto: getTotal(), referencia: '' }];

  const resumen = () => {
    const el = ov.querySelector('[data-pagos-resumen]');
    if (!el) return;
    const total = Number(getTotal()) || 0;
    const asignado = pagos.reduce((s, p) => s + (Number(p.monto) || 0), 0);
    if (pagos.length > 1) {
      const dif = Math.round((total - asignado) * 100) / 100;
      el.textContent = `Asignado: ${fmt$(asignado)} de ${fmt$(total)}` + (dif !== 0 ? ` · Faltan ${fmt$(dif)}` : ' · ✓ Coincide');
      el.style.color = dif === 0 ? 'var(--success)' : 'var(--warning)';
    } else {
      el.textContent = '';
    }
  };

  const render = () => {
    const blk = ov.querySelector('[data-pagos-blk]');
    blk.innerHTML = pagos.map((p, i) => `
      <div style="display:flex;gap:.5rem;align-items:flex-end;margin-bottom:.5rem;flex-wrap:wrap" data-pago-idx="${i}">
        <div class="form-group" style="margin:0;min-width:150px">
          <label style="font-size:.72rem">Método</label>
          <select data-f="metodoPago">
            ${METODOS_PAGO.map(m => `<option value="${m.id}" ${p.metodoPago === m.id ? 'selected' : ''}>${m.icon} ${m.id}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin:0;width:130px">
          <label style="font-size:.72rem">Monto $</label>
          <input type="text" inputmode="numeric" class="input-monto" data-f="monto" value="${fmtMontoInput(p.monto)}">
        </div>
        ${mostrarRef(p.metodoPago) ? `
        <div class="form-group" style="margin:0;flex:1;min-width:160px">
          <label style="font-size:.72rem">Referencia</label>
          <input type="text" data-f="referencia" value="${esc(p.referencia || '')}" placeholder="CBU / N° / banco">
        </div>` : ''}
        ${pagos.length > 1 ? `<button type="button" class="btn btn-xs btn-ghost" data-del-pago="${i}" style="color:var(--danger)">✕</button>` : ''}
      </div>`).join('') + `<div data-pagos-resumen style="font-size:.78rem;margin-top:.2rem"></div>`;

    blk.querySelectorAll('[data-pago-idx]').forEach(row => {
      const i = Number(row.dataset.pagoIdx);
      row.querySelector('[data-f="metodoPago"]').addEventListener('change', e => { pagos[i].metodoPago = e.target.value; render(); });
      row.querySelector('[data-f="monto"]').addEventListener('input', e => { pagos[i].monto = valorMonto(e.target.value); resumen(); });
      row.querySelector('[data-f="referencia"]')?.addEventListener('input', e => { pagos[i].referencia = e.target.value; });
    });
    blk.querySelectorAll('[data-del-pago]').forEach(btn => {
      btn.addEventListener('click', () => { pagos.splice(Number(btn.dataset.delPago), 1); render(); });
    });
    resumen();
  };

  ov.querySelector('[data-btn-add-pago]').addEventListener('click', () => {
    const total = Number(getTotal()) || 0;
    const asignado = pagos.reduce((s, p) => s + (Number(p.monto) || 0), 0);
    const restante = Math.max(0, total - asignado);
    const usados = pagos.map(p => p.metodoPago);
    const siguiente = METODOS_PAGO.find(m => !usados.includes(m.id))?.id || 'Transferencia';
    pagos.push({ metodoPago: siguiente, monto: restante || '', referencia: '' });
    render();
  });

  render();

  return {
    getPagos: () => pagos.filter(p => Number(p.monto) > 0)
      .map(p => ({ metodoPago: p.metodoPago, monto: Number(p.monto), referencia: p.referencia || null })),
    refrescarTotal: resumen,
  };
}

/* Detecta cobros pagados que aún no tienen liquidación registrada - AGRUPADOS POR PROPIETARIO (todas sus propiedades y meses pendientes juntos) */
function cobrosALiquidar(state) {
  const { alquileres, liquidaciones, clientes, propietarios, propiedades } = state;

  // Recolectar cobros ya liquidados por cobroId
  const cobrosLiquidados = new Set();
  (liquidaciones || []).forEach(l => {
    // Si la liquidación tiene liquidadosCobros (array de IDs), marcalos como liquidados
    if (l.liquidadosCobros) {
      l.liquidadosCobros.forEach(id => cobrosLiquidados.add(id));
    }
  });

  // Agrupar únicamente por propietarioId: un propietario con varias propiedades
  // (o cobros de distintos meses) se liquida todo junto en una sola fila
  const grupos = {};

  alquileres.forEach(a => {
    (a.cobros || []).forEach(c => {
      if (!c.pagado || !c.monto) return;
      if (cobrosLiquidados.has(c.id)) return; // ya liquidado
      if (c.imputarAlMes) return; // imputado a un mes atrasado: no debe figurar para liquidar hoy

      const key = a.propietarioId;
      if (!grupos[key]) {
        grupos[key] = {
          propietarioId: a.propietarioId,
          cobros: [],
          own: propietarios.find(x => x.id === a.propietarioId),
          totalPropiedades: propiedades.filter(p => p.propietarioId === a.propietarioId).length,
        };
      }

      const inq  = clientes.find(x => x.id === a.inquilinoId);
      const prop = propiedades.find(x => x.id === a.propiedadId);

      grupos[key].cobros.push({ alq: a, cobro: c, inq, prop });
    });
  });

  // Convertir a array, calcular meses involucrados y ordenar
  const pendientes = Object.values(grupos).map(g => {
    const meses = [...new Set(g.cobros.map(c => c.cobro.mes))].sort();
    return { ...g, meses };
  });
  pendientes.sort((a, b) => (a.meses[0] || '').localeCompare(b.meses[0] || ''));
  return pendientes;
}

export default function liquidaciones(root) {
  root.innerHTML = `<div class="view" id="vLiq"></div>`;
  let modo = 'normal'; // normal | temporal
  let filtro = 'pendientes'; // pendientes | historial
  let pendientes = []; // Mantener referencia a pendientes (alquiler normal)

  const render = () => {
    const state = getState();
    pendientes = cobrosALiquidar(state);
    pintar(root.querySelector('#vLiq'), { modo, filtro, pendientes });
  };

  render();
  const unsub = subscribe(render);

  root.querySelector('#vLiq').addEventListener('click', async e => {
    const modoBtn = e.target.closest('[data-modo-liq]');
    if (modoBtn) { modo = modoBtn.dataset.modoLiq; render(); return; }

    const pill = e.target.closest('[data-filtro]');
    if (pill) { filtro = pill.dataset.filtro; render(); return; }

    // Liquidar un grupo (todas las propiedades pendientes de un propietario)
    const btnLiq = e.target.closest('[data-liq-grupo]');
    if (btnLiq) {
      const propietarioId = btnLiq.dataset.liqProp;
      const grupo = pendientes.find(g => g.propietarioId === propietarioId);
      if (grupo) {
        abrirFormLiquidacionGrupal(grupo, render);
      }
      return;
    }

    // Alquiler temporal: abrir el modal de liquidación ya con el dueño elegido
    const btnLiqTemp = e.target.closest('[data-liq-temp-dueño]');
    if (btnLiqTemp) {
      abrirLiquidacionTemporalModal(render, btnLiqTemp.dataset.liqTempDueño);
      return;
    }
    if (e.target.closest('#btnNuevaLiqTemp')) {
      abrirLiquidacionTemporalModal(render);
      return;
    }
    const pdfTemp = e.target.closest('[data-pdf-liqt]');
    if (pdfTemp) {
      const l = (getState().liquidacionesTemporales || []).find(x => x.id === pdfTemp.dataset.pdfLiqt);
      if (l) {
        const propiedadesLiq = getState().propiedades.filter(p => (l.propiedadesIds || []).includes(p.id));
        const propietario = getState().propietarios.find(p => p.id === l.propietarioId);
        imprimirLiquidacionTemporal({ liquidacion: l, propiedades: propiedadesLiq, propietario });
      }
      return;
    }
    const delTemp = e.target.closest('[data-eliminar-liqt]');
    if (delTemp) {
      if (confirm('¿Eliminar esta liquidación? Los cobros que incluía volverán a aparecer como pendientes de liquidar.')) {
        await actions.deleteLiquidacionTemporal(delTemp.dataset.eliminarLiqt);
        toast('Liquidación eliminada');
      }
      return;
    }

    // Acciones sobre liquidaciones ya registradas (alquiler normal)
    const card = e.target.closest('[data-liq-id]');
    if (!card) return;
    const id = card.dataset.liqId;

    if (e.target.closest('[data-pdf]'))      { generarPDF(id); return; }
    if (e.target.closest('[data-eliminar]')) {
      if (confirm('¿Eliminar esta liquidación?')) {
        await actions.deleteLiquidacion(id);
        toast('Liquidación eliminada');
      }
      return;
    }
  });

  return unsub;
}

function pintar(el, { modo, filtro, pendientes }) {
  el.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">Liquidaciones</h1>
        <p class="view-sub">Pagos a propietarios</p>
      </div>
      ${modo === 'temporal' ? `<button class="btn btn-primary" id="btnNuevaLiqTemp">${icon('plus')} Liquidar alquiler temporal</button>` : ''}
    </div>

    <!-- Alquiler normal / temporal -->
    <div style="display:flex;gap:.5rem;margin-bottom:.75rem">
      ${[
        { id: 'normal',   label: '🔑 Alquiler normal' },
        { id: 'temporal', label: '🏖 Alquiler temporal' },
      ].map(m => {
        const activo = modo === m.id;
        return `<button data-modo-liq="${m.id}" style="
          padding:.4rem 1rem;border-radius:999px;font-size:.82rem;font-weight:700;cursor:pointer;border:none;
          background:${activo ? 'var(--primary)' : 'var(--surface-2)'};
          color:${activo ? '#fff' : 'var(--text-soft)'};transition:all .15s">
          ${m.label}
        </button>`;
      }).join('')}
    </div>

    <div id="vLiqBody"></div>
  `;

  const body = el.querySelector('#vLiqBody');
  if (modo === 'temporal') pintarLiquidacionesTemporales(body);
  else pintarLiquidacionesNormales(body, filtro, pendientes);
}

function pintarLiquidacionesNormales(el, filtro, pendientes) {
  const state = getState();
  const { liquidaciones: list, alquileres } = state;
  const historial  = (list || []).map(l => {
    const alq  = alquileres.find(a => a.id === l.alquilerId) || {};
    const prop = state.propiedades.find(p => p.id === (l.propiedadId || alq.propiedadId)) || {};
    const own  = state.propietarios.find(p => p.id === (l.propietarioId || alq.propietarioId)) || {};
    const inq  = state.clientes.find(c => c.id === alq.inquilinoId) || {};

    // Para liquidaciones grupales, contar propiedades distintas (no cobros individuales)
    let nPropsGrupal = 0;
    if (l.liquidadosCobros && l.liquidadosCobros.length > 1) {
      const propIds = new Set();
      l.liquidadosCobros.forEach(cobroId => {
        const a = alquileres.find(a => (a.cobros || []).some(c => c.id === cobroId));
        if (a) propIds.add(a.propiedadId);
      });
      nPropsGrupal = propIds.size;
    }

    return { ...l, _alq: alq, _prop: prop, _own: own, _inq: inq, _nPropsGrupal: nPropsGrupal };
  }).sort((a, b) => (b.fechaPago || '').localeCompare(a.fechaPago || ''));

  const totalPend = pendientes.reduce((s, grupo) => {
    return s + (grupo.cobros || []).reduce((s2, c) => s2 + (c.cobro?.monto || 0), 0);
  }, 0);

  el.innerHTML = `
    <p class="view-sub" style="margin-bottom:.75rem">${pendientes.length} por liquidar · ${fmt$(totalPend)} pendiente</p>

    <!-- Pills -->
    <div style="display:flex;gap:.5rem;margin-bottom:1.25rem">
      ${[
        { id:'pendientes', label:'Por liquidar', count: pendientes.length, danger: pendientes.length > 0 },
        { id:'historial',  label:'Historial',    count: historial.length },
      ].map(p => {
        const activo = filtro === p.id;
        const color  = p.danger ? 'var(--danger)' : 'var(--primary)';
        return `<button data-filtro="${p.id}" style="
          padding:.35rem .9rem;border-radius:999px;font-size:.8rem;font-weight:600;cursor:pointer;border:none;
          background:${activo ? color : 'var(--surface-2)'};
          color:${activo ? '#fff' : (p.danger ? 'var(--danger)' : 'var(--text-soft)')};
          transition:all .15s">
          ${p.label}${p.count ? ` (${p.count})` : ''}
        </button>`;
      }).join('')}
    </div>

    ${filtro === 'pendientes' ? renderPendientes(pendientes) : renderHistorial(historial)}
  `;
}

function pintarLiquidacionesTemporales(el) {
  const pendientes = pendientesTemporalesPorDueño();
  const historial = (getState().liquidacionesTemporales || [])
    .sort((a, b) => (b.mes || '').localeCompare(a.mes || '') || (b.fechaCierre || '').localeCompare(a.fechaCierre || ''));

  el.innerHTML = `
    <p class="view-sub" style="margin-bottom:1rem">Reparto dueño / inmobiliaria de las propiedades de alquiler temporal</p>

    ${pendientes.length ? `
    <h3 class="form-section-title">Pendientes de liquidar</h3>
    <div style="display:flex;flex-direction:column;gap:.6rem;margin-bottom:1.5rem">
      ${pendientes.map(g => `
        <div class="card" style="padding:1rem 1.25rem;border-left:3px solid var(--warning)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap">
            <div>
              <div style="font-weight:700;font-size:1.05rem">${esc(g.own?.nombre || '—')}</div>
              <div style="font-size:.82rem;color:var(--text-soft)">${g.props.length} propiedad${g.props.length !== 1 ? 'es' : ''} · ${g.meses.map(mesLabel).join(', ')}</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:.5rem">
              <div style="font-size:1.3rem;font-weight:900;color:var(--warning)">${fmt$(g.total)}</div>
              <button class="btn btn-primary btn-sm" data-liq-temp-dueño="${g.propietarioId}">Liquidar →</button>
            </div>
          </div>
        </div>`).join('')}
    </div>` : `
    <div class="card" style="padding:2rem 1.5rem;text-align:center;color:var(--text-soft);margin-bottom:1.5rem">
      <div style="font-size:2rem;margin-bottom:.5rem">✅</div>
      <div style="font-weight:600;margin-bottom:.25rem">Todo liquidado</div>
      <div style="font-size:.82rem;color:var(--text-faint)">No hay cobros de alquiler temporal pendientes de liquidar</div>
    </div>`}

    <h3 class="form-section-title">Historial</h3>
    ${historial.length ? `
    <div style="display:flex;flex-direction:column;gap:.6rem">
      ${historial.map(l => {
        const own = getState().propietarios.find(p => p.id === l.propietarioId);
        return `
        <div class="card" style="padding:1rem 1.25rem">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap">
            <div>
              <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.3rem">
                <span style="font-weight:700">${esc(own?.nombre || '—')}</span>
                <span class="badge badge-success">Liquidado</span>
                <span class="badge badge-neutral">${mesLabel(l.mes)}</span>
              </div>
              <div style="font-size:.82rem;color:var(--text-soft)">
                ${l.transferencia ? `${l.transferencia.desde === 'gaston' ? 'Gastón → dueño' : 'Dueño → Gastón'}: ${fmt$(l.transferencia.monto)}` : 'Todo saldado'}
              </div>
            </div>
            <div style="display:flex;gap:.3rem;flex-shrink:0">
              <button class="btn btn-sm btn-ghost" data-pdf-liqt="${l.id}">${icon('file')} PDF</button>
              <button class="btn btn-xs btn-ghost" style="color:var(--danger)" data-eliminar-liqt="${l.id}">${icon('trash')}</button>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>` : `
    <div class="card" style="padding:2rem 1.5rem;text-align:center;color:var(--text-soft)">
      <div style="font-size:2rem;margin-bottom:.5rem">📄</div>
      <div style="font-weight:600">Sin historial aún</div>
    </div>`}
  `;
}

function renderPendientes(pendientes) {
  if (!pendientes.length) return `
    <div class="card" style="padding:2rem 1.5rem;text-align:center;color:var(--text-soft)">
      <div style="font-size:2rem;margin-bottom:.5rem">✅</div>
      <div style="font-weight:600;margin-bottom:.25rem">Todo liquidado</div>
      <div style="font-size:.82rem;color:var(--text-faint)">No hay cobros de inquilinos pendientes de liquidar al propietario</div>
    </div>`;

  return `
    <div style="display:flex;flex-direction:column;gap:.6rem">
      ${pendientes.map(grupo => {
        const totalCobros = grupo.cobros.reduce((s, c) => s + (c.cobro.monto || 0), 0);
        const nProps = new Set(grupo.cobros.map(c => c.prop?.id)).size;
        const mesesLabelStr = grupo.meses.length === 1
          ? mesLabel(grupo.meses[0])
          : `${mesLabel(grupo.meses[0])} – ${mesLabel(grupo.meses[grupo.meses.length - 1])}`;

        // Agrupar los cobros por propiedad para el detalle (una propiedad puede tener varios meses pendientes)
        const porProp = {};
        grupo.cobros.forEach(c => {
          const k = c.prop?.id || 'x';
          if (!porProp[k]) porProp[k] = { prop: c.prop, inq: c.inq, meses: [], total: 0 };
          porProp[k].meses.push(c.cobro.mes);
          porProp[k].total += c.cobro.monto || 0;
        });
        const detalle = Object.values(porProp);

        return `
        <div class="card" style="padding:1rem 1.25rem;border-left:3px solid var(--warning)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.75rem;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.3rem">
                <span style="font-weight:700;font-size:1.05rem">${esc(grupo.own?.nombre || '—')}</span>
                <span class="badge badge-warning" style="font-size:.72rem">${mesesLabelStr}</span>
                <span class="badge badge-neutral" style="font-size:.72rem">${nProps}/${grupo.totalPropiedades} ${grupo.totalPropiedades === 1 ? 'propiedad' : 'propiedades'}</span>
              </div>
              <div style="display:flex;flex-direction:column;gap:.2rem">
                ${detalle.map(d => `
                  <div style="font-size:.82rem;color:var(--text-soft)">
                    ${esc(d.prop?.direccion || '—')}
                    <span style="color:var(--text-faint)"> · ${d.meses.map(mesLabel).join(', ')} · ${esc(d.inq?.nombre || '—')} · ${fmt$(d.total)}</span>
                  </div>`).join('')}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:.5rem">
              <div style="font-size:1.3rem;font-weight:900;color:var(--warning)">${fmt$(totalCobros)}</div>
              <button class="btn btn-primary btn-sm" data-liq-grupo data-liq-prop="${grupo.propietarioId}">
                Liquidar →
              </button>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

function renderHistorial(historial) {
  if (!historial.length) return `
    <div class="card" style="padding:2rem 1.5rem;text-align:center;color:var(--text-soft)">
      <div style="font-size:2rem;margin-bottom:.5rem">📄</div>
      <div style="font-weight:600">Sin historial aún</div>
    </div>`;

  return `
    <div style="display:flex;flex-direction:column;gap:.6rem">
      ${historial.map(l => {
        const hon     = l.montoHonorarios || Math.round((l.montoAlquiler || 0) * (l.pctHonorarios || 0) / 100);
        const descTot = (l.descuentos || []).reduce((s, d) => s + (Number(d.monto) || 0), 0);
        const esGrupal = l.liquidadosCobros && l.liquidadosCobros.length > 1;
        return `
        <div class="card" data-liq-id="${l.id}" style="padding:1rem 1.25rem">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.3rem">
                <span style="font-weight:700">${esc(l._own?.nombre || '—')}</span>
                <span class="badge badge-success">Liquidado</span>
                ${esGrupal ? `<span class="badge badge-info" style="font-size:.72rem">📋 Grupal</span>` : ''}
                ${l.meses && l.meses.length > 1
                  ? `<span class="badge badge-neutral">${mesLabel(l.meses[0])} – ${mesLabel(l.meses[l.meses.length - 1])}</span>`
                  : (l.mes ? `<span class="badge badge-neutral">${mesLabel(l.mes)}</span>` : '')}
              </div>
              <div style="font-size:.82rem;color:var(--text-soft);margin-bottom:.4rem">
                ${esGrupal ?
                  `<strong>${l._nPropsGrupal || 1} ${l._nPropsGrupal === 1 ? 'propiedad' : 'propiedades'}</strong> · ${l.liquidadosCobros.length} cobros` :
                  `${esc(l._prop?.direccion || '—')}${l._prop?.ciudad ? ' · ' + esc(l._prop.ciudad) : ''}`
                }
              </div>
              <div style="display:flex;gap:1.25rem;flex-wrap:wrap;font-size:.8rem">
                <span><span style="color:var(--text-soft)">Alquiler: </span><strong>${fmt$(l.montoAlquiler)}</strong></span>
                <span><span style="color:var(--text-soft)">Comisión (${l.pctHonorarios || 0}%): </span><strong style="color:var(--danger)">−${fmt$(hon)}</strong></span>
                ${descTot ? `<span><span style="color:var(--text-soft)">Desc.: </span><strong style="color:var(--danger)">−${fmt$(descTot)}</strong></span>` : ''}
                <span><span style="color:var(--text-soft)">Pagado: </span><strong style="color:var(--success)">${fmt$(l.totalPagar)}</strong></span>
              </div>
              <div style="font-size:.78rem;color:var(--text-faint);margin-top:.35rem">
                ${fmtFecha(l.fechaPago)} · ${esc(l.formaPago || 'Efectivo')}
                ${l.notas ? ' · ' + esc(l.notas) : ''}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:.3rem;flex-shrink:0">
              <button class="btn btn-sm btn-ghost" data-pdf="${l.id}">${icon('file')} PDF</button>
              <button class="btn btn-xs btn-ghost" style="color:var(--danger)" data-eliminar="${l.id}">${icon('trash')}</button>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

/* ── Generar PDF ── */
function generarPDF(id) {
  const { liquidaciones: list, alquileres, clientes, propietarios, propiedades } = getState();
  const l    = (list || []).find(x => x.id === id);
  if (!l) return;
  const alq  = alquileres.find(a => a.id === l.alquilerId) || {};
  const inq  = clientes.find(c => c.id === alq.inquilinoId) || {};
  const prop = propiedades.find(p => p.id === (l.propiedadId || alq.propiedadId)) || {};
  const own  = propietarios.find(p => p.id === (l.propietarioId || alq.propietarioId)) || {};
  const cobroSint = { monto: l.montoAlquiler, mes: l.mes, fechaPago: l.fechaPago };
  imprimirLiquidacion({ alq, cobro: cobroSint, inquilino: inq, propiedad: prop, propietario: own,
    pctHonorarios: l.pctHonorarios || 0, descuentos: l.descuentos || [], formaPago: l.formaPago || 'Efectivo',
    pagos: l.pagos || [] });
}

/* ── Formulario liquidar GRUPAL (múltiples propiedades de un propietario) ── */
export function abrirFormLiquidacionGrupal(grupo, onDone) {
  const { alquileres, clientes, propietarios, propiedades } = getState();
  const own = grupo.own || {};
  
  // Calcular totales
  const totalMonto = grupo.cobros.reduce((s, c) => s + (c.cobro.monto || 0), 0);
  const pctDef = 10; // porcentaje de comisión
  
  const hoy = new Date().toISOString().slice(0, 10);
  const mesesLabelStr = grupo.meses.length === 1
    ? mesLabel(grupo.meses[0])
    : `${mesLabel(grupo.meses[0])} – ${mesLabel(grupo.meses[grupo.meses.length - 1])}`;

  // Agrupar los cobros por propiedad (una propiedad puede tener varios meses pendientes)
  const porProp = {};
  grupo.cobros.forEach(c => {
    const k = c.prop?.id || 'x';
    if (!porProp[k]) porProp[k] = { prop: c.prop, inq: c.inq, periodos: [], total: 0 };
    porProp[k].periodos.push({ mes: c.cobro.mes, fechaPago: c.cobro.fechaPago });
    porProp[k].total += c.cobro.monto || 0;
  });
  const detalleProps = Object.values(porProp);

  let descIdx = 0;

  openModal({
    title: `Liquidación grupal — ${esc(own.nombre || '—')} — ${mesesLabelStr}`,
    size: 'xl',
    bodyHTML: `
      <form id="liqGrupalForm">
        <!-- Resumen de propiedades y cobros -->
        <div style="background:var(--surface-2);border-radius:var(--r-md);padding:1rem;margin-bottom:1.25rem;border:1px solid var(--border)">
          <div style="font-size:.72rem;color:var(--text-soft);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.5rem">Propiedades y cobros del período (${detalleProps.length}/${grupo.totalPropiedades} ${grupo.totalPropiedades === 1 ? 'propiedad' : 'propiedades'})</div>
          <div style="display:flex;flex-direction:column;gap:.6rem">
            ${detalleProps.map(d => `
            <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:.6rem;background:var(--surface);border-radius:var(--r-sm);border-left:3px solid var(--primary)">
              <div style="flex:1">
                <div style="font-weight:600;margin-bottom:.2rem">${esc(d.prop?.direccion || '—')}</div>
                <div style="font-size:.78rem;color:var(--text-soft)">${esc(d.inq?.nombre || '—')} · ${esc(d.prop?.barrio || '')}</div>
                <div style="font-size:.75rem;color:var(--text-faint);margin-top:.2rem">${d.periodos.map(p => `${mesLabel(p.mes)} · Cobrado: ${fmtFecha(p.fechaPago)}`).join(' · ')}</div>
              </div>
              <div style="font-weight:700;font-size:1.1rem;text-align:right;color:var(--primary)">${fmt$(d.total)}</div>
            </div>`).join('')}
          </div>
          <div style="border-top:2px solid var(--border);margin-top:.75rem;padding-top:.75rem;display:flex;justify-content:space-between;align-items:center;font-size:1.1rem;font-weight:800">
            <span>TOTAL COBRADO</span>
            <span style="color:var(--primary);font-size:1.3rem">${fmt$(totalMonto)}</span>
          </div>
        </div>

        <h3 class="form-section-title">Comisión de la inmobiliaria</h3>
        <div class="form-grid" style="margin-bottom:1.1rem">
          <div class="form-group">
            <label>% Comisión</label>
            <input name="pctHonorarios" id="liqPct" type="number" min="0" max="100" step="0.5" value="${pctDef}">
          </div>
          <div class="form-group">
            <label>Monto comisión $</label>
            <input id="liqMontoHon" type="text" readonly style="background:var(--surface-2);font-weight:700">
          </div>
          <div class="form-group">
            <label style="color:var(--success);font-weight:700">Total a pagar al propietario $</label>
            <input name="totalPagar" id="liqTotal" type="text" inputmode="numeric" class="input-monto" style="font-size:1.1rem;font-weight:800;color:var(--success)">
          </div>
        </div>

        <h3 class="form-section-title">Descuentos / deducciones</h3>
        <div id="descBlk" style="margin-bottom:.5rem"></div>
        <button type="button" id="btnAddDesc" class="btn btn-sm btn-ghost" style="margin-bottom:1.25rem">${icon('plus')} Agregar descuento</button>

        <h3 class="form-section-title">Datos del pago</h3>
        <div class="form-grid">
          <div class="form-group">
            <label>Fecha de pago <span class="req">*</span></label>
            <input name="fechaPago" type="date" value="${hoy}">
          </div>
          ${pagosBlockHTML()}
          <div class="form-group full">
            <label>Notas</label>
            <input name="notas" placeholder="Observaciones opcionales">
          </div>
        </div>
      </form>`,
    footerHTML: `<button class="btn btn-ghost" data-close>Cancelar</button>
                 <button class="btn btn-ghost" id="btnSoloGuardar">Guardar sin PDF</button>
                 <button class="btn btn-primary" id="btnGuardarPDF">Guardar y generar PDF</button>`,
    onMount(ctx) {
      const q = (sel) => ctx.overlay.querySelector(sel);
      let pagosCtl = null;

      const recalcular = () => {
        const pct  = Number(q('#liqPct').value) || 0;
        const hon  = Math.round(totalMonto * pct / 100);
        const desc = Array.from(q('#descBlk').querySelectorAll('[data-desc-monto]'))
          .reduce((s, el) => s + valorMonto(el.value), 0);
        const total = totalMonto - hon - desc;
        q('#liqMontoHon').value = fmtMontoInput(hon);
        q('#liqTotal').value = fmtMontoInput(total);
        pagosCtl?.refrescarTotal();
      };

      const renderDescs = () => {
        const block = q('#descBlk');
        block.innerHTML = (q('#liqForm') || q('#liqGrupalForm')).descuentos?.map((d, i) => `
          <div style="display:flex;gap:.5rem;align-items:flex-end;margin-bottom:.5rem">
            <input type="text" placeholder="Concepto" value="${esc(d.concepto || '')}" data-desc-concepto="${i}" style="flex:1">
            <input type="text" inputmode="numeric" class="input-monto" placeholder="Monto" value="${fmtMontoInput(d.monto)}" data-desc-monto="${i}" style="width:100px">
            <button type="button" data-del-desc="${i}" class="btn btn-xs btn-ghost" style="color:var(--danger)">${icon('trash')}</button>
          </div>`).join('') || '';
        block.querySelectorAll('[data-desc-monto]').forEach(el => {
          el.addEventListener('input', () => {
            const idx = Number(el.dataset.descMonto);
            const form = q('#liqForm') || q('#liqGrupalForm');
            if (form.descuentos?.[idx]) form.descuentos[idx].monto = valorMonto(el.value);
            recalcular();
          });
        });
      };

      q('#liqPct').addEventListener('input', recalcular);
      
      q('#btnAddDesc').addEventListener('click', () => {
        if (!q('#liqForm') && !q('#liqGrupalForm')) return;
        const form = q('#liqForm') || q('#liqGrupalForm');
        form.descuentos = form.descuentos || [];
        form.descuentos.push({ concepto: '', monto: 0 });
        renderDescs();
        recalcular();
      });

      q('#descBlk').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-del-desc]');
        if (btn) {
          const idx = Number(btn.dataset.delDesc);
          const form = q('#liqForm') || q('#liqGrupalForm');
          if (form.descuentos) form.descuentos.splice(idx, 1);
          renderDescs();
          recalcular();
        }
      });

      const guardar = async (conPDF) => {
        const form = q('#liqGrupalForm');
        const totalPagar = valorMonto(q('#liqTotal').value);

        const pagos = pagosCtl.getPagos();
        if (!pagos.length) { toast('Indicá la forma de pago', { tipo: 'warning' }); return; }
        if (pagos.length > 1) {
          const suma = pagos.reduce((s, p) => s + p.monto, 0);
          if (Math.round(suma * 100) !== Math.round(totalPagar * 100)) {
            toast('La suma de las formas de pago no coincide con el total a pagar', { tipo: 'warning' });
            return;
          }
        }

        const fd = new FormData(form);
        const data = Object.fromEntries(fd.entries());
        data.propietarioId = grupo.propietarioId;
        data.meses = grupo.meses;
        data.mes = grupo.meses.length === 1 ? grupo.meses[0] : null;
        data.montoAlquiler = totalMonto;
        data.pctHonorarios = Number(data.pctHonorarios) || 0;
        data.totalPagar = totalPagar;
        data.descuentos = form.descuentos || [];
        data.pagos = pagos;
        data.formaPago = pagos.length > 1 ? pagos.map(p => p.metodoPago).join(' + ') : pagos[0].metodoPago;

        // Guardar los IDs de cobros liquidados
        data.liquidadosCobros = grupo.cobros.map(item => item.cobro.id);

        const liq = await actions.createLiquidacion(data);

        if (conPDF && liq) {
          // Se llama de forma síncrona respecto al click para evitar que el navegador bloquee el pop-up
          imprimirLiquidacion({
            alq: {},
            cobro: { monto: liq.montoAlquiler, mes: liq.mes, fechaPago: liq.fechaPago },
            inquilino: {},
            propiedad: {},
            propietario: own,
            pctHonorarios: liq.pctHonorarios || 0,
            descuentos: liq.descuentos || [],
            formaPago: liq.formaPago || 'Efectivo',
            pagos: liq.pagos || [],
          });
        }

        toast('Liquidación registrada');
        ctx.close();
        onDone?.();
      };

      q('#btnSoloGuardar').addEventListener('click', () => guardar(false));
      q('#btnGuardarPDF').addEventListener('click', () => guardar(true));

      recalcular();
      renderDescs();

      pagosCtl = montarPagos(ctx, { getTotal: () => valorMonto(q('#liqTotal').value) });
      q('#liqTotal').addEventListener('input', () => pagosCtl?.refrescarTotal());
    }
  });
}

/* ── Formulario liquidar (crear ya pagada) ── */
export function abrirFormLiquidacion(pre, onDone) {
  const { alquileres, clientes, propietarios, propiedades } = getState();
  const alq   = pre?.alq  || {};
  const cobro = pre?.cobro || {};
  const own   = propietarios.find(p => p.id === alq.propietarioId) || {};
  const prop  = propiedades.find(p => p.id === alq.propiedadId)    || {};
  const inq   = clientes.find(c => c.id === alq.inquilinoId)       || {};
  const monto = cobro.monto || alq.montoActual || alq.montoInicial || 0;
  const pctDef = alq.pctHonorarios ?? alq.comision ?? 10;
  const hoy   = new Date().toISOString().slice(0, 10);

  let descIdx = 0;

  openModal({
    title: 'Liquidar al propietario',
    size: 'lg',
    bodyHTML: `
      <form id="liqForm">
        <!-- Info del cobro -->
        <div style="background:var(--surface-2);border-radius:var(--r-md);padding:.85rem 1rem;margin-bottom:1.25rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
          <div>
            <div style="font-size:.72rem;color:var(--text-soft);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.2rem">Cobro a liquidar</div>
            <div style="font-weight:700">${esc(own?.nombre || '—')}</div>
            <div style="font-size:.82rem;color:var(--text-soft)">${esc(prop?.direccion || '—')} · ${mesLabel(cobro.mes)}</div>
            <div style="font-size:.78rem;color:var(--text-faint)">Inquilino: ${esc(inq?.nombre || '—')} · Cobrado el ${fmtFecha(cobro.fechaPago)}</div>
          </div>
          <div style="font-size:1.4rem;font-weight:900">${fmt$(monto)}</div>
        </div>

        <h3 class="form-section-title">Honorarios de la inmobiliaria</h3>
        <div class="form-grid" style="margin-bottom:1.1rem">
          <div class="form-group">
            <label>% Honorarios</label>
            <input name="pctHonorarios" id="liqPct" type="number" min="0" max="100" step="0.5" value="${pctDef}">
          </div>
          <div class="form-group">
            <label>Monto honorarios $</label>
            <input id="liqMontoHon" type="text" readonly style="background:var(--surface-2);font-weight:700">
          </div>
          <div class="form-group">
            <label style="color:var(--success);font-weight:700">Total a pagar al propietario $</label>
            <input name="totalPagar" id="liqTotal" type="text" inputmode="numeric" class="input-monto" style="font-size:1.1rem;font-weight:800;color:var(--success)">
          </div>
        </div>

        <h3 class="form-section-title">Descuentos / deducciones</h3>
        <div id="descBlk" style="margin-bottom:.5rem"></div>
        <button type="button" id="btnAddDesc" class="btn btn-sm btn-ghost" style="margin-bottom:1.25rem">${icon('plus')} Agregar descuento</button>

        <h3 class="form-section-title">Datos del pago</h3>
        <div class="form-grid">
          <div class="form-group">
            <label>Fecha de pago <span class="req">*</span></label>
            <input name="fechaPago" type="date" value="${hoy}">
          </div>
          ${pagosBlockHTML()}
          <div class="form-group full">
            <label>Notas</label>
            <input name="notas" placeholder="Observaciones opcionales">
          </div>
        </div>
      </form>`,
    footerHTML: `<button class="btn btn-ghost" data-close>Cancelar</button>
                 <button class="btn btn-ghost" id="btnSoloGuardar">Guardar sin PDF</button>
                 <button class="btn btn-primary" id="btnGuardarPDF">Guardar y generar PDF</button>`,
    onMount(ctx) {
      const q = (sel) => ctx.overlay.querySelector(sel);
      let pagosCtl = null;

      const recalcular = () => {
        const pct  = Number(q('#liqPct').value) || 0;
        const hon  = Math.round(monto * pct / 100);
        const desc = [...ctx.overlay.querySelectorAll('[name^="desc_monto"]')]
          .reduce((s, i) => s + valorMonto(i.value), 0);
        q('#liqMontoHon').value = fmtMontoInput(hon);
        q('#liqTotal').value    = fmtMontoInput(Math.max(0, monto - hon - desc));
        pagosCtl?.refrescarTotal();
      };
      recalcular();

      q('#liqPct').addEventListener('input', recalcular);

      const addDescRow = () => {
        const blk = q('#descBlk');
        const idx = descIdx++;
        const div = document.createElement('div');
        div.className = 'desc-row form-grid';
        div.style.cssText = 'align-items:end;gap:.5rem;margin-bottom:.5rem';
        div.innerHTML = `
          <div class="form-group" style="flex:2;margin:0">
            <label style="font-size:.75rem">Concepto</label>
            <input name="desc_concepto_${idx}" placeholder="Ej. Reparación caño">
          </div>
          <div class="form-group" style="flex:1;margin:0">
            <label style="font-size:.75rem">Monto $</label>
            <input name="desc_monto_${idx}" type="text" inputmode="numeric" class="input-monto">
          </div>
          <button type="button" class="btn btn-xs btn-ghost" style="color:var(--danger);margin-bottom:.1rem" data-rm>${icon('trash')}</button>`;
        blk.appendChild(div);
        div.querySelector('[data-rm]').addEventListener('click', () => { div.remove(); recalcular(); });
        div.querySelector(`[name="desc_monto_${idx}"]`).addEventListener('input', recalcular);
      };

      q('#btnAddDesc').addEventListener('click', addDescRow);

      const guardar = async (conPDF) => {
        const f = q('#liqForm');
        if (!f.fechaPago.value) { toast('Indicá la fecha de pago', { tipo: 'warning' }); return; }

        const totalPagar = valorMonto(f.totalPagar.value);
        const pagos = pagosCtl.getPagos();
        if (!pagos.length) { toast('Indicá la forma de pago', { tipo: 'warning' }); return; }
        if (pagos.length > 1) {
          const suma = pagos.reduce((s, p) => s + p.monto, 0);
          if (Math.round(suma * 100) !== Math.round(totalPagar * 100)) {
            toast('La suma de las formas de pago no coincide con el total a pagar', { tipo: 'warning' });
            return;
          }
        }

        const descuentos = [...ctx.overlay.querySelectorAll('.desc-row')].map((row, i) => ({
          concepto: row.querySelector('[name^="desc_concepto"]')?.value || '',
          monto:    valorMonto(row.querySelector('[name^="desc_monto"]')?.value),
        })).filter(d => d.concepto && d.monto);

        const data = {
          alquilerId:     alq.id,
          propiedadId:    alq.propiedadId,
          propietarioId:  alq.propietarioId,
          cobroId:        cobro.id,
          mes:            cobro.mes,
          montoAlquiler:  monto,
          pctHonorarios:  Number(f.pctHonorarios.value) || 0,
          montoHonorarios:valorMonto(q('#liqMontoHon').value),
          totalPagar,
          descuentos,
          estado:    'pagada',
          fechaPago: f.fechaPago.value,
          formaPago: pagos.length > 1 ? pagos.map(p => p.metodoPago).join(' + ') : pagos[0].metodoPago,
          pagos,
          notas:     f.notas.value || null,
        };

        // Guardar % en el contrato para la próxima
        if (alq.id && data.pctHonorarios !== (alq.pctHonorarios ?? alq.comision)) {
          await actions.updateAlquiler(alq.id, { pctHonorarios: data.pctHonorarios });
        }

        const liq = await actions.createLiquidacion(data);

        if (conPDF && liq) {
          // Se llama de forma síncrona respecto al click para evitar que el navegador bloquee el pop-up
          const cobroSint = { monto: liq.montoAlquiler, mes: liq.mes, fechaPago: liq.fechaPago };
          imprimirLiquidacion({
            alq,
            cobro: cobroSint,
            inquilino: inq,
            propiedad: prop,
            propietario: own,
            pctHonorarios: liq.pctHonorarios || 0,
            descuentos: liq.descuentos || [],
            formaPago: liq.formaPago || 'Efectivo',
            pagos: liq.pagos || [],
          });
        }

        toast('Liquidación registrada');
        ctx.close();
        onDone?.();
      };

      q('#btnSoloGuardar').addEventListener('click', () => guardar(false));
      q('#btnGuardarPDF').addEventListener('click', () => guardar(true));

      pagosCtl = montarPagos(ctx, { getTotal: () => valorMonto(q('#liqTotal').value) });
      q('#liqTotal').addEventListener('input', () => pagosCtl?.refrescarTotal());
    },
  });
}

/* ── Liquidación mensual de alquiler temporal (reparto dueño/inmobiliaria + gastos) ── */
export function abrirLiquidacionTemporalModal(onDone, preselectPropietarioId) {
  const { propiedades, propietarios } = getState();
  const propsTemp = propiedades.filter(p => p.habilitadaTemporal);
  // Dueños que tienen al menos una propiedad de alquiler temporal — se liquidan
  // TODAS sus propiedades juntas, en una sola factura.
  const dueñosIds = [...new Set(propsTemp.map(p => p.propietarioId).filter(Boolean))];
  const dueños = dueñosIds
    .map(id => propietarios.find(p => p.id === id))
    .filter(Boolean)
    .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es'));

  if (!dueños.length) {
    toast('No hay propiedades habilitadas para alquiler temporal con un dueño asignado', { tipo: 'warning' });
    return;
  }

  const hoy = new Date();
  const mesHoy = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
  let gastos = []; // { concepto, monto, pagadoPor }

  openModal({
    title: '💰 Liquidación mensual — Alquiler temporal',
    size: 'xl',
    bodyHTML: `
      <div class="form-grid" style="margin-bottom:1rem">
        <div class="form-group">
          <label>Dueño</label>
          <select id="liqTPropietario">${dueños.map(d => `<option value="${d.id}" ${d.id === preselectPropietarioId ? 'selected' : ''}>${esc(d.nombre)}</option>`).join('')}</select>
          <small class="text-xs text-soft" style="margin-top:.25rem;display:block">Se liquidan juntas todas sus propiedades de alquiler temporal.</small>
        </div>
        <div class="form-group">
          <label>Mes</label>
          <input id="liqTMes" type="month" value="${mesHoy}">
        </div>
      </div>
      <div id="liqTBody"></div>
    `,
    footerHTML: `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-ghost" id="btnSoloGuardarLiqT">Guardar sin PDF</button>
      <button class="btn btn-primary" id="btnGuardarPDFLiqT">Guardar y generar PDF</button>`,
    onMount(ctx) {
      const q = sel => ctx.overlay.querySelector(sel);
      const bodyEl = q('#liqTBody');

      // Los gastos NO se reembolsan a 70/30 por separado: se restan del bruto
      // cobrado y recién ese neto es el que se reparte 70/30 (como el resto).
      // A quien pagó el gasto de su bolsillo se le descuenta de lo que tiene
      // realmente en su cuenta, antes de comparar contra el teórico.
      const calcularConGastos = () => {
        const propietarioId = q('#liqTPropietario').value;
        const mes = q('#liqTMes').value || mesHoy;
        const calc = calcularLiquidacionTemporal(propietarioId, mes);

        const gastosGaston = gastos.reduce((s, g) => s + (g.pagadoPor === 'gaston' ? (Number(g.monto) || 0) : 0), 0);
        const gastosPropietario = gastos.reduce((s, g) => s + (g.pagadoPor === 'propietario' ? (Number(g.monto) || 0) : 0), 0);
        const gastosTotal = gastosGaston + gastosPropietario;

        const bruto = calc.totalBase + calc.totalExtension;
        const neto = bruto - gastosTotal;
        const teoricoDueñoNeto = neto * (calc.pctDueño / 100);
        const teoricoGastonNeto = neto * (calc.pctGaston / 100);
        const realGastonNeto = calc.realGaston - gastosGaston;
        const realPropietarioNeto = calc.realPropietario - gastosPropietario;

        const diffFinal = Math.round((realGastonNeto - teoricoGastonNeto) * 100) / 100;
        return { propietarioId, mes, calc, bruto, gastosTotal, neto, teoricoDueñoNeto, teoricoGastonNeto, realGastonNeto, realPropietarioNeto, diffFinal };
      };

      const render = () => {
        const { propietarioId, mes, calc, gastosTotal, neto, teoricoDueñoNeto, teoricoGastonNeto, diffFinal } = calcularConGastos();
        const own = dueños.find(d => d.id === propietarioId);
        const nombresProps = calc.propiedades.map(p => p.nombreTemporal || p.direccion).join(', ');

        bodyEl.innerHTML = `
          <div style="background:var(--surface-2);border-radius:var(--r-md);padding:1rem;margin-bottom:1rem">
            <div style="font-size:.72rem;color:var(--text-soft);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.3rem">
              ${esc(own?.nombre || '—')} · ${calc.propiedades.length} propiedad${calc.propiedades.length !== 1 ? 'es' : ''}: ${esc(nombresProps || '—')}
            </div>
            <div style="font-size:.72rem;color:var(--text-soft);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.6rem">
              Reparto: ${calc.pctDueño}% dueño / ${calc.pctGaston}% inmobiliaria sobre el neto (bruto − gastos) · incluye la estadía extendida
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem">
              <div>
                <div style="font-size:.68rem;color:var(--text-soft)">Alquiler (base)</div>
                <div style="font-weight:700">$${Math.round(calc.totalBase).toLocaleString('es-AR')}</div>
              </div>
              <div>
                <div style="font-size:.68rem;color:var(--text-soft)">Estadía extendida</div>
                <div style="font-weight:700">$${Math.round(calc.totalExtension).toLocaleString('es-AR')}</div>
              </div>
              <div>
                <div style="font-size:.68rem;color:var(--text-soft)">Gastos del mes</div>
                <div id="liqTGastosTotalVal" style="font-weight:700">${gastosTotal ? '−$' + Math.round(gastosTotal).toLocaleString('es-AR') : '$0'}</div>
              </div>
              <div>
                <div style="font-size:.68rem;color:var(--text-soft)">Neto a repartir</div>
                <div id="liqTNetoVal" style="font-weight:700">$${Math.round(neto).toLocaleString('es-AR')}</div>
              </div>
              <div>
                <div style="font-size:.68rem;color:var(--text-soft)">Teórico dueño</div>
                <div id="liqTTeoricoDuenoVal" style="font-weight:700">$${Math.round(teoricoDueñoNeto).toLocaleString('es-AR')}</div>
              </div>
              <div>
                <div style="font-size:.68rem;color:var(--text-soft)">Teórico inmobiliaria</div>
                <div id="liqTTeoricoGastonVal" style="font-weight:700">$${Math.round(teoricoGastonNeto).toLocaleString('es-AR')}</div>
              </div>
              <div>
                <div style="font-size:.68rem;color:var(--text-soft)">Real en cta. Gastón</div>
                <div style="font-weight:700">$${Math.round(calc.realGaston).toLocaleString('es-AR')}</div>
              </div>
              <div>
                <div style="font-size:.68rem;color:var(--text-soft)">Real en cta. dueño</div>
                <div style="font-weight:700">$${Math.round(calc.realPropietario).toLocaleString('es-AR')}</div>
              </div>
            </div>
          </div>

          ${calc.detalle.length ? `
          <div style="max-height:180px;overflow-y:auto;margin-bottom:1rem;border:1px solid var(--border);border-radius:var(--r-sm)">
            <table style="width:100%;font-size:.78rem;border-collapse:collapse">
              <thead><tr style="background:var(--surface-2)">
                <th style="padding:.4rem .6rem;text-align:left">Propiedad</th>
                <th style="text-align:left">Huésped</th>
                <th style="text-align:left">Tipo</th>
                <th style="text-align:left">Cuenta</th>
                <th style="text-align:right;padding-right:.6rem">Monto</th>
              </tr></thead>
              <tbody>
                ${calc.detalle.flatMap(d => d.eventos.map(e => `
                  <tr>
                    <td style="padding:.35rem .6rem">${esc(d.prop.nombreTemporal || d.prop.direccion)}</td>
                    <td>${esc(d.t.huesped || '—')}</td>
                    <td>${e.tipo === 'senia' ? 'Seña' : 'Resto'}</td>
                    <td>${cuentaLabel(e.cuenta)}</td>
                    <td style="text-align:right;padding-right:.6rem;font-weight:600">$${Math.round(e.monto).toLocaleString('es-AR')}</td>
                  </tr>`).join('')).join('')}
              </tbody>
            </table>
          </div>` : `<div style="color:var(--text-faint);font-size:.82rem;margin-bottom:1rem">No hay cobros de estas propiedades en ${mes} pendientes de liquidar.</div>`}

          <h3 class="form-section-title">Gastos del mes (agua, luz, gas, reparaciones, etc.)</h3>
          <div id="liqTGastos" style="margin-bottom:.5rem"></div>
          <button type="button" id="btnAddGastoT" class="btn btn-sm btn-ghost" style="margin-bottom:1rem">${icon('plus')} Agregar gasto</button>

          <div style="border-top:2px solid var(--border);padding-top:.85rem;display:flex;justify-content:flex-end;align-items:center;flex-wrap:wrap;gap:.5rem">
            <div style="text-align:right">
              <div style="font-size:.72rem;color:var(--text-soft)">Resultado</div>
              <div id="liqTResultadoTexto" style="font-size:1.1rem;font-weight:900;color:${diffFinal === 0 ? 'var(--text-soft)' : 'var(--primary)'}">
                ${diffFinal === 0 ? 'Todo saldado' : diffFinal > 0
                  ? `Gastón transfiere $${Math.abs(Math.round(diffFinal)).toLocaleString('es-AR')} al dueño`
                  : `El dueño transfiere $${Math.abs(Math.round(diffFinal)).toLocaleString('es-AR')} a Gastón`}
              </div>
            </div>
          </div>
        `;

        renderGastos();
      };

      // Recalcula el neto, el teórico y el resultado final sin reconstruir los
      // inputs de gastos — así no se pierde el foco mientras se escribe el monto.
      const actualizarResultado = () => {
        const { gastosTotal, neto, teoricoDueñoNeto, teoricoGastonNeto, diffFinal } = calcularConGastos();
        const set = (id, texto) => { const el = q(id); if (el) el.textContent = texto; };

        set('#liqTGastosTotalVal', gastosTotal ? '−$' + Math.round(gastosTotal).toLocaleString('es-AR') : '$0');
        set('#liqTNetoVal', '$' + Math.round(neto).toLocaleString('es-AR'));
        set('#liqTTeoricoDuenoVal', '$' + Math.round(teoricoDueñoNeto).toLocaleString('es-AR'));
        set('#liqTTeoricoGastonVal', '$' + Math.round(teoricoGastonNeto).toLocaleString('es-AR'));

        const resultadoEl = q('#liqTResultadoTexto');
        if (resultadoEl) {
          resultadoEl.textContent = diffFinal === 0 ? 'Todo saldado' : diffFinal > 0
            ? `Gastón transfiere $${Math.abs(Math.round(diffFinal)).toLocaleString('es-AR')} al dueño`
            : `El dueño transfiere $${Math.abs(Math.round(diffFinal)).toLocaleString('es-AR')} a Gastón`;
          resultadoEl.style.color = diffFinal === 0 ? 'var(--text-soft)' : 'var(--primary)';
        }
      };

      const renderGastos = () => {
        const blk = q('#liqTGastos');
        blk.innerHTML = gastos.map((g, i) => `
          <div style="display:flex;gap:.5rem;align-items:flex-end;margin-bottom:.5rem;flex-wrap:wrap" data-gasto-idx="${i}">
            <div class="form-group" style="margin:0;flex:1;min-width:150px">
              <label style="font-size:.72rem">Concepto</label>
              <input data-f="concepto" value="${esc(g.concepto || '')}" placeholder="Ej: Agua, luz, gas, reparación...">
            </div>
            <div class="form-group" style="margin:0;width:120px">
              <label style="font-size:.72rem">Monto $</label>
              <input type="text" inputmode="numeric" class="input-monto" data-f="monto" value="${fmtMontoInput(g.monto)}">
            </div>
            <div class="form-group" style="margin:0;min-width:170px">
              <label style="font-size:.72rem">Lo pagó</label>
              <select data-f="pagadoPor">
                <option value="gaston" ${g.pagadoPor === 'gaston' ? 'selected' : ''}>Gastón (inmobiliaria)</option>
                <option value="propietario" ${g.pagadoPor === 'propietario' ? 'selected' : ''}>Dueño del depto</option>
              </select>
            </div>
            <button type="button" class="btn btn-xs btn-ghost" data-del-gasto="${i}" style="color:var(--danger)">✕</button>
          </div>`).join('');

        blk.querySelectorAll('[data-gasto-idx]').forEach(row => {
          const i = Number(row.dataset.gastoIdx);
          row.querySelector('[data-f="concepto"]').addEventListener('input', e => { gastos[i].concepto = e.target.value; });
          row.querySelector('[data-f="monto"]').addEventListener('input', e => { gastos[i].monto = valorMonto(e.target.value); actualizarResultado(); });
          row.querySelector('[data-f="pagadoPor"]').addEventListener('change', e => { gastos[i].pagadoPor = e.target.value; actualizarResultado(); });
        });
        blk.querySelectorAll('[data-del-gasto]').forEach(btn => {
          btn.addEventListener('click', () => { gastos.splice(Number(btn.dataset.delGasto), 1); render(); });
        });
      };

      q('#liqTPropietario').addEventListener('change', () => { gastos = []; render(); });
      q('#liqTMes').addEventListener('change', () => { gastos = []; render(); });

      ctx.overlay.addEventListener('click', (e) => {
        if (e.target.closest('#btnAddGastoT')) {
          gastos.push({ concepto: '', monto: 0, pagadoPor: 'gaston' });
          renderGastos();
        }
      });

      render();

      const guardar = async (conPDF) => {
        const { propietarioId, mes, calc, gastosTotal, neto, teoricoDueñoNeto, teoricoGastonNeto, diffFinal } = calcularConGastos();
        if (!calc.detalle.length) { toast('No hay cobros para liquidar en ese mes', { tipo: 'warning' }); return; }

        const propietario = dueños.find(d => d.id === propietarioId);

        const data = {
          propietarioId,
          propiedadesIds: calc.propiedades.map(p => p.id),
          mes,
          pctDueño: calc.pctDueño,
          pctGaston: calc.pctGaston,
          totalBase: calc.totalBase,
          totalExtension: calc.totalExtension,
          gastosTotal: Math.round(gastosTotal),
          neto: Math.round(neto),
          teoricoDueño: Math.round(teoricoDueñoNeto),
          teoricoGaston: Math.round(teoricoGastonNeto),
          realGaston: calc.realGaston,
          realPropietario: calc.realPropietario,
          gastos: gastos.filter(g => Number(g.monto) > 0),
          diffFinal,
          transferencia: diffFinal === 0 ? null : { desde: diffFinal > 0 ? 'gaston' : 'propietario', monto: Math.abs(diffFinal) },
          senasIncluidas: calc.senasIncluidas,
          pagosRestoIncluidos: calc.pagosRestoIncluidos,
        };

        const liq = await actions.createLiquidacionTemporal(data);
        if (conPDF && liq) {
          imprimirLiquidacionTemporal({ liquidacion: liq, propiedades: calc.propiedades, propietario });
        }
        toast('Liquidación registrada');
        ctx.close();
        onDone?.();
      };

      q('#btnSoloGuardarLiqT').addEventListener('click', () => guardar(false));
      q('#btnGuardarPDFLiqT').addEventListener('click', () => guardar(true));
    },
  });
}
