/* Sorteo de material - frontend.
 *
 * Reparto de responsabilidades:
 *   - El catálogo de objetos vive en data/items.csv, dentro del repositorio.
 *     Se edita con Excel y se sube; la web lo recoge sola.
 *   - Las elecciones y los ajustes viven en Supabase, que es lo que permite que
 *     te lleguen sin que nadie tenga que mandarte nada.
 *   - El participante es un código anónimo (P-07). Ni su nombre ni su correo
 *     salen de la lista que el organizador guarda en su ordenador.
 *
 * El máximo por persona y la fecha límite se comprueban en el servidor
 * (trigger y políticas RLS). Lo que hace esta página es solo pintarlo.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TZ = 'Europe/Madrid';
  const DOMINIO_INTERNO = 'sorteo.invalid';   // dominio ficticio; nunca se envía correo a él

  const state = {
    cfg: null,
    clavePublica: null,
    codigo: null,
    userId: null,
    settings: null,      // { max_items, deadline }
    items: [],
    sel: new Set(),
    busy: new Set(),
    timers: [],
  };
  let sb = null;

  // ---------- utilidades ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtDate = (iso) => new Intl.DateTimeFormat('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: TZ,
  }).format(new Date(iso));

  const isOpen = () => !!state.settings && Date.now() < new Date(state.settings.deadline).getTime();

  function remainingText() {
    const ms = new Date(state.settings.deadline).getTime() - Date.now();
    if (ms <= 0) return '';
    const min = Math.floor(ms / 60000);
    const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    if (d > 0) return `quedan ${d} día${d === 1 ? '' : 's'} y ${h} h`;
    if (h > 0) return `quedan ${h} h y ${m} min`;
    return `quedan ${m} min`;
  }

  /**
   * Admite P-07, p07, P 7, p-7... y devuelve siempre { codigo: 'P-07', slug: 'p07' }.
   * Tiene que coincidir exactamente con la misma función de scripts/_lib.mjs.
   */
  function normalizaCodigo(entrada) {
    const limpio = String(entrada || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const m = limpio.match(/^([A-Z]+)(\d+)$/);
    if (!m) return null;
    const num = String(Number(m[2])).padStart(2, '0');
    return { codigo: `${m[1]}-${num}`, slug: `${m[1].toLowerCase()}${num}` };
  }

  let toastTimer;
  function toast(msg, kind = 'info') {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast ${kind}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3400);
  }

  function friendlyError(error) {
    if (!error) return 'Error desconocido';
    if (error.code === 'P0001') return error.message;   // mensaje del trigger del servidor
    if (error.code === '42501') return 'El plazo ha terminado: ya no se pueden hacer cambios.';
    if (error.code === '23505') return 'Ese objeto ya estaba en tu lista.';
    return 'No se pudo guardar. Inténtalo de nuevo.';
  }

  /** Lector de CSV con cabecera: detecta separador (; o ,), quita el BOM y admite comillas. */
  function parseCsv(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lines.length) return [];
    const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
    const parseLine = (line) => {
      const out = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') inQ = false;
          else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === sep) { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out.map((v) => v.trim());
    };
    const headers = parseLine(lines[0]).map((h) => h.toLowerCase());
    return lines.slice(1).map((line) => {
      const vals = parseLine(line);
      const row = {};
      headers.forEach((h, i) => { row[h] = vals[i] ?? ''; });
      return row;
    });
  }

  const truthy = (v) => /^(s[ií]|s|y|yes|true|1|x|ok)$/i.test(String(v ?? '').trim());

  // ---------- carga de datos ----------
  async function cargarConfig() {
    const r = await fetch(`data/config.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('No se pudo leer data/config.json');
    state.cfg = await r.json();

    // Supabase llama ahora "publishable key" a lo que antes era la "anon key".
    // Se admiten los dos nombres para que valga cualquiera de los dos.
    state.clavePublica = (state.cfg.supabase_publishable_key || state.cfg.supabase_anon_key || '').trim();

    // El panel de Supabase muestra la "API URL" acabada en /rest/v1/. La librería
    // añade ella sola esa parte y la de autenticación, así que aquí solo vale la
    // dirección del proyecto. Se recorta por si se pega la otra.
    state.cfg.supabase_url = String(state.cfg.supabase_url || '').trim()
      .replace(/\/+$/, '')
      .replace(/\/(rest|auth|storage|realtime)\/v\d+$/i, '')
      .replace(/\/+$/, '');

    const sinRellenar = (v) => !v || /TU-(PROYECTO|CLAVE|ANON)/i.test(v);
    if (sinRellenar(state.cfg.supabase_url) || sinRellenar(state.clavePublica)) {
      throw new Error('sin-configurar');
    }
  }

  /**
   * Excel guarda los CSV en la codificación de Windows (Windows-1252), no en UTF-8.
   * Si items.csv se guarda desde Excel, leerlo como UTF-8 rompe las tildes y las eñes,
   * así que se prueban las dos codificaciones.
   */
  function decodifica(buffer) {
    let texto;
    try {
      texto = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      texto = new TextDecoder('windows-1252').decode(buffer);
    }
    return texto;
  }

  async function cargarItems() {
    const r = await fetch(`data/items.csv?v=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('No se pudo leer data/items.csv');
    state.items = parseCsv(decodifica(await r.arrayBuffer())).map((f, idx) => ({
      id: Number(f.id) || idx + 1,
      categoria: (f.categoria || '').trim(),
      nombre: (f.nombre || '').trim(),
      verificado: truthy(f.funciona),
      notas: (f.notas || '').trim(),
    })).filter((it) => it.categoria && it.nombre);
  }

  async function cargarDesdeServidor() {
    const [s, sel] = await Promise.all([
      sb.from('settings').select('max_items, deadline').eq('id', 1).single(),
      sb.from('selections').select('item_id').eq('user_id', state.userId),
    ]);
    if (s.error || sel.error) {
      console.error(s.error || sel.error);
      toast('No se pudieron cargar tus datos. Recarga la página.', 'error');
      return false;
    }
    state.settings = s.data;
    state.sel = new Set(sel.data.map((r) => r.item_id));
    return true;
  }

  // ---------- arranque ----------
  async function init() {
    try {
      await cargarConfig();
    } catch (e) {
      $('loading').textContent = e.message === 'sin-configurar'
        ? 'Falta rellenar data/config.json con los datos del proyecto de Supabase.'
        : 'No se pudieron cargar los datos del sorteo. Recarga la página.';
      console.error(e);
      return;
    }

    $('login-title').textContent = state.cfg.titulo || 'Sorteo de material';
    document.title = state.cfg.titulo || 'Sorteo de material';

    sb = window.supabase.createClient(state.cfg.supabase_url, state.clavePublica);

    try {
      await cargarItems();
    } catch (e) {
      $('loading').textContent = 'No se pudo cargar la lista de objetos. Recarga la página.';
      console.error(e);
      return;
    }

    sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') salir(); });

    const { data: { session } } = await sb.auth.getSession();
    if (session) await entrar(session.user, false);
    else $('view-login').hidden = false;
    $('loading').hidden = true;
  }

  async function entrar(user, esNuevoAcceso) {
    state.userId = user.id;

    const { data: perfil } = await sb.from('profiles').select('codigo').eq('id', user.id).single();
    state.codigo = perfil?.codigo || normalizaCodigo(user.email.split('@')[0])?.codigo || '';
    $('user-code').textContent = `Participante ${state.codigo}`;

    if (!await cargarDesdeServidor()) return;

    $('view-login').hidden = true;
    $('view-app').hidden = false;
    renderHeader();
    renderFilters();
    render();

    if (esNuevoAcceso && !sessionStorage.getItem('avisoVisto')) mostrarAviso();

    state.timers.push(setInterval(refrescar, 60_000));   // recoge cambios de items.csv y ajustes
    state.timers.push(setInterval(render, 30_000));       // cuenta atrás y cierre del plazo
  }

  function salir() {
    state.timers.forEach(clearInterval);
    state.timers = [];
    state.codigo = null;
    state.userId = null;
    state.sel = new Set();
    sessionStorage.removeItem('avisoVisto');
    $('view-app').hidden = true;
    $('view-login').hidden = false;
    $('login-pass').value = '';
  }

  /** Recoge cambios del catálogo (marcas de "funciona") y de los ajustes. */
  async function refrescar() {
    try { await cargarItems(); } catch { /* si falla, se mantiene lo que ya había */ }
    const { data, error } = await sb.from('settings').select('max_items, deadline').eq('id', 1).single();
    if (!error) state.settings = data;
    renderFilters();
    render();
  }

  // ---------- selección ----------
  async function toggle(itemId) {
    if (!isOpen()) { toast('El plazo ha terminado.', 'warn'); render(); return; }
    if (state.busy.has(itemId)) return;

    const yaEstaba = state.sel.has(itemId);
    if (!yaEstaba && state.sel.size >= state.settings.max_items) {
      toast(`Solo puedes elegir ${state.settings.max_items} objetos. Quita uno para elegir otro.`, 'warn');
      render();
      return;
    }

    state.busy.add(itemId);
    render();

    let error;
    if (yaEstaba) {
      ({ error } = await sb.from('selections').delete().match({ user_id: state.userId, item_id: itemId }));
    } else {
      ({ error } = await sb.from('selections').insert({ user_id: state.userId, item_id: itemId }));
    }
    state.busy.delete(itemId);

    if (error) {
      console.error(error);
      toast(friendlyError(error), 'error');
      const { data } = await sb.from('selections').select('item_id').eq('user_id', state.userId);
      if (data) state.sel = new Set(data.map((r) => r.item_id));
    } else {
      if (yaEstaba) state.sel.delete(itemId); else state.sel.add(itemId);
      const it = state.items.find((i) => i.id === itemId);
      toast(yaEstaba ? `Quitado: ${it?.nombre ?? ''}` : `Guardado: ${it?.nombre ?? ''}`, 'ok');
    }
    render();
  }

  // ---------- render ----------
  function renderHeader() {
    $('app-title').textContent = state.cfg.titulo || 'Sorteo de material';
  }

  /** Cuenta atrás, aviso de cierre y máximo. Se llama desde render() para que
   *  el texto y las casillas no puedan quedar diciendo cosas distintas. */
  function renderPlazo() {
    const s = state.settings;
    const open = isOpen();
    $('deadline-info').textContent = open
      ? `Puedes modificar tu elección hasta el ${fmtDate(s.deadline)} (${remainingText()}).`
      : `El plazo cerró el ${fmtDate(s.deadline)}.`;
    $('closed-banner').hidden = open;
    $('count-max').textContent = s.max_items;
    $('warn-max').textContent = s.max_items;
    $('warn-deadline').textContent = fmtDate(s.deadline);
  }

  function renderFilters() {
    const sel = $('filter-category');
    const actual = sel.value;
    const cats = [...new Set(state.items.map((it) => it.categoria))].sort((a, b) => a.localeCompare(b, 'es'));
    sel.innerHTML = '<option value="">Todas</option>' +
      cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (cats.includes(actual)) sel.value = actual;
  }

  function render() {
    renderPlazo();
    const cat = $('filter-category').value;
    const soloVerificados = $('filter-verified').checked;
    const soloMias = $('filter-mine').checked;
    const open = isOpen();
    const max = state.settings.max_items;
    const lleno = state.sel.size >= max;

    const lista = state.items.filter((it) =>
      (!cat || it.categoria === cat) &&
      (!soloVerificados || it.verificado) &&
      (!soloMias || state.sel.has(it.id)));

    $('items-grid').innerHTML = lista.map((it) => {
      const sel = state.sel.has(it.id);
      const busy = state.busy.has(it.id);
      const disabled = !open || busy || (lleno && !sel);
      const badge = it.verificado
        ? '<span class="badge ok" title="Se ha comprobado que funciona">✔ Funciona</span>'
        : '<span class="badge unknown" title="Nadie ha comprobado todavía si funciona">Sin comprobar</span>';
      const texto = busy ? 'Guardando…' : (sel ? 'Elegido' : 'Lo quiero');
      return `
        <label class="item ${sel ? 'selected' : ''} ${disabled ? 'disabled' : ''}" data-id="${it.id}">
          <div class="item-head"><span class="cat">${esc(it.categoria)}</span>${badge}</div>
          <div class="name">${esc(it.nombre)}</div>
          ${it.notas ? `<div class="notes">${esc(it.notas)}</div>` : ''}
          <div class="pick">
            <input type="checkbox" ${sel ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
            <span>${texto}</span>
          </div>
        </label>`;
    }).join('');
    $('items-empty').hidden = lista.length > 0;

    const counter = $('count-selected');
    counter.textContent = state.sel.size;
    counter.parentElement.classList.toggle('full', lleno);
    $('edit-hint').hidden = !open;

    const mias = state.items.filter((it) => state.sel.has(it.id));
    $('my-selections').innerHTML = mias.length
      ? mias.map((it) => `
          <li>
            <span><span class="cat">${esc(it.categoria)}</span><br>${esc(it.nombre)}</span>
            ${open ? `<button type="button" data-remove="${it.id}" title="Quitar" aria-label="Quitar ${esc(it.nombre)}">✕</button>` : ''}
          </li>`).join('')
      : '<li class="empty">Todavía no has elegido nada.</li>';
  }

  function mostrarAviso() {
    $('modal-warning').hidden = false;
    $('warn-ok').focus();
  }

  // ---------- eventos ----------
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error');
    const btn = $('login-btn');
    err.hidden = true;

    const norm = normalizaCodigo($('login-code').value);
    if (!norm) {
      err.textContent = 'El código tiene que ser del tipo P-07.';
      err.hidden = false;
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Entrando…';
    const { data, error } = await sb.auth.signInWithPassword({
      email: `${norm.slug}@${DOMINIO_INTERNO}`,
      password: $('login-pass').value.trim(),
    });
    btn.disabled = false;
    btn.textContent = 'Entrar';

    if (error) {
      err.textContent = /invalid/i.test(error.message)
        ? 'El código o la clave no son correctos.'
        : 'No se pudo entrar. Inténtalo de nuevo.';
      err.hidden = false;
      return;
    }
    $('login-pass').value = '';
    await entrar(data.user, true);
  });

  $('logout-btn').addEventListener('click', async () => {
    await sb.auth.signOut();
    salir();
  });

  $('warn-ok').addEventListener('click', () => {
    sessionStorage.setItem('avisoVisto', '1');
    $('modal-warning').hidden = true;
  });

  $('items-grid').addEventListener('change', (e) => {
    const card = e.target.closest('.item');
    if (card) toggle(Number(card.dataset.id));
  });

  $('my-selections').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-remove]');
    if (btn) toggle(Number(btn.dataset.remove));
  });

  ['filter-category', 'filter-verified', 'filter-mine'].forEach((id) =>
    $(id).addEventListener('change', render));

  init().catch((e) => {
    console.error(e);
    $('loading').textContent = 'Error al iniciar la aplicación. Recarga la página.';
  });
})();
