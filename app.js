// =============================================
// CONFIGURACIÓN
// =============================================
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxGWExWXXLN0lmWASnP52oQsq2m8ynW9-Ku6To07AQxMWS0S8bC5dfqu3Oj27gYXTKgVA/exec';

// =============================================
// ESTADO LOCAL
// =============================================
let DB = {
  usuarios:  [],
  productos: [],
  ventas:    [],
  clientes:  [],
  deudores:  [],
  anticipos: [],
  proveedores: [],
  gastos:    [],
  traslados: [],
  config:    { stockMin: 5, trasladoContador: 0 }
};

let sesion              = null;
let precioCompraVisible = false;
let carrito             = [];
let editandoProductoId  = null;
let carritoItemEditando = null;
let rapidoProductoActual = null;
let periodoreporte      = 'semana';
let traslado             = [];
let trasladoProductoActual = null;
let facturaVentaActual  = null;
let autoSyncInterval    = null;
let resultadosVenta     = [];
let indiceVenta         = 0;
let resultadosTraslado  = [];
let indiceTraslado      = 0;
let editandoDeudorId    = null;
let deudorAbonoActual   = null;
let tipoAbonoActual     = 'deudor';
let gastoCategoriaSeleccionada = null;
let productosDeudor   = [];
let productosAnticipo = [];
let editandoAnticipoId  = null;
let proveedorAbonoActual = null;
let inventarioMostrar = 10;
const buscadoresProducto = {};

// Secciones privadas: piden clave cada vez que se intenta entrar
const CLAVE_SECCIONES = 'soloagro1228';
const SECCIONES_PROTEGIDAS = ['inventario','reportes','config'];
let panelPendiente = null;

// Sync automático/login: solo trae ventas recientes (más que suficiente para
// Dashboard y Ventas). Historial y Reportes piden el historial completo aparte.
const VENTAS_DIAS_SYNC_LIGERO = 120;

// Clientes (venta / deudor / anticipo)
const buscadoresCliente = {};
let clienteVenta = null;
let clienteDeudor = null;
let clienteAnticipo = null;
let clienteModalContexto = null;

// =============================================
// GOOGLE SHEETS
// =============================================
// Nunca esperar la red para siempre: si no responde en 15s, se cancela y se sigue trabajando localmente.
function fetchConTimeout(url, opciones, ms = 15000) {
  const control = new AbortController();
  const t = setTimeout(() => control.abort(), ms);
  return fetch(url, { ...opciones, signal: control.signal }).finally(() => clearTimeout(t));
}

// ventasDias limita cuántos días de historial de Ventas trae el backend en cada
// sincronización. Sin esto, cada sync (cada 60s) descargaba TODO el historial de
// ventas desde el inicio de los tiempos, y eso se vuelve cada vez más lento a
// medida que crece la hoja. El sync automático solo necesita datos recientes
// (Dashboard = hoy); Historial y Reportes piden el historial completo aparte,
// solo cuando el usuario realmente entra a esas secciones.
async function sheetsLeer(ventasDias) {
  try {
    setSyncStatus('cargando');
    let url = SCRIPT_URL + '?action=getAll';
    if (ventasDias) url += '&ventasDias=' + ventasDias;
    const r = await fetchConTimeout(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    setSyncStatus('conectado');
    return d.data || {};
  } catch (e) {
    setSyncStatus('error');
    return null;
  }
}

async function sheetsEscribir(accion, hoja, datos, fila) {
  try {
    setSyncStatus('cargando');
    const r = await fetchConTimeout(SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({ action: accion, sheet: hoja, data: datos, row: fila })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    setSyncStatus('conectado');
    return true;
  } catch (e) {
    setSyncStatus('error');
    return false;
  }
}

async function sincronizar(ventasDias) {
  const datos = await sheetsLeer(ventasDias);
  if (!datos) return;

  if (datos.Productos && datos.Productos.length > 1) {
    DB.productos = datos.Productos.slice(1).map(f => ({
      id: String(f[0]), ref: String(f[1]||''), nombre: String(f[2]||''),
      pcompra: Number(f[3])||0, pventa1: Number(f[4])||0,
      pventa2: Number(f[5])||0, stock: Number(f[6])||0
    }));
  }

  if (datos.Ventas && datos.Ventas.length > 1) {
    DB.ventas = datos.Ventas.slice(1).map(f => ({
      id: String(f[0]), fecha: String(f[1]), hora: String(f[2]),
      total: Number(f[3])||0, ganancia: Number(f[4])||0,
      nota: String(f[5]||''), metodoPago: String(f[6]||'efectivo'),
      items: parsearJSON(f[7]),
      clienteId: String(f[8]||''), clienteNombre: String(f[9]||''),
      clienteCedula: String(f[10]||''), clienteTelefono: String(f[11]||''),
      clienteDireccion: String(f[12]||''),
      pagadoAhora: (f[13]!==undefined&&f[13]!=='') ? Number(f[13]) : undefined,
      saldoPendiente: (f[14]!==undefined&&f[14]!=='') ? Number(f[14]) : undefined
    }));
  }

  if (datos.Usuarios && datos.Usuarios.length > 1) {
    DB.usuarios = datos.Usuarios.slice(1).map(f => ({
      user: String(f[0]), pass: String(f[1]), rol: String(f[2]||'vendedor')
    }));
  }

  if (datos.Clientes && datos.Clientes.length > 1) {
    DB.clientes = datos.Clientes.slice(1).map(f => ({
      id: String(f[0]), nombre: String(f[1]||''), cedula: String(f[2]||''),
      telefono: String(f[3]||''), direccion: String(f[4]||''), correo: String(f[5]||'')
    }));
  }

  if (datos.Deudores && datos.Deudores.length > 1) {
    DB.deudores = datos.Deudores.slice(1).map(f => ({
      id: String(f[0]), clienteId: String(f[1]||''), nombre: String(f[2]||''),
      cedula: String(f[3]||''), telefono: String(f[4]||''), direccion: String(f[5]||''),
      productos: parsearJSON(f[6]), monto: Number(f[7])||0,
      nota: String(f[8]||''), fecha: isoAFechaCO(f[9]), hora: String(f[10]||''), fechaLimite: isoAFechaCO(f[11]),
      abonos: parsearJSON(f[12]), pagada: String(f[13])==='true'
    }));
  }

  if (datos.Anticipos && datos.Anticipos.length > 1) {
    DB.anticipos = datos.Anticipos.slice(1).map(f => ({
      id: String(f[0]), clienteId: String(f[1]||''), nombre: String(f[2]||''),
      cedula: String(f[3]||''), telefono: String(f[4]||''), direccion: String(f[5]||''),
      productos: parsearJSON(f[6]), monto: Number(f[7])||0,
      nota: String(f[8]||''), fecha: isoAFechaCO(f[9]), hora: String(f[10]||''), fechaLimite: isoAFechaCO(f[11]),
      abonos: parsearJSON(f[12]), pagada: String(f[13])==='true', descontado: String(f[14])==='true'
    }));
  }

  if (datos.Proveedores && datos.Proveedores.length > 1) {
    DB.proveedores = datos.Proveedores.slice(1).map(f => ({
      id: String(f[0]), empresa: String(f[1]||''), fechaLlegadaPedido: isoAFechaCO(f[2]),
      monto: Number(f[3])||0, numeroCuotas: Number(f[4])||1, fechaLimite: isoAFechaCO(f[5]),
      fecha: String(f[6]||''), hora: String(f[7]||''),
      abonos: parsearJSON(f[8]), pagada: String(f[9])==='true'
    }));
  }

  if (datos.Gastos && datos.Gastos.length > 1) {
    DB.gastos = datos.Gastos.slice(1).map(f => ({
      id: String(f[0]), categoria: String(f[1]||''), monto: Number(f[2])||0,
      metodoPago: String(f[3]||'efectivo'), fecha: isoAFechaCO(f[4]), hora: String(f[5]||''),
      nota: String(f[6]||'')
    }));
  }

  if (datos.Traslados && datos.Traslados.length > 1) {
    DB.traslados = datos.Traslados.slice(1).map(f => ({
      id: String(f[0]), numero: String(f[1]||''), fecha: isoAFechaCO(f[2]), hora: String(f[3]||''),
      items: parsearJSON(f[4])
    }));
  }

  if (datos.Config && datos.Config.length > 1) {
    DB.config.stockMin = Number(datos.Config[1][0]) || 5;
    DB.config.trasladoContador = Number(datos.Config[1][1]) || 0;
  }

  guardarLocal();
  mostrarToast('Datos sincronizados ✓');
}

async function inicializarSheets() {
  const datos = await sheetsLeer();
  if (!datos) return;
  if (!datos.Productos || datos.Productos.length === 0)
    await sheetsEscribir('append', 'Productos', ['ID','Ref','Nombre','PCompra','PVenta1','PVenta2','Stock']);
  if (!datos.Ventas || datos.Ventas.length === 0)
    await sheetsEscribir('append', 'Ventas', ['ID','Fecha','Hora','Total','Ganancia','Nota','MetodoPago','Items','ClienteId','ClienteNombre','ClienteCedula','ClienteTelefono','ClienteDireccion','PagadoAhora','SaldoPendiente']);
  if (!datos.Usuarios || datos.Usuarios.length === 0) {
    await sheetsEscribir('append', 'Usuarios', ['Usuario','Contraseña','Rol']);
    await sheetsEscribir('append', 'Usuarios', ['admin','Soloagro2812','admin']);
  }
  if (!datos.Clientes || datos.Clientes.length === 0)
    await sheetsEscribir('append', 'Clientes', ['ID','Nombre','Cedula','Telefono','Direccion','Correo']);
  if (!datos.Deudores || datos.Deudores.length === 0)
    await sheetsEscribir('append', 'Deudores', ['ID','ClienteId','Nombre','Cedula','Telefono','Direccion','Productos','Monto','Nota','Fecha','Hora','FechaLimite','Abonos','Pagada']);
  if (!datos.Anticipos || datos.Anticipos.length === 0)
    await sheetsEscribir('append', 'Anticipos', ['ID','ClienteId','Nombre','Cedula','Telefono','Direccion','Productos','Monto','Nota','Fecha','Hora','FechaLimite','Abonos','Pagada','Descontado']);
  if (!datos.Proveedores || datos.Proveedores.length === 0)
    await sheetsEscribir('append', 'Proveedores', ['ID','Empresa','FechaLlegadaPedido','Monto','NumeroCuotas','FechaLimite','Fecha','Hora','Abonos','Pagada']);
  if (!datos.Gastos || datos.Gastos.length === 0)
    await sheetsEscribir('append', 'Gastos', ['ID','Categoria','Monto','MetodoPago','Fecha','Hora','Nota']);
  if (!datos.Traslados || datos.Traslados.length === 0)
    await sheetsEscribir('append', 'Traslados', ['ID','Numero','Fecha','Hora','Items']);
  if (!datos.Config || datos.Config.length === 0) {
    await sheetsEscribir('append', 'Config', ['StockMin','TrasladoContador']);
    await sheetsEscribir('append', 'Config', [5, 0]);
  }
  await sincronizar(VENTAS_DIAS_SYNC_LIGERO);
}

// =============================================
// LOCAL STORAGE
// =============================================
function guardarLocal() { localStorage.setItem('kellypk_db', JSON.stringify(DB)); }
function cargarLocal() {
  try { const d = localStorage.getItem('kellypk_db'); if (d) DB = JSON.parse(d); } catch(e) {}
}
function guardarSesion(u) { localStorage.setItem('kellypk_sesion', JSON.stringify(u)); }
function cargarSesion() {
  try { const s = localStorage.getItem('kellypk_sesion'); return s ? JSON.parse(s) : null; } catch(e) { return null; }
}
function borrarSesion() { localStorage.removeItem('kellypk_sesion'); }

// =============================================
// UTILIDADES
// =============================================
function fmt(n) { return '$' + Math.round(n).toLocaleString('es-CO'); }
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function esc(t) {
  return String(t).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function parsearJSON(t) { try { return JSON.parse(t); } catch(e) { return []; } }

// Fecha y hora en formato colombiano (DD/MM/AAAA, 12 horas)
function fechaCO(d = new Date()) {
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}
function horaCO(d = new Date()) {
  return d.toLocaleTimeString('es-CO', {hour:'2-digit', minute:'2-digit', hour12:true});
}
function parseFechaCO(str) {
  const [dd,mm,yyyy] = String(str).split('/').map(Number);
  return new Date(yyyy||1970, (mm||1)-1, dd||1);
}
function isoAFechaCO(iso) {
  if (!iso) return '';

  const valor = String(iso).trim();

  // Si ya viene en formato colombiano, lo dejamos igual
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(valor)) {
    return valor;
  }

  // Si viene como YYYY-MM-DD o YYYY-MM-DDTHH:mm:ss...
  const match = valor.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (match) {
    const [, anio, mes, dia] = match;
    return `${dia}/${mes}/${anio}`;
  }

  return valor;
}
function coAIso(co) {
  if (!co) return '';
  const [d,m,y] = String(co).split('/');
  if (!d||!m||!y) return '';
  return `${y}-${m}-${d}`;
}

function setSyncStatus(estado) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = {conectado:'Conectado',cargando:'Sincronizando...',error:'Sin conexión'}[estado]||estado;
  el.className = estado;
}

function mostrarToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('visible');
  setTimeout(() => t.classList.remove('visible'), 3000);
}

function abrirModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function cerrarModal(id) { document.getElementById(id).classList.add('hidden'); }

// =============================================
// LOGIN
// =============================================
function doLogin() {
  const u = document.getElementById('login-user').value.trim();
  const p = document.getElementById('login-pass').value;
  const found = DB.usuarios.find(x => x.user === u && x.pass === p);
  if (found) {
    sesion = found;
    guardarSesion(found);
    entrarAlApp();
    inicializarSheets();
  } else {
    document.getElementById('login-error').classList.remove('hidden');
  }
}

function entrarAlApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('topbar-user').textContent = sesion.user + ' · ' + sesion.rol;
  document.getElementById('hist-fecha').value = new Date().toISOString().split('T')[0];
  mostrarPanelInterno('ventas');
  iniciarAutoSync();
}

function iniciarAutoSync() {
  if (autoSyncInterval) clearInterval(autoSyncInterval);
  autoSyncInterval = setInterval(() => { if (sesion) sincronizar(VENTAS_DIAS_SYNC_LIGERO); }, 60000);
}

function doLogout() {
  sesion = null; precioCompraVisible = false; carrito = [];
  if (autoSyncInterval) { clearInterval(autoSyncInterval); autoSyncInterval = null; }
  borrarSesion();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-error').classList.add('hidden');
}

// =============================================
// NAVEGACIÓN
// =============================================
function mostrarPanel(panel) {
  if (SECCIONES_PROTEGIDAS.includes(panel)) { solicitarClavePanel(panel); return; }
  mostrarPanelInterno(panel);
}

function solicitarClavePanel(panel) {
  panelPendiente = panel;
  document.getElementById('clave-panel-input').value = '';
  document.getElementById('clave-panel-error').classList.add('hidden');
  abrirModal('modal-clave-panel');
  setTimeout(() => document.getElementById('clave-panel-input').focus(), 100);
}

function verificarClavePanel() {
  const v = document.getElementById('clave-panel-input').value;
  if (v === CLAVE_SECCIONES) {
    cerrarModal('modal-clave-panel');
    const panel = panelPendiente;
    panelPendiente = null;
    if (panel) mostrarPanelInterno(panel);
  } else {
    document.getElementById('clave-panel-error').classList.remove('hidden');
  }
}

async function mostrarPanelInterno(panel) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + panel).classList.add('active');
  document.querySelector(`.nav-tab[data-tab="${panel}"]`).classList.add('active');

  if (panel === 'dashboard')  renderDashboard();
  if (panel === 'inventario') renderInventario();
  if (panel === 'deudores')   renderDeudores();
  if (panel === 'anticipos')  renderAnticipos();
  if (panel === 'proveedores') renderProveedores();
  if (panel === 'gastos')     renderGastos();
  // El sync automático solo trae ventas recientes; Historial/Reportes pueden
  // necesitar cualquier fecha pasada, así que aquí sí se trae el historial completo.
  if (panel === 'historial')  { renderHistorial(); await sincronizar(); renderHistorial(); }
  if (panel === 'reportes')   { renderReportes(periodoreporte); await sincronizar(); renderReportes(periodoreporte); }
  if (panel === 'config')     renderConfig();
  if (panel === 'ventas') {
    carrito = [];
    renderCarrito();
    quitarClienteVenta();
    document.getElementById('venta-cliente-buscar').value = '';
    document.getElementById('venta-cliente-resultados').innerHTML = '';
    document.getElementById('venta-search').value = '';
    document.getElementById('venta-resultados').innerHTML = '';
    resultadosVenta = [];
    setTimeout(() => document.getElementById('venta-search').focus(), 100);
  }
  if (panel === 'traslado') {
    renderTraslado();
    renderTrasladosHistorial();
    document.getElementById('traslado-search').value = '';
    document.getElementById('traslado-resultados').innerHTML = '';
    resultadosTraslado = [];
    setTimeout(() => document.getElementById('traslado-search').focus(), 100);
  }

  cerrarSidebarMovil();
}

function cerrarSidebarMovil() {
  document.getElementById('sidebar').classList.remove('abierto');
  document.getElementById('sidebar-backdrop').classList.remove('visible');
}

// =============================================
// TRASLADO (no afecta stock)
// =============================================
function buscarProductoTraslado() {
  const q = document.getElementById('traslado-search').value.toLowerCase();
  const cont = document.getElementById('traslado-resultados');
  indiceTraslado = 0;
  if (!q) { cont.innerHTML=''; resultadosTraslado=[]; return; }

  resultadosTraslado = DB.productos
    .filter(p => p.nombre.toLowerCase().includes(q) || p.ref.toLowerCase().includes(q))
    .slice(0,8);

  if (resultadosTraslado.length===0) { cont.innerHTML='<p style="font-size:13px;color:var(--texto2);padding:8px 0">Sin resultados</p>'; return; }

  renderResultadosTraslado();
}

function renderResultadosTraslado() {
  const cont = document.getElementById('traslado-resultados');
  cont.innerHTML = `
    <div style="background:var(--card);border:0.5px solid var(--borde);border-radius:12px;overflow:hidden;margin-bottom:1rem;box-shadow:var(--sombra)">
      <div style="padding:8px 12px;background:var(--blush-claro);border-bottom:0.5px solid var(--borde);font-size:11px;color:var(--texto2);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">
        Resultados — ↑↓ para navegar, Enter para agregar
      </div>
      ${resultadosTraslado.map((p,i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:0.5px solid var(--borde);flex-wrap:wrap;gap:8px;${i===indiceTraslado?'background:var(--rosa-claro)':''}">
          <div>
            ${i===indiceTraslado?'<span style="font-size:10px;background:var(--rosa);color:#fff;padding:2px 7px;border-radius:10px;margin-right:6px">↵ Enter</span>':''}
            <span style="font-size:14px;font-weight:500">${esc(p.nombre)}</span>
            <div style="font-size:12px;color:var(--texto2)">Código: ${esc(p.ref)} · Stock: ${p.stock} · P1: ${fmt(p.pventa1)}</div>
          </div>
          <button class="btn-primary btn-agregar-traslado" data-id="${p.id}" style="flex-shrink:0"><i class="ti ti-plus"></i> Agregar</button>
        </div>`).join('')}
    </div>`;

  cont.querySelectorAll('.btn-agregar-traslado').forEach(b =>
    b.addEventListener('click', () => agregarATraslado(b.dataset.id)));
}

function agregarATraslado(id) {
  const p = DB.productos.find(x => x.id===id);
  if (!p) return;
  trasladoProductoActual = p;
  document.getElementById('ct-nombre').textContent = p.nombre;
  document.getElementById('ct-cantidad').value = '1';
  abrirModal('modal-cantidad-traslado');
  setTimeout(() => document.getElementById('ct-cantidad').focus(), 100);

  document.getElementById('traslado-search').value = '';
  document.getElementById('traslado-resultados').innerHTML = '';
}

function cantidadEnTraslado(ref) {
  return traslado.filter(i => i.codigo === ref).reduce((a,i) => a+i.cantidad, 0);
}

function confirmarCantidadTraslado() {
  const cant = parseInt(document.getElementById('ct-cantidad').value) || 0;
  if (cant < 1) { alert('Ingresa una cantidad válida'); return; }
  const p = trasladoProductoActual;
  if (!p) return;

  const disponible = p.stock - cantidadEnTraslado(p.ref);
  if (cant > disponible) { alert(`Solo hay ${Math.max(disponible,0)} unidades disponibles en inventario.`); return; }

  traslado.push({ itemId: uid(), codigo: p.ref, nombre: p.nombre, cantidad: cant, precio: p.pventa1 });
  cerrarModal('modal-cantidad-traslado');
  renderTraslado();
  document.getElementById('traslado-search').focus();
  mostrarToast('Producto agregado al traslado ✓');
}

function eliminarDeTraslado(itemId) {
  traslado = traslado.filter(i => i.itemId !== itemId);
  renderTraslado();
}

function renderTraslado() {
  const cont = document.getElementById('traslado-contenido');
  if (traslado.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-truck"></i><p>Sin productos en el traslado.</p></div>`;
    return;
  }

  const filas = traslado.map((i, idx) => `
    <tr>
      <td>${idx+1}</td>
      <td><code style="background:var(--blush-claro);padding:2px 7px;border-radius:4px;font-size:12px">${esc(i.codigo)}</code></td>
      <td>${esc(i.nombre)}</td>
      <td style="text-align:center">${i.cantidad}</td>
      <td>${fmt(i.precio)}</td>
      <td><button class="btn-peligro btn-quitar-traslado" data-id="${i.itemId}" style="padding:5px 9px"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('');

  cont.innerHTML = `
    <p style="font-size:13px;color:var(--texto2);margin:0.5rem 0">Total de productos: <strong>${traslado.length}</strong></p>
    <div class="tabla-wrap"><table>
    <thead><tr><th>#</th><th>Código</th><th>Nombre</th><th>Cantidad</th><th>Precio</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-quitar-traslado').forEach(b =>
    b.addEventListener('click', () => eliminarDeTraslado(b.dataset.id)));
}

// La fila 1 es el encabezado (se crea una sola vez en inicializarSheets) y la
// fila 2 son los valores actuales: se actualiza directo esa fila, sin borrar
// y reconstruir el sheet completo (eso dejaba una ventana donde una lectura
// a mitad de camino podía encontrar el sheet sin valores y devolver el
// contador en 0, reiniciando la numeración de traslados).
async function guardarConfigSheet() {
  await sheetsEscribir('update','Config',[DB.config.stockMin, DB.config.trasladoContador], 2);
}

async function siguienteNumeroTraslado() {
  DB.config.trasladoContador = (DB.config.trasladoContador||0) + 1;
  guardarLocal();
  await guardarConfigSheet();
  return 'TD-N-' + String(DB.config.trasladoContador).padStart(4,'0');
}

function prepararImpresion(idContenedor) {
  document.getElementById('traslado-print').classList.remove('activo');
  document.getElementById('venta-print').classList.remove('activo');
  document.getElementById('deudor-print').classList.remove('activo');
  document.getElementById('proveedor-print').classList.remove('activo');
  document.getElementById(idContenedor).classList.add('activo');
}

function construirHtmlTrasladoPrint(numero, fecha, hora, items) {
  const filas = items.map((i, idx) => `
    <tr>
      <td>${idx+1}</td>
      <td>${esc(i.codigo)}</td>
      <td>${esc(i.nombre)}</td>
      <td style="text-align:center">${i.cantidad}</td>
      <td>${fmt(i.precio)}</td>
    </tr>`).join('');

  return `
    <div id="tp-header">
      <h1>Multirepuestos SoloAgro</h1>
      <p>Traslado de productos</p>
      <p style="font-weight:600;margin-top:4px">${numero}</p>
    </div>
    <div id="tp-meta">
      <span><strong>Fecha:</strong> ${fecha}</span>
      <span><strong>Hora:</strong> ${hora}</span>
    </div>
    <table>
      <thead><tr><th>#</th><th>Código</th><th>Nombre</th><th>Cantidad</th><th>Precio</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <p style="margin-top:12px;font-size:13px"><strong>Total de productos:</strong> ${items.length}</p>
    <div id="tp-firmas">
      <div class="tp-firma"><div class="tp-linea"></div><span>Quien realiza el traslado</span></div>
      <div class="tp-firma"><div class="tp-linea"></div><span>Quien recibe</span></div>
    </div>
  `;
}

async function guardarTrasladoRealizado(numero, fecha, hora, items) {
  const registro = { id: uid(), numero, fecha, hora, items: items.map(i=>({...i})) };
  DB.traslados.push(registro);
  guardarLocal();
  await sheetsEscribir('append','Traslados',[registro.id, registro.numero, registro.fecha, registro.hora, JSON.stringify(registro.items)]);
  return registro;
}

async function imprimirTraslado() {
  if (traslado.length === 0) { alert('Agrega productos al traslado antes de imprimir'); return; }

  const numero = await siguienteNumeroTraslado();
  const ahora = new Date();
  const fecha = fechaCO(ahora);
  const hora  = horaCO(ahora);

  await guardarTrasladoRealizado(numero, fecha, hora, traslado);
  renderTrasladosHistorial();

  document.getElementById('traslado-print-contenido').innerHTML = construirHtmlTrasladoPrint(numero, fecha, hora, traslado);
  prepararImpresion('traslado-print');
  window.print();
}

function reimprimirTraslado(registro) {
  document.getElementById('traslado-print-contenido').innerHTML =
    construirHtmlTrasladoPrint(registro.numero, registro.fecha, registro.hora, registro.items);
  prepararImpresion('traslado-print');
  window.print();
}

function renderTrasladosHistorial() {
  const cont = document.getElementById('traslados-historial-contenido');
  if (!cont) return;
  if (DB.traslados.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-history"></i><p>Sin traslados registrados todavía.</p></div>`;
    return;
  }
  const ordenados = DB.traslados.slice().reverse();
  const filas = ordenados.map(t => `
    <tr>
      <td style="font-weight:500">${esc(t.numero)}</td>
      <td>${t.fecha}</td>
      <td>${t.hora}</td>
      <td style="text-align:center">${t.items.length}</td>
      <td><button class="btn-secundario btn-reimprimir-traslado" data-id="${t.id}" style="padding:6px 10px"><i class="ti ti-printer"></i></button></td>
    </tr>`).join('');
  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Número</th><th>Fecha</th><th>Hora</th><th>Productos</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
  cont.querySelectorAll('.btn-reimprimir-traslado').forEach(b => b.addEventListener('click', () => {
    const t = DB.traslados.find(x => x.id === b.dataset.id);
    if (t) reimprimirTraslado(t);
  }));
}

// =============================================
// BUSCADOR DE PRODUCTO (widget reutilizable: deudores / anticipos)
// =============================================
function inicializarBuscadorProducto(key, inputId, resultadosId, onSeleccionar) {
  buscadoresProducto[key] = { resultados: [], indice: 0 };
  const input = document.getElementById(inputId);
  const cont = document.getElementById(resultadosId);

  function renderizar() {
    const estado = buscadoresProducto[key];
    cont.innerHTML = `
      <div style="background:var(--card);border:0.5px solid var(--borde);border-radius:12px;overflow:hidden;margin-bottom:1rem;box-shadow:0 4px 16px rgba(31,122,77,0.12)">
        <div style="padding:8px 12px;background:var(--blush-claro);border-bottom:0.5px solid var(--borde);font-size:11px;color:var(--texto2);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">
          Resultados — ↑↓ para navegar, Enter para elegir
        </div>
        ${estado.resultados.map((p,i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:0.5px solid var(--borde);flex-wrap:wrap;gap:8px;${i===estado.indice?'background:var(--rosa-claro)':''}">
            <div>
              ${i===estado.indice?'<span style="font-size:10px;background:var(--rosa);color:#fff;padding:2px 7px;border-radius:10px;margin-right:6px">↵ Enter</span>':''}
              <span style="font-size:14px;font-weight:500">${esc(p.nombre)}</span>
              <div style="font-size:12px;color:var(--texto2)">Ref: ${esc(p.ref)} · Stock: ${p.stock} · Precio: ${fmt(p.pventa1)}</div>
            </div>
            <button type="button" class="btn-primary btn-elegir-producto-buscado" data-idx="${i}" style="flex-shrink:0"><i class="ti ti-plus"></i> Elegir</button>
          </div>`).join('')}
      </div>`;
    cont.querySelectorAll('.btn-elegir-producto-buscado').forEach(b =>
      b.addEventListener('click', () => elegir(parseInt(b.dataset.idx))));
  }

  function elegir(i) {
    const p = buscadoresProducto[key].resultados[i];
    if (!p) return;
    input.value = '';
    cont.innerHTML = '';
    buscadoresProducto[key].resultados = [];
    onSeleccionar(p);
  }

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    const estado = buscadoresProducto[key];
    estado.indice = 0;
    if (!q) { cont.innerHTML=''; estado.resultados=[]; return; }
    estado.resultados = DB.productos.filter(p => p.nombre.toLowerCase().includes(q) || p.ref.toLowerCase().includes(q)).slice(0,8);
    if (estado.resultados.length===0) { cont.innerHTML = '<p style="font-size:13px;color:var(--texto2);padding:8px 0">Sin resultados</p>'; return; }
    renderizar();
  });

  input.addEventListener('keydown', e => {
    const estado = buscadoresProducto[key];
    if (estado.resultados.length===0) return;
    if (e.key==='ArrowDown') { e.preventDefault(); estado.indice=Math.min(estado.indice+1, estado.resultados.length-1); renderizar(); }
    else if (e.key==='ArrowUp') { e.preventDefault(); estado.indice=Math.max(estado.indice-1,0); renderizar(); }
    else if (e.key==='Enter') { e.preventDefault(); elegir(estado.indice); }
  });
}

// =============================================
// BUSCADOR DE CLIENTE (widget reutilizable: ventas / deudores / anticipos)
// =============================================
function inicializarBuscadorCliente(key, inputId, resultadosId, onSeleccionar) {
  buscadoresCliente[key] = { resultados: [], indice: 0 };
  const input = document.getElementById(inputId);
  const cont = document.getElementById(resultadosId);

  function renderizar() {
    const estado = buscadoresCliente[key];
    cont.innerHTML = `
      <div style="background:var(--card);border:0.5px solid var(--borde);border-radius:12px;overflow:hidden;margin-bottom:1rem;box-shadow:0 4px 16px rgba(23,74,50,0.12)">
        <div style="padding:8px 12px;background:var(--blush-claro);border-bottom:0.5px solid var(--borde);font-size:11px;color:var(--texto2);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">
          Resultados — ↑↓ para navegar, Enter para elegir
        </div>
        ${estado.resultados.map((c,i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:0.5px solid var(--borde);flex-wrap:wrap;gap:8px;${i===estado.indice?'background:var(--rosa-claro)':''}">
            <div>
              ${i===estado.indice?'<span style="font-size:10px;background:var(--rosa);color:#fff;padding:2px 7px;border-radius:10px;margin-right:6px">↵ Enter</span>':''}
              <span style="font-size:14px;font-weight:500">${esc(c.nombre)}</span>
              <div style="font-size:12px;color:var(--texto2)">CC ${esc(c.cedula)}${c.telefono?' · Tel: '+esc(c.telefono):''}</div>
            </div>
            <button type="button" class="btn-primary btn-elegir-cliente-buscado" data-idx="${i}" style="flex-shrink:0"><i class="ti ti-plus"></i> Elegir</button>
          </div>`).join('')}
      </div>`;
    cont.querySelectorAll('.btn-elegir-cliente-buscado').forEach(b =>
      b.addEventListener('click', () => elegir(parseInt(b.dataset.idx))));
  }

  function elegir(i) {
    const c = buscadoresCliente[key].resultados[i];
    if (!c) return;
    input.value = '';
    cont.innerHTML = '';
    buscadoresCliente[key].resultados = [];
    onSeleccionar(c);
  }

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    const estado = buscadoresCliente[key];
    estado.indice = 0;
    if (!q) { cont.innerHTML=''; estado.resultados=[]; return; }
    estado.resultados = DB.clientes.filter(c => c.nombre.toLowerCase().includes(q) || c.cedula.toLowerCase().includes(q)).slice(0,8);
    if (estado.resultados.length===0) { cont.innerHTML = '<p style="font-size:13px;color:var(--texto2);padding:8px 0">Sin resultados. Usa "Nuevo cliente" para agregarlo.</p>'; return; }
    renderizar();
  });

  input.addEventListener('keydown', e => {
    const estado = buscadoresCliente[key];
    if (estado.resultados.length===0) return;
    if (e.key==='ArrowDown') { e.preventDefault(); estado.indice=Math.min(estado.indice+1, estado.resultados.length-1); renderizar(); }
    else if (e.key==='ArrowUp') { e.preventDefault(); estado.indice=Math.max(estado.indice-1,0); renderizar(); }
    else if (e.key==='Enter') { e.preventDefault(); elegir(estado.indice); }
  });
}

function abrirModalNuevoCliente(contexto) {
  clienteModalContexto = contexto;
  ['cliente-nombre','cliente-cedula','cliente-telefono','cliente-direccion','cliente-correo'].forEach(id => document.getElementById(id).value = '');
  abrirModal('modal-cliente');
  setTimeout(() => document.getElementById('cliente-nombre').focus(), 100);
}

async function guardarCliente() {
  const nombre = document.getElementById('cliente-nombre').value.trim();
  const cedula = document.getElementById('cliente-cedula').value.trim();
  const telefono = document.getElementById('cliente-telefono').value.trim();
  const direccion = document.getElementById('cliente-direccion').value.trim();
  const correo = document.getElementById('cliente-correo').value.trim();
  if (!nombre || !cedula) { alert('Completa nombre y cédula del cliente'); return; }

  const nuevo = { id: uid(), nombre, cedula, telefono, direccion, correo };
  DB.clientes.push(nuevo);
  await sheetsEscribir('append','Clientes',[nuevo.id,nuevo.nombre,nuevo.cedula,nuevo.telefono,nuevo.direccion,nuevo.correo]);
  guardarLocal();
  cerrarModal('modal-cliente');
  mostrarToast('Cliente agregado ✓');

  if (clienteModalContexto === 'venta') seleccionarClienteVenta(nuevo);
  else if (clienteModalContexto === 'deudor') seleccionarClienteDeudor(nuevo);
  else if (clienteModalContexto === 'anticipo') seleccionarClienteAnticipo(nuevo);
  clienteModalContexto = null;
}

function seleccionarClienteVenta(c) {
  clienteVenta = c;
  document.getElementById('venta-cliente-nombre').textContent = c.nombre;
  document.getElementById('venta-cliente-detalle').textContent = `CC ${c.cedula}${c.telefono?' · Tel: '+c.telefono:''}`;
  document.getElementById('venta-cliente-seleccionado').classList.remove('hidden');
  document.getElementById('venta-cliente-buscar').value = '';
  document.getElementById('venta-cliente-resultados').innerHTML = '';
}

function quitarClienteVenta() {
  clienteVenta = null;
  document.getElementById('venta-cliente-seleccionado').classList.add('hidden');
}

function seleccionarClienteDeudor(c) {
  clienteDeudor = c;
  document.getElementById('deudor-cliente-nombre').textContent = c.nombre;
  document.getElementById('deudor-cliente-detalle').textContent = `CC ${c.cedula}${c.telefono?' · Tel: '+c.telefono:''}`;
  document.getElementById('deudor-cliente-seleccionado').classList.remove('hidden');
  document.getElementById('deudor-cliente-buscar').value = '';
  document.getElementById('deudor-cliente-resultados').innerHTML = '';
}

function quitarClienteDeudor() {
  clienteDeudor = null;
  document.getElementById('deudor-cliente-seleccionado').classList.add('hidden');
}

function seleccionarClienteAnticipo(c) {
  clienteAnticipo = c;
  document.getElementById('anticipo-cliente-nombre').textContent = c.nombre;
  document.getElementById('anticipo-cliente-detalle').textContent = `CC ${c.cedula}${c.telefono?' · Tel: '+c.telefono:''}`;
  document.getElementById('anticipo-cliente-seleccionado').classList.remove('hidden');
  document.getElementById('anticipo-cliente-buscar').value = '';
  document.getElementById('anticipo-cliente-resultados').innerHTML = '';
}

function quitarClienteAnticipo() {
  clienteAnticipo = null;
  document.getElementById('anticipo-cliente-seleccionado').classList.add('hidden');
}

// =============================================
// DEUDAS / ANTICIPOS — utilidades comunes
// =============================================
function calcularAbonado(d) {
  const abonos = Array.isArray(d.abonos) ? d.abonos : [];
  return abonos.reduce((a, x) => a + (Number(x.monto) || 0), 0);
}

function calcularSaldo(d) {
  return Math.max(0, (Number(d.monto) || 0) - calcularAbonado(d));
}
function deudaVencida(d) {
  if (!d.fechaLimite || calcularSaldo(d) <= 0) return false;
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  return parseFechaCO(d.fechaLimite) < hoy;
}

// Registra un pago (anticipo o abono) contra una deuda/anticipo: queda como abono
// Y ADEMÁS entra a la caja del día como una venta más (efectivo o transferencia).
async function registrarPagoDeuda(entidad, tipo, monto, metodoPago) {

  const ahora = new Date();

  // =============================================
  // REGISTRAR EL ABONO EN LA ENTIDAD
  // =============================================

  entidad.abonos = entidad.abonos || [];

  entidad.abonos.push({
    id: uid(),
    monto: Number(monto) || 0,
    metodoPago,
    fecha: fechaCO(ahora),
    hora: horaCO(ahora)
  });


  // =============================================
  // CALCULAR COSTO Y GANANCIA
  // =============================================

  const productos = entidad.productos || [];

  let costoTotal = 0;

  productos.forEach(pr => {

    const p = DB.productos.find(
      x => x.id === pr.productoId
    );

    if (p) {

      costoTotal +=
        p.pcompra * (pr.cantidad || 0);

    }

  });


  const gananciaTotal =
    entidad.monto - costoTotal;


  const gananciaPago =
    entidad.monto > 0
      ? monto * (gananciaTotal / entidad.monto)
      : 0;


  // =============================================
  // CREAR MOVIMIENTO DE CAJA
  // =============================================

  const etiqueta =
    tipo === 'deudor'
      ? 'Abono deuda'
      : 'Anticipo';


  const nombresProductos =
    productos
      .map(p => p.productoNombre)
      .join(', ');


  const itemsBoucher = productos.length

    ? productos.map(pr => ({

        ref: pr.ref || '-',

        nombre: pr.productoNombre,

        cantidad: pr.cantidad,

        precio: pr.precioUnit,

        total:
          pr.precioUnit * pr.cantidad

      }))

    : [{

        ref: '-',

        nombre: etiqueta,

        cantidad: 1,

        precio: monto,

        total: monto

      }];


  const venta = {

    id: uid(),

    fecha: fechaCO(ahora),

    hora: horaCO(ahora),

    total: monto,

    ganancia: gananciaPago,

    nota: nombresProductos
      ? `${etiqueta} de: ${nombresProductos}`
      : etiqueta,

    metodoPago,

    items: itemsBoucher,

    clienteId:
      entidad.clienteId || '',

    clienteNombre:
      entidad.nombre || '',

    clienteCedula:
      entidad.cedula || '',

    clienteTelefono:
      entidad.telefono || '',

    clienteDireccion:
      entidad.direccion || '',

    pagadoAhora: monto,

    saldoPendiente:
      calcularSaldo(entidad)

  };


  DB.ventas.push(venta);


  // =============================================
  // GUARDAR MOVIMIENTO EN VENTAS
  // =============================================

  await sheetsEscribir(
    'append',
    'Ventas',
    [
      venta.id,
      venta.fecha,
      venta.hora,
      venta.total,
      venta.ganancia,
      venta.nota,
      venta.metodoPago,
      JSON.stringify(venta.items),
      venta.clienteId,
      venta.clienteNombre,
      venta.clienteCedula,
      venta.clienteTelefono,
      venta.clienteDireccion,
      venta.pagadoAhora,
      venta.saldoPendiente
    ]
  );


  // =============================================
  // ACTUALIZAR ESTADO DE LA DEUDA / ANTICIPO
  // =============================================

  entidad.pagada =
    calcularSaldo(entidad) <= 0;


  // =============================================
  // GUARDAR EL ABONO EN SU HOJA
  // =============================================

  if (tipo === 'deudor') {

    await guardarDeudorEnSheet(
      entidad,
      false
    );

  } else {

    await guardarAnticipoEnSheet(
      entidad,
      false
    );

  }


  // =============================================
  // SI ES ANTICIPO Y YA ESTÁ PAGADO,
  // DESCONTAR PRODUCTOS DEL INVENTARIO
  // =============================================

  if (
    tipo === 'anticipo' &&
    entidad.pagada &&
    productos.length &&
    !entidad.descontado
  ) {

    for (const pr of productos) {

      const p = DB.productos.find(
        x => x.id === pr.productoId
      );

      if (p) {

        p.stock = Math.max(
          0,
          p.stock - (pr.cantidad || 0)
        );


        const idxP =
          DB.productos.findIndex(
            x => x.id === p.id
          );


        await sheetsEscribir(
          'update',
          'Productos',
          [
            p.id,
            p.ref,
            p.nombre,
            p.pcompra,
            p.pventa1,
            p.pventa2,
            p.stock
          ],
          idxP + 2
        );

      }

    }


    entidad.descontado = true;


    // Guardar nuevamente porque cambió descontado
    await guardarAnticipoEnSheet(
      entidad,
      false
    );

  }

}

function imprimirBoucherDeuda(d, tipo) {
  const ahora = new Date();
  const abonos = d.abonos||[];
  const saldo = calcularSaldo(d);
  const titulo = tipo==='deudor' ? 'Comprobante de deuda' : 'Comprobante de anticipo';

  const filasAbonos = abonos.map((a,i) => `
    <tr>
      <td>${i+1}</td>
      <td>${a.fecha} ${a.hora}</td>
      <td>${a.metodoPago==='transferencia'?'Transferencia':'Efectivo'}</td>
      <td style="text-align:right">${fmt(a.monto)}</td>
    </tr>`).join('');

  const productos = d.productos||[];
  const filasProductos = productos.map(p => `
    <tr>
      <td>${esc(p.ref||'-')}</td>
      <td>${esc(p.productoNombre)}</td>
      <td style="text-align:center">${p.cantidad}</td>
      <td style="text-align:right">${fmt(p.precioUnit)}</td>
    </tr>`).join('');

  document.getElementById('deudor-print-contenido').innerHTML = `
    <div id="tp-header">
      <h1>Multirepuestos SoloAgro</h1>
      <p>${titulo}</p>
    </div>
    <div id="tp-meta">
      <span><strong>Fecha:</strong> ${fechaCO(ahora)}</span>
      <span><strong>Hora:</strong> ${horaCO(ahora)}</span>
    </div>
    <p style="font-size:13px;margin-bottom:4px"><strong>Cliente:</strong> ${esc(d.nombre)}</p>
    <p style="font-size:13px;margin-bottom:4px"><strong>Cédula:</strong> ${esc(d.cedula)}</p>
    ${d.telefono?`<p style="font-size:13px;margin-bottom:4px"><strong>Teléfono:</strong> ${esc(d.telefono)}</p>`:''}
    ${d.direccion?`<p style="font-size:13px;margin-bottom:4px"><strong>Dirección:</strong> ${esc(d.direccion)}</p>`:''}
    ${productos.length?`
      <table style="margin-top:8px;margin-bottom:8px">
        <thead><tr><th>Código</th><th>Producto</th><th>Cant.</th><th>Precio</th></tr></thead>
        <tbody>${filasProductos}</tbody>
      </table>`:''}
    ${d.nota?`<p style="font-size:13px;margin-bottom:4px"><strong>Comentario:</strong> ${esc(d.nota)}</p>`:''}
    ${d.fechaLimite?`<p style="font-size:13px;margin-bottom:12px"><strong>Fecha límite de pago:</strong> ${d.fechaLimite}</p>`:''}
    <p style="margin-top:8px;font-size:14px"><strong>Monto total: ${fmt(d.monto)}</strong></p>
    ${abonos.length?`
      <p style="margin-top:12px;font-size:13px"><strong>${tipo==='deudor'?'Abonos realizados':'Anticipos realizados'}:</strong></p>
      <table>
        <thead><tr><th>#</th><th>Fecha</th><th>Método</th><th>Monto</th></tr></thead>
        <tbody>${filasAbonos}</tbody>
      </table>`:''}
    <p style="margin-top:12px;font-size:16px"><strong>Saldo pendiente: ${fmt(saldo)}</strong></p>
    ${saldo<=0?`<p style="text-align:center;margin-top:8px;font-size:13px">${tipo==='deudor'?'DEUDA CANCELADA EN SU TOTALIDAD':'ANTICIPO CANCELADO — PRODUCTO ENTREGADO'}</p>`:''}
  `;

  prepararImpresion('deudor-print');
  window.print();
}

// Modal genérico para registrar un pago posterior (usado por deudores y anticipos)
function abrirModalAbono(id, tipo) {
  deudorAbonoActual = id;
  tipoAbonoActual = tipo;
  const lista = tipo==='deudor' ? DB.deudores : DB.anticipos;
  const d = lista.find(x => x.id===id);
  if (!d) return;
  document.getElementById('abono-nombre').textContent = d.nombre;
  document.getElementById('abono-saldo').textContent = `Saldo pendiente: ${fmt(calcularSaldo(d))}`;
  document.getElementById('abono-monto').value = '';
  document.querySelector('input[name="abono-metodo"][value="efectivo"]').checked = true;
  abrirModal('modal-abono');
  setTimeout(() => document.getElementById('abono-monto').focus(), 100);
}

async function guardarAbono() {
  const lista = tipoAbonoActual==='deudor' ? DB.deudores : DB.anticipos;
  const d = lista.find(x => x.id===deudorAbonoActual);
  if (!d) return;
  const monto = parseFloat(document.getElementById('abono-monto').value)||0;
  const saldo = calcularSaldo(d);
  if (!monto || monto<=0) { alert('Ingresa un monto válido'); return; }
  if (monto > saldo) { alert(`El abono no puede ser mayor al saldo pendiente (${fmt(saldo)})`); return; }
  const metodoPago = document.querySelector('input[name="abono-metodo"]:checked').value;

  await registrarPagoDeuda(d, tipoAbonoActual, monto, metodoPago);
  if (tipoAbonoActual==='deudor') await guardarDeudorEnSheet(d, false);
  else await guardarAnticipoEnSheet(d, false);

  guardarLocal();
  cerrarModal('modal-abono');
  if (tipoAbonoActual==='deudor') renderDeudores(); else renderAnticipos();
  renderDashboard();
  const completado = calcularSaldo(d)<=0;
  mostrarToast(completado ? (tipoAbonoActual==='deudor'?'Deuda pagada completamente ✓':'Anticipo pagado completamente ✓') : `Pago registrado · ${fmt(monto)}. Usa el botón de imprimir si quieres el boucher.`);
}

// =============================================
// DEUDORES (el cliente ya se lleva el producto)
// =============================================
function agregarProductoDeudor(p) {
  const existente = productosDeudor.find(x=>x.productoId===p.id);
  if (existente) {
    if (existente.cantidad >= p.stock) { alert(`Solo hay ${p.stock} unidades disponibles de ${p.nombre}.`); return; }
    existente.cantidad += 1;
  } else {
    if (p.stock < 1) { alert('Sin stock disponible de este producto.'); return; }
    productosDeudor.push({ productoId: p.id, ref: p.ref, nombre: p.nombre, cantidad: 1, precioUnit: p.pventa1 });
  }
  renderProductosDeudor();
  recalcularMontoDeudor();
}

function recalcularMontoDeudor() {
  const total = productosDeudor.reduce((a,p)=>a+p.precioUnit*p.cantidad,0);
  if (total>0) document.getElementById('deudor-monto').value = total;
}

function renderProductosDeudor() {
  const cont = document.getElementById('deudor-productos-lista');
  if (productosDeudor.length === 0) { cont.innerHTML = ''; return; }
  cont.innerHTML = productosDeudor.map((item,idx) => `
    <div class="carrito-item">
      <div class="item-nombre">
        <strong>${esc(item.nombre)}</strong>
        <span>Ref: ${esc(item.ref)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <input type="number" value="${item.cantidad}" min="1" class="input-cantidad-deudor" data-idx="${idx}">
        <span class="item-total">${fmt(item.precioUnit*item.cantidad)}</span>
        <button type="button" class="btn-peligro btn-quitar-producto-deudor-item" data-idx="${idx}" style="padding:6px 10px"><i class="ti ti-x"></i></button>
      </div>
    </div>`).join('');

  cont.querySelectorAll('.input-cantidad-deudor').forEach(input => {
    input.addEventListener('change', () => {
      const idx = parseInt(input.dataset.idx);
      const item = productosDeudor[idx];
      const p = DB.productos.find(x=>x.id===item.productoId);
      let nuevaCant = Math.max(1, parseInt(input.value)||1);
      if (p && nuevaCant > p.stock) {
        alert(`Solo hay ${p.stock} unidades disponibles de ${item.nombre}.`);
        nuevaCant = p.stock > 0 ? p.stock : 1;
      }
      item.cantidad = nuevaCant;
      renderProductosDeudor();
      recalcularMontoDeudor();
    });
  });
  cont.querySelectorAll('.btn-quitar-producto-deudor-item').forEach(b =>
    b.addEventListener('click', () => {
      productosDeudor.splice(parseInt(b.dataset.idx),1);
      renderProductosDeudor();
      recalcularMontoDeudor();
    }));
}

async function guardarDeudorEnSheet(d, esNuevo) {
  const fila = [d.id,d.clienteId,d.nombre,d.cedula,d.telefono,d.direccion,JSON.stringify(d.productos||[]),d.monto,d.nota,d.fecha,d.hora,d.fechaLimite,JSON.stringify(d.abonos),d.pagada];
  if (esNuevo) { await sheetsEscribir('append','Deudores',fila); }
  else {
    const idx = DB.deudores.findIndex(x=>x.id===d.id);
    await sheetsEscribir('update','Deudores',fila,idx+2);
  }
}

function abrirModalDeudor(id) {
  editandoDeudorId = id || null;
  productosDeudor = [];
  document.getElementById('deudor-producto-buscar').value = '';
  document.getElementById('deudor-producto-resultados').innerHTML = '';
  document.getElementById('deudor-anticipo').value = '';
  document.querySelector('input[name="deudor-metodo"][value="efectivo"]').checked = true;
  quitarClienteDeudor();
  document.getElementById('deudor-cliente-buscar').value = '';
  document.getElementById('deudor-cliente-resultados').innerHTML = '';
  document.getElementById('modal-deudor-titulo').textContent = id ? 'Editar deudor' : 'Agregar deudor';
  if (id) {
    const d = DB.deudores.find(x => x.id === id);
    if (!d) return;
    seleccionarClienteDeudor({ id: d.clienteId, nombre: d.nombre, cedula: d.cedula, telefono: d.telefono });
    productosDeudor = (d.productos||[]).map(p=>({productoId:p.productoId, ref:p.ref||'', nombre:p.productoNombre, cantidad:p.cantidad, precioUnit:p.precioUnit}));
    document.getElementById('deudor-monto').value = d.monto;
    document.getElementById('deudor-nota').value = d.nota||'';
    document.getElementById('deudor-fecha-limite').value = coAIso(d.fechaLimite);
  } else {
    ['deudor-monto','deudor-nota','deudor-fecha-limite'].forEach(x => document.getElementById(x).value='');
  }
  renderProductosDeudor();
  abrirModal('modal-deudor');
}

async function guardarDeudor() {
  const monto = parseFloat(document.getElementById('deudor-monto').value)||0;
  const nota = document.getElementById('deudor-nota').value.trim();
  const fechaLimiteISO = document.getElementById('deudor-fecha-limite').value;
  if (!clienteDeudor||!monto) { alert('Selecciona un cliente e ingresa el monto de la deuda'); return; }
  for (const item of productosDeudor) {
    const p = DB.productos.find(x => x.id===item.productoId);
    if (p && item.cantidad > p.stock) { alert(`Solo hay ${p.stock} unidades disponibles de ${item.nombre}.`); return; }
  }

  const fechaLimite = fechaLimiteISO ? isoAFechaCO(fechaLimiteISO) : '';
  const btn = document.getElementById('btn-guardar-deudor');
  btn.textContent='Guardando...'; btn.disabled=true;
  const productos = productosDeudor.map(p=>({productoId:p.productoId, ref:p.ref, productoNombre:p.nombre, cantidad:p.cantidad, precioUnit:p.precioUnit}));

  if (editandoDeudorId) {
    const d = DB.deudores.find(x => x.id===editandoDeudorId);
    if (d) {
      Object.assign(d, {
        clienteId: clienteDeudor.id, nombre: clienteDeudor.nombre, cedula: clienteDeudor.cedula,
        telefono: clienteDeudor.telefono||'', nota, productos, monto, fechaLimite
      });
      await guardarDeudorEnSheet(d, false);
    }
    btn.textContent='Guardar'; btn.disabled=false;
    guardarLocal(); cerrarModal('modal-deudor'); renderDeudores();
    mostrarToast('Deudor actualizado ✓');
    return;
  }

  const anticipo = parseFloat(document.getElementById('deudor-anticipo').value)||0;
  const metodoPago = document.querySelector('input[name="deudor-metodo"]:checked').value;
  if (anticipo > monto) { alert('El pago inicial no puede ser mayor al monto total de la deuda'); return; }

  // El cliente se lleva los productos de una vez: se descuenta el inventario ya
  for (const item of productosDeudor) {
    const p = DB.productos.find(x => x.id===item.productoId);
    if (p) {
      p.stock = Math.max(0, p.stock - item.cantidad);
      const idxP = DB.productos.findIndex(x => x.id===p.id);
      await sheetsEscribir('update','Productos',[p.id,p.ref,p.nombre,p.pcompra,p.pventa1,p.pventa2,p.stock],idxP+2);
    }
  }

  const ahora = new Date();
  const nuevo = {
    id: uid(), clienteId: clienteDeudor.id, nombre: clienteDeudor.nombre, cedula: clienteDeudor.cedula,
    telefono: clienteDeudor.telefono||'', direccion: clienteDeudor.direccion||'',
    productos,
    monto, nota, fecha: fechaCO(ahora), hora: horaCO(ahora), fechaLimite,
    abonos: [], pagada: false
  };
  DB.deudores.push(nuevo);
  await guardarDeudorEnSheet(nuevo, true);

  if (anticipo > 0) await registrarPagoDeuda(nuevo, 'deudor', anticipo, metodoPago);

  guardarLocal(); btn.textContent='Guardar'; btn.disabled=false;
  cerrarModal('modal-deudor'); renderDeudores(); renderDashboard();
  mostrarToast('Deudor agregado ✓ (usa el botón de imprimir para el boucher)');
}

async function eliminarDeudor(id) {
  if (!confirm('¿Eliminar este deudor?')) return;
  const idx = DB.deudores.findIndex(d => d.id===id);
  await sheetsEscribir('delete','Deudores',null,idx+2);
  DB.deudores = DB.deudores.filter(d => d.id!==id);
  guardarLocal(); renderDeudores(); mostrarToast('Deudor eliminado');
}

function renderDeudores() {
  const cont = document.getElementById('deudores-contenido');
  if (DB.deudores.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-users"></i><p>Sin deudores registrados.</p></div>`;
    return;
  }

  const ordenados = DB.deudores.slice().sort((a,b) => (calcularSaldo(b)>0?1:0) - (calcularSaldo(a)>0?1:0));

  const filas = ordenados.map(d => {
    const saldo = calcularSaldo(d);
    const abonado = calcularAbonado(d);
    const vencida = deudaVencida(d);
    const badge = saldo<=0 ? '<span class="badge ok">Pagada</span>'
      : vencida ? '<span class="badge danger">Vencida</span>'
      : '<span class="badge alerta">Pendiente</span>';
    return `<tr>
      <td>${esc(d.nombre)}<div style="font-size:11px;color:var(--texto2)">CC ${esc(d.cedula)}</div></td>
      <td style="font-size:13px">${d.productos&&d.productos.length?d.productos.map(p=>esc(p.productoNombre)+' x'+p.cantidad).join(', '):'-'}</td>
      <td>${fmt(d.monto)}</td>
      <td>${fmt(abonado)}</td>
      <td style="font-weight:500">${fmt(saldo)}</td>
      <td style="font-size:13px">${d.fechaLimite||'-'}</td>
      <td>${badge}</td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap">
        ${saldo>0?`<button class="btn-primary btn-abonar-deudor" data-id="${d.id}" style="padding:6px 10px"><i class="ti ti-cash"></i></button>`:''}
        <button class="btn-secundario btn-boucher-deudor" data-id="${d.id}" style="padding:6px 10px"><i class="ti ti-printer"></i></button>
        <button class="btn-secundario btn-editar-deudor" data-id="${d.id}" style="padding:6px 10px"><i class="ti ti-edit"></i></button>
        <button class="btn-peligro btn-eliminar-deudor" data-id="${d.id}" style="padding:6px 10px"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`;
  }).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Deudor</th><th>Producto</th><th>Monto</th><th>Abonado</th><th>Saldo</th><th>Fecha límite</th><th>Estado</th><th>Acciones</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-abonar-deudor').forEach(b => b.addEventListener('click', () => abrirModalAbono(b.dataset.id, 'deudor')));
  cont.querySelectorAll('.btn-boucher-deudor').forEach(b => b.addEventListener('click', () => {
    const d = DB.deudores.find(x=>x.id===b.dataset.id); if (d) imprimirBoucherDeuda(d, 'deudor');
  }));
  cont.querySelectorAll('.btn-editar-deudor').forEach(b => b.addEventListener('click', () => abrirModalDeudor(b.dataset.id)));
  cont.querySelectorAll('.btn-eliminar-deudor').forEach(b => b.addEventListener('click', () => eliminarDeudor(b.dataset.id)));
}

// =============================================
// ANTICIPOS (el producto se queda en el inventario hasta pagar todo)
// =============================================
function agregarProductoAnticipo(p) {
  const existente = productosAnticipo.find(x=>x.productoId===p.id);
  if (existente) {
    if (existente.cantidad >= p.stock) { alert(`Solo hay ${p.stock} unidades disponibles de ${p.nombre}.`); return; }
    existente.cantidad += 1;
  } else {
    if (p.stock < 1) { alert('Sin stock disponible de este producto.'); return; }
    productosAnticipo.push({ productoId: p.id, ref: p.ref, nombre: p.nombre, cantidad: 1, precioUnit: p.pventa1 });
  }
  renderProductosAnticipo();
  recalcularMontoAnticipo();
}

function recalcularMontoAnticipo() {
  const total = productosAnticipo.reduce((a,p)=>a+p.precioUnit*p.cantidad,0);
  if (total>0) document.getElementById('anticipo-monto').value = total;
}

function renderProductosAnticipo() {
  const cont = document.getElementById('anticipo-productos-lista');
  if (productosAnticipo.length === 0) { cont.innerHTML = ''; return; }
  cont.innerHTML = productosAnticipo.map((item,idx) => `
    <div class="carrito-item">
      <div class="item-nombre">
        <strong>${esc(item.nombre)}</strong>
        <span>Ref: ${esc(item.ref)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <input type="number" value="${item.cantidad}" min="1" class="input-cantidad-anticipo" data-idx="${idx}">
        <span class="item-total">${fmt(item.precioUnit*item.cantidad)}</span>
        <button type="button" class="btn-peligro btn-quitar-producto-anticipo-item" data-idx="${idx}" style="padding:6px 10px"><i class="ti ti-x"></i></button>
      </div>
    </div>`).join('');

  cont.querySelectorAll('.input-cantidad-anticipo').forEach(input => {
    input.addEventListener('change', () => {
      const idx = parseInt(input.dataset.idx);
      const item = productosAnticipo[idx];
      const p = DB.productos.find(x=>x.id===item.productoId);
      let nuevaCant = Math.max(1, parseInt(input.value)||1);
      if (p && nuevaCant > p.stock) {
        alert(`Solo hay ${p.stock} unidades disponibles de ${item.nombre}.`);
        nuevaCant = p.stock > 0 ? p.stock : 1;
      }
      item.cantidad = nuevaCant;
      renderProductosAnticipo();
      recalcularMontoAnticipo();
    });
  });
  cont.querySelectorAll('.btn-quitar-producto-anticipo-item').forEach(b =>
    b.addEventListener('click', () => {
      productosAnticipo.splice(parseInt(b.dataset.idx),1);
      renderProductosAnticipo();
      recalcularMontoAnticipo();
    }));
}

async function guardarAnticipoEnSheet(a, esNuevo) {
  const fila = [a.id,a.clienteId,a.nombre,a.cedula,a.telefono,a.direccion,JSON.stringify(a.productos||[]),a.monto,a.nota,a.fecha,a.hora,a.fechaLimite,JSON.stringify(a.abonos),a.pagada,a.descontado];
  if (esNuevo) { await sheetsEscribir('append','Anticipos',fila); }
  else {
    const idx = DB.anticipos.findIndex(x=>x.id===a.id);
    await sheetsEscribir('update','Anticipos',fila,idx+2);
  }
}

function abrirModalAnticipo(id) {
  editandoAnticipoId = id || null;
  productosAnticipo = [];
  document.getElementById('anticipo-producto-buscar').value = '';
  document.getElementById('anticipo-producto-resultados').innerHTML = '';
  document.getElementById('anticipo-inicial').value = '';
  document.querySelector('input[name="anticipo-metodo"][value="efectivo"]').checked = true;
  quitarClienteAnticipo();
  document.getElementById('anticipo-cliente-buscar').value = '';
  document.getElementById('anticipo-cliente-resultados').innerHTML = '';
  document.getElementById('modal-anticipo-titulo').textContent = id ? 'Editar anticipo' : 'Agregar anticipo';
  if (id) {
    const a = DB.anticipos.find(x => x.id === id);
    if (!a) return;
    seleccionarClienteAnticipo({ id: a.clienteId, nombre: a.nombre, cedula: a.cedula, telefono: a.telefono });
    productosAnticipo = (a.productos||[]).map(p=>({productoId:p.productoId, ref:p.ref||'', nombre:p.productoNombre, cantidad:p.cantidad, precioUnit:p.precioUnit}));
    document.getElementById('anticipo-monto').value = a.monto;
    document.getElementById('anticipo-nota').value = a.nota||'';
    document.getElementById('anticipo-fecha-limite').value = coAIso(a.fechaLimite);
  } else {
    ['anticipo-monto','anticipo-nota','anticipo-fecha-limite'].forEach(x => document.getElementById(x).value='');
  }
  renderProductosAnticipo();
  abrirModal('modal-anticipo');
}

async function guardarAnticipo() {
  const monto = parseFloat(document.getElementById('anticipo-monto').value)||0;
  const nota = document.getElementById('anticipo-nota').value.trim();
  const fechaLimiteISO = document.getElementById('anticipo-fecha-limite').value;
  if (!clienteAnticipo||!monto) { alert('Selecciona un cliente e ingresa el monto total'); return; }
  for (const item of productosAnticipo) {
    const p = DB.productos.find(x => x.id===item.productoId);
    if (p && item.cantidad > p.stock) { alert(`Solo hay ${p.stock} unidades disponibles de ${item.nombre}.`); return; }
  }

  const fechaLimite = fechaLimiteISO ? isoAFechaCO(fechaLimiteISO) : '';
  const btn = document.getElementById('btn-guardar-anticipo');
  btn.textContent='Guardando...'; btn.disabled=true;
  const productos = productosAnticipo.map(p=>({productoId:p.productoId, ref:p.ref, productoNombre:p.nombre, cantidad:p.cantidad, precioUnit:p.precioUnit}));

  if (editandoAnticipoId) {
    const a = DB.anticipos.find(x => x.id===editandoAnticipoId);
    if (a) {
      Object.assign(a, {
        clienteId: clienteAnticipo.id, nombre: clienteAnticipo.nombre, cedula: clienteAnticipo.cedula,
        telefono: clienteAnticipo.telefono||'', nota, productos, monto, fechaLimite
      });
      await guardarAnticipoEnSheet(a, false);
    }
    btn.textContent='Guardar'; btn.disabled=false;
    guardarLocal(); cerrarModal('modal-anticipo'); renderAnticipos();
    mostrarToast('Anticipo actualizado ✓');
    return;
  }

  const inicial = parseFloat(document.getElementById('anticipo-inicial').value)||0;
  const metodoPago = document.querySelector('input[name="anticipo-metodo"]:checked').value;
  if (inicial > monto) { alert('El pago inicial no puede ser mayor al monto total'); return; }

  const ahora = new Date();
  const nuevo = {
    id: uid(), clienteId: clienteAnticipo.id, nombre: clienteAnticipo.nombre, cedula: clienteAnticipo.cedula,
    telefono: clienteAnticipo.telefono||'', direccion: clienteAnticipo.direccion||'',
    productos,
    monto, nota, fecha: fechaCO(ahora), hora: horaCO(ahora), fechaLimite,
    abonos: [], pagada: false, descontado: false
  };
  DB.anticipos.push(nuevo);
  await guardarAnticipoEnSheet(nuevo, true);

  if (inicial > 0) await registrarPagoDeuda(nuevo, 'anticipo', inicial, metodoPago);

  guardarLocal(); btn.textContent='Guardar'; btn.disabled=false;
  cerrarModal('modal-anticipo'); renderAnticipos(); renderDashboard();
  mostrarToast('Anticipo agregado ✓ (usa el botón de imprimir para el boucher)');
}

async function eliminarAnticipo(id) {
  if (!confirm('¿Eliminar este anticipo?')) return;
  const idx = DB.anticipos.findIndex(a => a.id===id);
  await sheetsEscribir('delete','Anticipos',null,idx+2);
  DB.anticipos = DB.anticipos.filter(a => a.id!==id);
  guardarLocal(); renderAnticipos(); mostrarToast('Anticipo eliminado');
}

function renderAnticipos() {
  const cont = document.getElementById('anticipos-contenido');
  if (DB.anticipos.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-cash-banknote"></i><p>Sin anticipos registrados.</p></div>`;
    return;
  }

  const ordenados = DB.anticipos.slice().sort((a,b) => (calcularSaldo(b)>0?1:0) - (calcularSaldo(a)>0?1:0));

  const filas = ordenados.map(a => {
    const saldo = calcularSaldo(a);
    const abonado = calcularAbonado(a);
    const vencida = deudaVencida(a);
    const badge = saldo<=0 ? '<span class="badge ok">Completado</span>'
      : vencida ? '<span class="badge danger">Vencido</span>'
      : '<span class="badge alerta">Pendiente</span>';
    return `<tr>
      <td>${esc(a.nombre)}<div style="font-size:11px;color:var(--texto2)">CC ${esc(a.cedula)}</div></td>
      <td style="font-size:13px">${a.productos&&a.productos.length?a.productos.map(p=>esc(p.productoNombre)+' x'+p.cantidad).join(', '):'-'}</td>
      <td>${fmt(a.monto)}</td>
      <td>${fmt(abonado)}</td>
      <td style="font-weight:500">${fmt(saldo)}</td>
      <td style="font-size:13px">${a.fechaLimite||'-'}</td>
      <td>${badge}</td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap">
        ${saldo>0?`<button class="btn-primary btn-abonar-anticipo" data-id="${a.id}" style="padding:6px 10px"><i class="ti ti-cash"></i></button>`:''}
        <button class="btn-secundario btn-boucher-anticipo" data-id="${a.id}" style="padding:6px 10px"><i class="ti ti-printer"></i></button>
        <button class="btn-secundario btn-editar-anticipo" data-id="${a.id}" style="padding:6px 10px"><i class="ti ti-edit"></i></button>
        <button class="btn-peligro btn-eliminar-anticipo" data-id="${a.id}" style="padding:6px 10px"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`;
  }).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Cliente</th><th>Producto</th><th>Monto</th><th>Abonado</th><th>Saldo</th><th>Fecha límite</th><th>Estado</th><th>Acciones</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-abonar-anticipo').forEach(b => b.addEventListener('click', () => abrirModalAbono(b.dataset.id, 'anticipo')));
  cont.querySelectorAll('.btn-boucher-anticipo').forEach(b => b.addEventListener('click', () => {
    const a = DB.anticipos.find(x=>x.id===b.dataset.id); if (a) imprimirBoucherDeuda(a, 'anticipo');
  }));
  cont.querySelectorAll('.btn-editar-anticipo').forEach(b => b.addEventListener('click', () => abrirModalAnticipo(b.dataset.id)));
  cont.querySelectorAll('.btn-eliminar-anticipo').forEach(b => b.addEventListener('click', () => eliminarAnticipo(b.dataset.id)));
}

// =============================================
// PROVEEDORES
// =============================================
function proveedorPorVencer(p) {
  if (!p.fechaLimite || calcularSaldo(p) <= 0) return false;
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const dias = Math.round((parseFechaCO(p.fechaLimite) - hoy) / 86400000);
  return dias >= 0 && dias <= 3;
}

async function guardarProveedorEnSheet(p, esNuevo) {
  const fila = [p.id,p.empresa,p.fechaLlegadaPedido,p.monto,p.numeroCuotas,p.fechaLimite,p.fecha,p.hora,JSON.stringify(p.abonos),p.pagada];
  if (esNuevo) { await sheetsEscribir('append','Proveedores',fila); }
  else {
    const idx = DB.proveedores.findIndex(x=>x.id===p.id);
    await sheetsEscribir('update','Proveedores',fila,idx+2);
  }
}

function abrirModalProveedor() {
  ['proveedor-empresa','proveedor-fecha-llegada','proveedor-monto','proveedor-fecha-limite'].forEach(x => document.getElementById(x).value='');
  document.getElementById('proveedor-cuotas').value = '1';
  abrirModal('modal-proveedor');
}

async function guardarProveedor() {
  const empresa = document.getElementById('proveedor-empresa').value.trim();
  const fechaLlegadaISO = document.getElementById('proveedor-fecha-llegada').value;
  const monto = parseFloat(document.getElementById('proveedor-monto').value)||0;
  const numeroCuotas = parseInt(document.getElementById('proveedor-cuotas').value)||1;
  const fechaLimiteISO = document.getElementById('proveedor-fecha-limite').value;
  if (!empresa||!monto) { alert('Completa los campos obligatorios (*)'); return; }

  const ahora = new Date();
  const nuevo = {
    id: uid(), empresa,
    fechaLlegadaPedido: fechaLlegadaISO ? isoAFechaCO(fechaLlegadaISO) : '',
    monto, numeroCuotas,
    fechaLimite: fechaLimiteISO ? isoAFechaCO(fechaLimiteISO) : '',
    fecha: fechaCO(ahora), hora: horaCO(ahora),
    abonos: [], pagada: false
  };
  DB.proveedores.push(nuevo);
  await guardarProveedorEnSheet(nuevo, true);

  guardarLocal();
  cerrarModal('modal-proveedor');
  renderProveedores();
  renderDashboard();
  mostrarToast('Factura de proveedor agregada ✓');
}

async function eliminarProveedor(id) {
  if (!confirm('¿Eliminar esta factura de proveedor?')) return;
  const idx = DB.proveedores.findIndex(p => p.id===id);
  await sheetsEscribir('delete','Proveedores',null,idx+2);
  DB.proveedores = DB.proveedores.filter(p => p.id!==id);
  guardarLocal(); renderProveedores(); mostrarToast('Factura eliminada');
}

function abrirModalAbonoProveedor(id) {
  proveedorAbonoActual = id;
  const p = DB.proveedores.find(x => x.id===id);
  if (!p) return;
  document.getElementById('abono-proveedor-nombre').textContent = p.empresa;
  document.getElementById('abono-proveedor-saldo').textContent = `Saldo pendiente: ${fmt(calcularSaldo(p))}`;
  document.getElementById('abono-proveedor-monto').value = '';
  document.querySelector('input[name="abono-proveedor-metodo"][value="efectivo"]').checked = true;
  abrirModal('modal-abono-proveedor');
  setTimeout(() => document.getElementById('abono-proveedor-monto').focus(), 100);
}

async function guardarAbonoProveedor() {
  const p = DB.proveedores.find(x => x.id===proveedorAbonoActual);
  if (!p) return;
  const monto = parseFloat(document.getElementById('abono-proveedor-monto').value)||0;
  const saldo = calcularSaldo(p);
  if (!monto || monto<=0) { alert('Ingresa un monto válido'); return; }
  if (monto > saldo) { alert(`El pago no puede ser mayor al saldo pendiente (${fmt(saldo)})`); return; }
  const metodoPago = document.querySelector('input[name="abono-proveedor-metodo"]:checked').value;

  const ahora = new Date();
  p.abonos = p.abonos || [];
  p.abonos.push({ id: uid(), monto, metodoPago, fecha: fechaCO(ahora), hora: horaCO(ahora) });
  p.pagada = calcularSaldo(p) <= 0;

  await guardarProveedorEnSheet(p, false);
  guardarLocal();
  cerrarModal('modal-abono-proveedor');
  renderProveedores();
  renderDashboard();
  mostrarToast(p.pagada ? 'Factura pagada completamente ✓' : `Pago registrado · ${fmt(monto)}. Usa el botón de imprimir si quieres el boucher.`);
}

function imprimirBoucherProveedor(p) {
  const ahora = new Date();
  const abonos = p.abonos||[];
  const saldo = calcularSaldo(p);
  const valorCuota = p.numeroCuotas>0 ? p.monto/p.numeroCuotas : p.monto;
  const cuotasPendientes = valorCuota>0 ? Math.min(p.numeroCuotas, Math.ceil(saldo/valorCuota)) : 0;

  const filasAbonos = abonos.map((a,i) => `
    <tr>
      <td>${i+1}</td>
      <td>${a.fecha} ${a.hora}</td>
      <td>${a.metodoPago==='transferencia'?'Transferencia':'Efectivo'}</td>
      <td style="text-align:right">${fmt(a.monto)}</td>
    </tr>`).join('');

  document.getElementById('proveedor-print-contenido').innerHTML = `
    <div id="tp-header">
      <h1>Multirepuestos SoloAgro</h1>
      <p>Comprobante de pago a proveedor</p>
    </div>
    <div id="tp-meta">
      <span><strong>Fecha:</strong> ${fechaCO(ahora)}</span>
      <span><strong>Hora:</strong> ${horaCO(ahora)}</span>
    </div>
    <p style="font-size:13px;margin-bottom:4px"><strong>Proveedor:</strong> ${esc(p.empresa)}</p>
    ${p.fechaLlegadaPedido?`<p style="font-size:13px;margin-bottom:4px"><strong>Fecha de llegada del pedido:</strong> ${p.fechaLlegadaPedido}</p>`:''}
    <p style="font-size:13px;margin-bottom:4px"><strong>Cuotas pendientes:</strong> ${cuotasPendientes} de ${p.numeroCuotas}</p>
    ${p.fechaLimite?`<p style="font-size:13px;margin-bottom:12px"><strong>Fecha límite de pago:</strong> ${p.fechaLimite}</p>`:''}
    <p style="margin-top:8px;font-size:14px"><strong>Monto total del pedido: ${fmt(p.monto)}</strong></p>
    ${abonos.length?`
      <p style="margin-top:12px;font-size:13px"><strong>Pagos realizados:</strong></p>
      <table>
        <thead><tr><th>#</th><th>Fecha</th><th>Método</th><th>Monto</th></tr></thead>
        <tbody>${filasAbonos}</tbody>
      </table>`:''}
    <p style="margin-top:12px;font-size:16px"><strong>Saldo pendiente: ${fmt(saldo)}</strong></p>
    ${saldo<=0?'<p style="text-align:center;margin-top:8px;font-size:13px">FACTURA CANCELADA EN SU TOTALIDAD</p>':''}
  `;

  prepararImpresion('proveedor-print');
  window.print();
}

function renderProveedores() {
  const cont = document.getElementById('proveedores-contenido');
  if (DB.proveedores.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-building-warehouse"></i><p>Sin facturas de proveedores registradas.</p></div>`;
    return;
  }

  const ordenados = DB.proveedores.slice().sort((a,b) => (calcularSaldo(b)>0?1:0) - (calcularSaldo(a)>0?1:0));

  const filas = ordenados.map(p => {
    const saldo = calcularSaldo(p);
    const abonado = calcularAbonado(p);
    const vencida = deudaVencida(p);
    const porVencer = proveedorPorVencer(p);
    const badge = saldo<=0 ? '<span class="badge ok">Pagada</span>'
      : vencida ? '<span class="badge danger">Vencida</span>'
      : porVencer ? '<span class="badge alerta">Por vencer</span>'
      : '<span class="badge rosa">Pendiente</span>';
    return `<tr>
      <td>${esc(p.empresa)}</td>
      <td style="font-size:13px">${p.fechaLlegadaPedido||'-'}</td>
      <td>${fmt(p.monto)}</td>
      <td>${fmt(abonado)}</td>
      <td style="font-weight:500">${fmt(saldo)}</td>
      <td style="font-size:13px">${p.numeroCuotas}</td>
      <td style="font-size:13px">${p.fechaLimite||'-'}</td>
      <td>${badge}</td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap">
        ${saldo>0?`<button class="btn-primary btn-abonar-proveedor" data-id="${p.id}" style="padding:6px 10px"><i class="ti ti-cash"></i></button>`:''}
        <button class="btn-secundario btn-boucher-proveedor" data-id="${p.id}" style="padding:6px 10px"><i class="ti ti-printer"></i></button>
        <button class="btn-peligro btn-eliminar-proveedor" data-id="${p.id}" style="padding:6px 10px"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`;
  }).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Empresa</th><th>Llegada pedido</th><th>Monto</th><th>Abonado</th><th>Saldo</th><th>Cuotas</th><th>Fecha límite</th><th>Estado</th><th>Acciones</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-abonar-proveedor').forEach(b => b.addEventListener('click', () => abrirModalAbonoProveedor(b.dataset.id)));
  cont.querySelectorAll('.btn-boucher-proveedor').forEach(b => b.addEventListener('click', () => {
    const p = DB.proveedores.find(x=>x.id===b.dataset.id); if (p) imprimirBoucherProveedor(p);
  }));
  cont.querySelectorAll('.btn-eliminar-proveedor').forEach(b => b.addEventListener('click', () => eliminarProveedor(b.dataset.id)));
}

// =============================================
// GASTOS DEL LOCAL
// =============================================
function seleccionarCategoriaGasto(cat, btn) {
  gastoCategoriaSeleccionada = cat;
  document.querySelectorAll('.gasto-cat-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function abrirModalGasto() {
  gastoCategoriaSeleccionada = null;
  document.querySelectorAll('.gasto-cat-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('gasto-monto').value = '';
  document.getElementById('gasto-nota').value = '';
  document.querySelector('input[name="gasto-metodo"][value="efectivo"]').checked = true;
  abrirModal('modal-gasto');
}

async function guardarGasto() {
  const monto = parseFloat(document.getElementById('gasto-monto').value)||0;
  const metodoPago = document.querySelector('input[name="gasto-metodo"]:checked').value;
  const nota = document.getElementById('gasto-nota').value.trim();
  if (!gastoCategoriaSeleccionada) { alert('Selecciona una categoría de gasto'); return; }
  if (!monto || monto<=0) { alert('Ingresa un monto válido'); return; }

  const ahora = new Date();
  const gasto = { id: uid(), categoria: gastoCategoriaSeleccionada, monto, metodoPago, fecha: fechaCO(ahora), hora: horaCO(ahora), nota };
  DB.gastos.push(gasto);
  await sheetsEscribir('append','Gastos',[gasto.id,gasto.categoria,gasto.monto,gasto.metodoPago,gasto.fecha,gasto.hora,gasto.nota]);

  guardarLocal();
  cerrarModal('modal-gasto');
  renderGastos();
  mostrarToast('Gasto registrado ✓');
}

async function eliminarGasto(id) {
  if (!confirm('¿Eliminar este gasto?')) return;
  const idx = DB.gastos.findIndex(g => g.id===id);
  await sheetsEscribir('delete','Gastos',null,idx+2);
  DB.gastos = DB.gastos.filter(g => g.id!==id);
  guardarLocal(); renderGastos(); mostrarToast('Gasto eliminado');
}

function renderGastos() {
  const ahora = new Date();
  const gastosMes = DB.gastos.filter(g => {
    const d = parseFechaCO(g.fecha);
    return d.getMonth()===ahora.getMonth() && d.getFullYear()===ahora.getFullYear();
  });
  const totalMes = gastosMes.reduce((a,g)=>a+g.monto,0);
  const efectivoMes = gastosMes.filter(g=>g.metodoPago!=='transferencia').reduce((a,g)=>a+g.monto,0);
  const transferenciaMes = gastosMes.filter(g=>g.metodoPago==='transferencia').reduce((a,g)=>a+g.monto,0);

  document.getElementById('gastos-resumen').innerHTML = `
    <div id="dash-metrics">
      <div class="metric rosa"><div class="mlabel">Gastos de este mes</div><div class="mvalue">${fmt(totalMes)}</div></div>
      <div class="metric"><div class="mlabel">💵 Efectivo</div><div class="mvalue">${fmt(efectivoMes)}</div></div>
      <div class="metric"><div class="mlabel">🏦 Transferencia</div><div class="mvalue">${fmt(transferenciaMes)}</div></div>
    </div>`;

  const cont = document.getElementById('gastos-contenido');
  if (DB.gastos.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-receipt-2"></i><p>Sin gastos registrados.</p></div>`;
    return;
  }

  const filas = DB.gastos.slice().reverse().map(g => `
    <tr>
      <td>${g.fecha}</td>
      <td><span class="badge rosa">${esc(g.categoria)}</span></td>
      <td>${fmt(g.monto)}</td>
      <td><span class="badge ${g.metodoPago==='transferencia'?'rosa':'verde'}">${g.metodoPago==='transferencia'?'🏦 Transferencia':'💵 Efectivo'}</span></td>
      <td style="font-size:13px;color:var(--texto2)">${esc(g.nota)||'-'}</td>
      <td><button class="btn-peligro btn-eliminar-gasto" data-id="${g.id}" style="padding:5px 9px"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Fecha</th><th>Categoría</th><th>Monto</th><th>Método</th><th>Nota</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-eliminar-gasto').forEach(b => b.addEventListener('click', () => eliminarGasto(b.dataset.id)));
}

// =============================================
// DASHBOARD
// =============================================
function renderDashboard() {
  const hoy = fechaCO();
  const ventasHoy = DB.ventas.filter(v => v.fecha === hoy);
  const totalVendido  = ventasHoy.reduce((a,v) => a+v.total, 0);
  const sinStock  = DB.productos.filter(p => p.stock <= 0).length;
  const stockBajo = DB.productos.filter(p => p.stock > 0 && p.stock <= DB.config.stockMin).length;
  const deudasVencidas = DB.deudores.filter(d => deudaVencida(d)).length;
  const anticiposVencidos = DB.anticipos.filter(a => deudaVencida(a)).length;
  const facturasPorVencer = DB.proveedores.filter(p => proveedorPorVencer(p)).length;
  const facturasVencidas = DB.proveedores.filter(p => deudaVencida(p)).length;

  document.getElementById('dash-fecha').textContent = 'Hoy · ' + new Date().toLocaleDateString('es-CO',{weekday:'long',year:'numeric',month:'long',day:'numeric'});

  document.getElementById('dash-metrics').innerHTML = `
    <div class="metric rosa"><div class="mlabel">Total vendido hoy</div><div class="mvalue">${fmt(totalVendido)}</div></div>
    <div class="metric"><div class="mlabel">Transacciones</div><div class="mvalue">${ventasHoy.length}</div></div>
    <div class="metric"><div class="mlabel">Productos</div><div class="mvalue">${DB.productos.length}</div></div>
    ${stockBajo>0?`<div class="metric alerta"><div class="mlabel">Stock bajo</div><div class="mvalue">${stockBajo}</div></div>`:''}
    ${sinStock>0?`<div class="metric danger"><div class="mlabel">Sin stock</div><div class="mvalue">${sinStock}</div></div>`:''}
    ${deudasVencidas>0?`<div class="metric danger"><div class="mlabel">Deudas vencidas</div><div class="mvalue">${deudasVencidas}</div></div>`:''}
    ${anticiposVencidos>0?`<div class="metric danger"><div class="mlabel">Anticipos vencidos</div><div class="mvalue">${anticiposVencidos}</div></div>`:''}
    ${facturasPorVencer>0?`<div class="metric alerta"><div class="mlabel">Facturas por vencer</div><div class="mvalue">${facturasPorVencer}</div></div>`:''}
    ${facturasVencidas>0?`<div class="metric danger"><div class="mlabel">Facturas vencidas</div><div class="mvalue">${facturasVencidas}</div></div>`:''}
  `;

  const cont = document.getElementById('dash-ventas-hoy');
  if (ventasHoy.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-shopping-bag"></i><p>Sin ventas hoy. ¡A vender!</p></div>`;
    return;
  }

  const filas = ventasHoy.slice().reverse().map(v => `
    <tr class="fila-venta-clickeable" data-id="${v.id}">
      <td>${v.hora}</td>
      <td style="font-size:13px">${(v.items||[]).map(i=>esc(i.nombre)+' x'+i.cantidad).join(', ')}</td>
      <td style="font-size:13px;color:var(--texto2)">${v.nota||'-'}</td>
      <td><span class="badge ${v.metodoPago==='transferencia'?'rosa':'verde'}">${v.metodoPago==='transferencia'?'🏦 Transferencia':'💵 Efectivo'}</span></td>
      <td style="font-weight:500">${fmt(v.total)}</td>
      <td><i class="ti ti-receipt" style="color:var(--rosa-medio);font-size:16px"></i></td>
    </tr>`).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Hora</th><th>Productos</th><th>Nota</th><th>Pago</th><th>Total</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.fila-venta-clickeable').forEach(f =>
    f.addEventListener('click', () => {
      const v = DB.ventas.find(x => x.id === f.dataset.id);
      if (v) abrirFactura(v);
    }));
}

// =============================================
// FACTURA
// =============================================
function abrirFactura(venta) {
  facturaVentaActual = venta;
  const metodoBadge = venta.metodoPago === 'transferencia'
    ? '<span class="badge rosa">🏦 Transferencia</span>'
    : '<span class="badge verde">💵 Efectivo</span>';

  const filas = venta.items.map(i => `
    <tr>
      <td><code style="background:var(--blush-claro);padding:2px 7px;border-radius:4px;font-size:12px">${esc(i.ref||'-')}</code></td>
      <td>${esc(i.nombre)}</td>
      <td style="text-align:center">${i.cantidad}</td>
      <td style="text-align:right">${fmt(i.precio)}</td>
    </tr>`).join('');

  document.getElementById('factura-contenido').innerHTML = `
    <div style="text-align:center;margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:0.5px solid var(--borde)">
      <div style="font-size:28px;color:var(--rosa);margin-bottom:6px"><i class="ti ti-sparkles"></i></div>
      <h2 style="font-family:var(--fuente-titulo);font-size:22px;color:var(--rosa-oscuro)">Multirepuestos SoloAgro</h2>
      <p style="font-size:12px;color:var(--texto2);margin-top:4px">Inventario & Ventas</p>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:1rem;font-size:13px;color:var(--texto2)">
      <div><div><strong>Fecha:</strong> ${venta.fecha}</div><div><strong>Hora:</strong> ${venta.hora}</div></div>
      <div style="text-align:right"><div><strong>Método:</strong></div><div style="margin-top:4px">${metodoBadge}</div></div>
    </div>
    ${venta.clienteNombre?`<div style="background:var(--blush-claro);padding:8px 12px;border-radius:8px;font-size:13px;color:var(--texto2);margin-bottom:1rem">
      <p style="margin-bottom:2px"><strong>Cliente:</strong> ${esc(venta.clienteNombre)}</p>
      <p style="margin-bottom:2px"><strong>Cédula:</strong> ${esc(venta.clienteCedula||'-')}</p>
      ${venta.clienteTelefono?`<p style="margin-bottom:2px"><strong>Teléfono:</strong> ${esc(venta.clienteTelefono)}</p>`:''}
      ${venta.clienteDireccion?`<p><strong>Dirección:</strong> ${esc(venta.clienteDireccion)}</p>`:''}
    </div>`:''}
    ${venta.nota?`<div style="background:var(--blush-claro);padding:8px 12px;border-radius:8px;font-size:13px;color:var(--texto2);margin-bottom:1rem">📝 ${esc(venta.nota)}</div>`:''}
    <div class="tabla-wrap"><table>
      <thead><tr><th>Código</th><th>Producto</th><th style="text-align:center">Cant.</th><th style="text-align:right">Precio</th></tr></thead>
      <tbody>${filas}</tbody>
    </table></div>
    <div style="margin-top:1rem;padding-top:1rem;border-top:0.5px solid var(--borde)">
      <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:600;color:var(--rosa-oscuro);font-family:var(--fuente-titulo)">
        <span>${venta.saldoPendiente!==undefined?'Pagado ahora':'Total'}</span><span>${fmt(venta.total)}</span>
      </div>
      ${venta.saldoPendiente!==undefined?`
      <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:600;color:#A32D2D;margin-top:6px">
        <span>Falta por cancelar</span><span>${fmt(venta.saldoPendiente)}</span>
      </div>`:''}
    </div>
    <div style="text-align:center;margin-top:1.5rem;padding-top:1rem;border-top:0.5px solid var(--borde);font-size:12px;color:var(--texto3)">¡Gracias por tu compra! 🌸</div>
  `;
  abrirModal('modal-factura');
}

// Boucher de impresión — no muestra ganancias
function imprimirBoucher(venta) {
  const metodoTexto = venta.metodoPago === 'transferencia' ? 'Transferencia' : 'Efectivo';

  const filas = venta.items.map(i => `
    <tr>
      <td>${esc(i.ref||'-')}</td>
      <td>${esc(i.nombre)}</td>
      <td style="text-align:center">${i.cantidad}</td>
      <td style="text-align:right">${fmt(i.precio)}</td>
    </tr>`).join('');

  document.getElementById('venta-print-contenido').innerHTML = `
    <div id="tp-header">
      <h1>Multirepuestos SoloAgro</h1>
      <p>Comprobante de venta</p>
    </div>
    <div id="tp-meta">
      <span><strong>Fecha:</strong> ${venta.fecha}</span>
      <span><strong>Hora:</strong> ${venta.hora}</span>
    </div>
    ${venta.clienteNombre?`
    <p style="font-size:13px;margin-bottom:4px"><strong>Cliente:</strong> ${esc(venta.clienteNombre)}</p>
    <p style="font-size:13px;margin-bottom:4px"><strong>Cédula:</strong> ${esc(venta.clienteCedula||'-')}</p>
    ${venta.clienteTelefono?`<p style="font-size:13px;margin-bottom:4px"><strong>Teléfono:</strong> ${esc(venta.clienteTelefono)}</p>`:''}
    ${venta.clienteDireccion?`<p style="font-size:13px;margin-bottom:10px"><strong>Dirección:</strong> ${esc(venta.clienteDireccion)}</p>`:''}
    `:''}
    ${venta.nota?`<p style="font-size:13px;margin-bottom:10px"><strong>Nota:</strong> ${esc(venta.nota)}</p>`:''}
    <table>
      <thead><tr><th>Código</th><th>Producto</th><th>Cant.</th><th>Precio</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <p style="margin-top:12px;font-size:14px;text-align:right"><strong>${venta.saldoPendiente!==undefined?'Pagado ahora':'Total'}: ${fmt(venta.total)}</strong></p>
    ${venta.saldoPendiente!==undefined?`<p style="margin-top:4px;font-size:14px;text-align:right;color:#A32D2D"><strong>Falta por cancelar: ${fmt(venta.saldoPendiente)}</strong></p>`:''}
    <p style="margin-top:4px;font-size:12px;text-align:right">Método de pago: ${metodoTexto}</p>
    <p style="text-align:center;margin-top:20px;font-size:12px">¡Gracias por tu compra!</p>
  `;

  prepararImpresion('venta-print');
  window.print();
}

// =============================================
// INVENTARIO
// =============================================
function renderInventario() {
  const q = document.getElementById('inv-search').value.toLowerCase();
  const prods = DB.productos.filter(p =>
    p.nombre.toLowerCase().includes(q) || p.ref.toLowerCase().includes(q));
  const cont = document.getElementById('inv-contenido');

  if (prods.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-package"></i><p>Sin productos.</p></div>`;
    return;
  }

  const visibles = prods.slice(0, inventarioMostrar);
  const filas = visibles.map(p => {
    const badge = p.stock<=0 ? '<span class="badge danger">Sin stock</span>'
      : p.stock<=DB.config.stockMin ? '<span class="badge alerta">Stock bajo</span>'
      : '<span class="badge ok">OK</span>';
    const pc = precioCompraVisible
      ? fmt(p.pcompra)
      : `<span class="precio-oculto" data-id="${p.id}">${fmt(p.pcompra)}</span>`;
    return `<tr>
      <td><code style="background:var(--blush-claro);padding:2px 7px;border-radius:4px;font-size:12px">${esc(p.ref)}</code></td>
      <td>${esc(p.nombre)}</td><td>${pc}</td>
      <td>${fmt(p.pventa1)}</td><td>${p.pventa2?fmt(p.pventa2):'-'}</td>
      <td>${p.stock} ${badge}</td>
      <td><div style="display:flex;gap:6px">
        <button class="btn-secundario btn-editar-producto" data-id="${p.id}" style="padding:6px 10px"><i class="ti ti-edit"></i></button>
        <button class="btn-peligro btn-eliminar-producto" data-id="${p.id}" style="padding:6px 10px"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`;
  }).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Ref</th><th>Nombre</th><th>P.Compra <i class="ti ti-lock" style="font-size:10px"></i></th><th>P.Venta 1</th><th>P.Venta 2</th><th>Stock</th><th>Acciones</th></tr></thead>
    <tbody>${filas}</tbody></table></div>
    ${prods.length>inventarioMostrar?`<button class="btn-secundario" id="btn-ver-mas-inventario" style="width:100%;margin-top:10px">Ver más productos (${prods.length-inventarioMostrar} restantes)</button>`:''}`;

  cont.querySelectorAll('.btn-editar-producto').forEach(b => b.addEventListener('click', () => abrirModalProducto(b.dataset.id)));
  cont.querySelectorAll('.btn-eliminar-producto').forEach(b => b.addEventListener('click', () => eliminarProducto(b.dataset.id)));
  cont.querySelectorAll('.precio-oculto').forEach(b => b.addEventListener('click', pedirPin));
  const btnVerMas = document.getElementById('btn-ver-mas-inventario');
  if (btnVerMas) btnVerMas.addEventListener('click', () => { inventarioMostrar += 10; renderInventario(); });
}

function abrirModalProducto(id) {
  editandoProductoId = id || null;
  document.getElementById('modal-prod-titulo').textContent = id ? 'Editar producto' : 'Agregar producto';
  if (id) {
    const p = DB.productos.find(x => x.id === id);
    if (!p) return;
    document.getElementById('prod-ref').value     = p.ref;
    document.getElementById('prod-nombre').value  = p.nombre;
    document.getElementById('prod-pcompra').value = p.pcompra;
    document.getElementById('prod-pventa1').value = p.pventa1;
    document.getElementById('prod-pventa2').value = p.pventa2||'';
    document.getElementById('prod-stock').value   = p.stock;
  } else {
    ['prod-ref','prod-nombre','prod-pcompra','prod-pventa1','prod-pventa2','prod-stock'].forEach(x => document.getElementById(x).value='');
  }
  abrirModal('modal-producto');
}

async function guardarProducto() {
  const ref=document.getElementById('prod-ref').value.trim();
  const nombre=document.getElementById('prod-nombre').value.trim();
  const pcompra=parseFloat(document.getElementById('prod-pcompra').value)||0;
  const pventa1=parseFloat(document.getElementById('prod-pventa1').value)||0;
  const pventa2=parseFloat(document.getElementById('prod-pventa2').value)||0;
  const stock=parseInt(document.getElementById('prod-stock').value)||0;
  if (!ref||!nombre||!pventa1) { alert('Completa los campos obligatorios (*)'); return; }

  const btn = document.getElementById('btn-guardar-producto');
  btn.textContent='Guardando...'; btn.disabled=true;

  if (editandoProductoId) {
    const p = DB.productos.find(x => x.id===editandoProductoId);
    if (p) {
      Object.assign(p,{ref,nombre,pcompra,pventa1,pventa2,stock});
      const idx = DB.productos.findIndex(x => x.id===editandoProductoId);
      await sheetsEscribir('update','Productos',[p.id,p.ref,p.nombre,p.pcompra,p.pventa1,p.pventa2,p.stock],idx+2);
    }
  } else {
    const nuevo={id:uid(),ref,nombre,pcompra,pventa1,pventa2,stock};
    DB.productos.push(nuevo);
    await sheetsEscribir('append','Productos',[nuevo.id,nuevo.ref,nuevo.nombre,nuevo.pcompra,nuevo.pventa1,nuevo.pventa2,nuevo.stock]);
  }

  guardarLocal(); btn.textContent='Guardar'; btn.disabled=false;
  cerrarModal('modal-producto'); renderInventario();
  mostrarToast(editandoProductoId?'Producto actualizado ✓':'Producto agregado ✓');
}

async function eliminarProducto(id) {
  if (!confirm('¿Eliminar este producto?')) return;
  const idx = DB.productos.findIndex(p => p.id===id);
  await sheetsEscribir('delete','Productos',null,idx+2);
  DB.productos = DB.productos.filter(p => p.id!==id);
  guardarLocal(); renderInventario(); mostrarToast('Producto eliminado');
}

// PIN
function pedirPin() {
  document.getElementById('pin-input').value='';
  document.getElementById('pin-error').classList.add('hidden');
  abrirModal('modal-pin');
}
function verificarPin() {
  const p = document.getElementById('pin-input').value;
  const admin = DB.usuarios.find(u => u.rol==='admin' && u.pass===p);
  if (admin) { precioCompraVisible=true; cerrarModal('modal-pin'); renderInventario(); }
  else document.getElementById('pin-error').classList.remove('hidden');
}

// =============================================
// VENTAS — FLUJO RÁPIDO PUNTO 1
// =============================================
function buscarProductoVenta() {
  const q = document.getElementById('venta-search').value.toLowerCase();
  const cont = document.getElementById('venta-resultados');
  indiceVenta = 0;
  if (!q) { cont.innerHTML=''; resultadosVenta=[]; return; }

  resultadosVenta = DB.productos
    .filter(p => (p.nombre.toLowerCase().includes(q)||p.ref.toLowerCase().includes(q)) && p.stock>0)
    .slice(0,8);

  if (resultadosVenta.length===0) { cont.innerHTML='<p style="font-size:13px;color:var(--texto2);padding:8px 0">Sin resultados con stock disponible</p>'; return; }

  renderResultadosVenta();
}

function renderResultadosVenta() {
  const cont = document.getElementById('venta-resultados');
  cont.innerHTML = `
    <div style="background:var(--card);border:0.5px solid var(--borde);border-radius:12px;overflow:hidden;margin-bottom:1rem;box-shadow:0 4px 16px rgba(31,122,77,0.12)">
      <div style="padding:8px 12px;background:var(--blush-claro);border-bottom:0.5px solid var(--borde);font-size:11px;color:var(--texto2);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">
        Resultados — ↑↓ para navegar, Enter para seleccionar
      </div>
      ${resultadosVenta.map((p,i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:0.5px solid var(--borde);flex-wrap:wrap;gap:8px;${i===indiceVenta?'background:var(--rosa-claro)':''}">
          <div>
            ${i===indiceVenta?'<span style="font-size:10px;background:var(--rosa);color:#fff;padding:2px 7px;border-radius:10px;margin-right:6px">↵ Enter</span>':''}
            <span style="font-size:14px;font-weight:500">${esc(p.nombre)}</span>
            <div style="font-size:12px;color:var(--texto2)">Ref: ${esc(p.ref)} · Stock: ${p.stock} · P1: ${fmt(p.pventa1)}${p.pventa2?' · P2: '+fmt(p.pventa2):''}</div>
          </div>
          <button class="btn-primary btn-agregar-rapido" data-id="${p.id}" style="flex-shrink:0"><i class="ti ti-plus"></i> Agregar</button>
        </div>`).join('')}
    </div>`;

  cont.querySelectorAll('.btn-agregar-rapido').forEach(b =>
    b.addEventListener('click', () => abrirFlujRapido(b.dataset.id)));
}

// Flujo rápido: abre modal con cantidad
function abrirFlujRapido(id) {
  const p = DB.productos.find(x => x.id===id);
  if (!p) return;
  rapidoProductoActual = p;

  document.getElementById('rapido-nombre').textContent = p.nombre;
  document.getElementById('rapido-cantidad').value = '1';
  document.getElementById('rapido-paso-cantidad').classList.remove('hidden');
  document.getElementById('rapido-paso-precio').classList.add('hidden');

  abrirModal('modal-rapido');
  setTimeout(() => document.getElementById('rapido-cantidad').focus(), 100);

  // Limpiar búsqueda al abrir
  document.getElementById('venta-search').value = '';
  document.getElementById('venta-resultados').innerHTML = '';
  resultadosVenta = [];
}

// Paso 2: mostrar precios
function rapidoMostrarPrecio() {
  const cant = parseInt(document.getElementById('rapido-cantidad').value)||1;
  if (cant < 1) return;

  const p = rapidoProductoActual;
  const disponible = p.stock - cantidadEnCarrito(p.id);
  if (cant > disponible) {
    alert(`Solo hay ${Math.max(disponible,0)} unidades disponibles de este producto.`);
    return;
  }

  document.getElementById('rapido-paso-cantidad').classList.add('hidden');
  document.getElementById('rapido-paso-precio').classList.remove('hidden');

  const btn1 = document.getElementById('rapido-btn-p1');
  btn1.innerHTML = `<span>Precio 1 — normal</span><strong>${fmt(p.pventa1)}</strong>`;

  const btn2 = document.getElementById('rapido-btn-p2');
  if (p.pventa2) {
    btn2.innerHTML = `<span>Precio 2 — especial</span><strong>${fmt(p.pventa2)}</strong>`;
    btn2.disabled = false;
    btn2.style.opacity = '1';
  } else {
    btn2.innerHTML = `<span>Precio 2</span><span style="color:var(--texto3)">No definido</span>`;
    btn2.disabled = true;
    btn2.style.opacity = '0.4';
  }

  document.getElementById('rapido-precio-custom').value = '';
  setTimeout(() => document.getElementById('rapido-btn-p1').focus(), 100);
}

function cantidadEnCarrito(id) {
  return carrito.filter(i => i.id===id).reduce((a,i) => a+i.cantidad, 0);
}

// Agregar al carrito desde flujo rápido
function rapidoAgregarConPrecio(precio) {
  const p = rapidoProductoActual;
  const cant = parseInt(document.getElementById('rapido-cantidad').value)||1;

  const yaEsta = carrito.find(i => i.id===p.id && i.precio===precio);
  if (yaEsta) {
    yaEsta.cantidad += cant;
    yaEsta.total = yaEsta.cantidad * yaEsta.precio;
  } else {
    carrito.push({
      id: p.id, nombre: p.nombre, ref: p.ref, pcompra: p.pcompra,
      precio, pventa1: p.pventa1, pventa2: p.pventa2,
      cantidad: cant, total: precio * cant
    });
  }

  cerrarModal('modal-rapido');
  renderCarrito();
  mostrarToast(`${p.nombre} agregado al carrito ✓`);

  // Volver al buscador automáticamente
  setTimeout(() => document.getElementById('venta-search').focus(), 150);
}

function renderCarrito() {
  const cont   = document.getElementById('carrito');
  const footer = document.getElementById('venta-footer');

  if (carrito.length===0) { cont.innerHTML=''; footer.classList.add('hidden'); return; }
  footer.classList.remove('hidden');

  cont.innerHTML = `
    <div style="background:var(--card);border:0.5px solid var(--borde);border-radius:12px;overflow:hidden;margin-bottom:1rem">
      <div style="padding:8px 12px;background:var(--rosa-claro);border-bottom:0.5px solid var(--borde);font-size:11px;color:var(--rosa-oscuro);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">
        🛒 Productos en el carrito (${carrito.length})
      </div>
      ${carrito.map((item,idx) => `
        <div class="carrito-item" style="border-radius:0;border-left:none;border-right:none;border-top:none">
          <div class="item-nombre">
            <strong>${esc(item.nombre)}</strong>
            <span>Ref: ${esc(item.ref)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <input type="number" value="${item.cantidad}" min="1" class="input-cantidad-carrito" data-idx="${idx}">
            <button class="btn-dorado btn-cambiar-precio" data-idx="${idx}"><i class="ti ti-tag"></i> ${fmt(item.precio)}</button>
            <span class="item-total">${fmt(item.total)}</span>
            <button class="btn-peligro btn-quitar-carrito" data-idx="${idx}" style="padding:6px 10px"><i class="ti ti-x"></i></button>
          </div>
        </div>`).join('')}
    </div>`;

  document.getElementById('vt-total').textContent = fmt(carrito.reduce((a,i)=>a+i.total,0));

  cont.querySelectorAll('.input-cantidad-carrito').forEach(input => {
    input.addEventListener('change', () => {
      const idx = parseInt(input.dataset.idx);
      const item = carrito[idx];
      const p = DB.productos.find(x=>x.id===item.id);
      const otras = carrito.filter((i,ix)=>ix!==idx && i.id===item.id).reduce((a,i)=>a+i.cantidad,0);
      const disponible = p ? p.stock - otras : Infinity;
      let nuevaCant = Math.max(1, parseInt(input.value)||1);
      if (nuevaCant > disponible) {
        alert(`Solo hay ${Math.max(disponible,0)} unidades disponibles de este producto.`);
        nuevaCant = disponible > 0 ? disponible : 1;
      }
      item.cantidad = nuevaCant;
      item.total = item.cantidad * item.precio;
      renderCarrito();
    });
  });

  cont.querySelectorAll('.btn-cambiar-precio').forEach(b =>
    b.addEventListener('click', () => abrirModalPrecio(parseInt(b.dataset.idx))));

  cont.querySelectorAll('.btn-quitar-carrito').forEach(b =>
    b.addEventListener('click', () => { carrito.splice(parseInt(b.dataset.idx),1); renderCarrito(); }));
}

function abrirModalPrecio(idx) {
  carritoItemEditando = idx;
  const item = carrito[idx];
  document.getElementById('mpv-nombre-producto').textContent = item.nombre;
  const b1 = document.getElementById('mpv-btn-precio1');
  b1.textContent=`Precio 1 — normal: ${fmt(item.pventa1)}`; b1.className='btn-secundario';
  const b2 = document.getElementById('mpv-btn-precio2');
  b2.textContent = item.pventa2?`Precio 2 — especial: ${fmt(item.pventa2)}`:'Precio 2 — no definido';
  b2.disabled = !item.pventa2; b2.className='btn-secundario';
  document.getElementById('mpv-precio-custom').value='';
  abrirModal('modal-precio');
  setTimeout(() => document.getElementById('mpv-btn-precio1').focus(), 100);
}

function seleccionarPrecio(n) {
  const item = carrito[carritoItemEditando];
  item.precio = n===1?item.pventa1:item.pventa2;
  item.total  = item.cantidad*item.precio;
  cerrarModal('modal-precio'); renderCarrito();
}

function aplicarPrecioCustom() {
  const v = parseFloat(document.getElementById('mpv-precio-custom').value);
  if (!v||v<0) { alert('Ingresa un precio válido'); return; }
  const item = carrito[carritoItemEditando];
  item.precio=v; item.total=item.cantidad*v;
  cerrarModal('modal-precio'); renderCarrito();
}

async function confirmarVenta() {
  if (carrito.length===0) return;
  const ahora=new Date();
  const fecha=fechaCO(ahora);
  const hora=horaCO(ahora);
  const total=carrito.reduce((a,i)=>a+i.total,0);
  const ganancia=carrito.reduce((a,i)=>a+(i.precio-i.pcompra)*i.cantidad,0);
  const nota=document.getElementById('venta-nota').value.trim();
  const metodoPago=document.querySelector('input[name="metodo-pago"]:checked').value;

  for (const item of carrito) {
    const p = DB.productos.find(x=>x.id===item.id);
    if (p) {
      p.stock=Math.max(0,p.stock-item.cantidad);
      const idx=DB.productos.findIndex(x=>x.id===item.id);
      await sheetsEscribir('update','Productos',[p.id,p.ref,p.nombre,p.pcompra,p.pventa1,p.pventa2,p.stock],idx+2);
    }
  }

  const venta={
    id:uid(),fecha,hora,total,ganancia,nota,metodoPago,items:carrito.map(i=>({...i})),
    clienteId: clienteVenta?clienteVenta.id:'', clienteNombre: clienteVenta?clienteVenta.nombre:'',
    clienteCedula: clienteVenta?clienteVenta.cedula:'', clienteTelefono: clienteVenta?clienteVenta.telefono:'',
    clienteDireccion: clienteVenta?clienteVenta.direccion:''
  };
  DB.ventas.push(venta);
  await sheetsEscribir('append','Ventas',[venta.id,venta.fecha,venta.hora,venta.total,venta.ganancia,venta.nota,venta.metodoPago,JSON.stringify(venta.items),venta.clienteId,venta.clienteNombre,venta.clienteCedula,venta.clienteTelefono,venta.clienteDireccion,'','']);

  guardarLocal();
  mostrarToast(`Venta registrada · ${metodoPago==='transferencia'?'🏦':'💵'} ${fmt(total)}. Tócala en "Ventas de hoy" para imprimir el boucher.`);

  carrito=[];
  renderCarrito();
  quitarClienteVenta();
  document.getElementById('venta-cliente-buscar').value='';
  document.getElementById('venta-cliente-resultados').innerHTML='';
  document.getElementById('venta-search').value='';
  document.getElementById('venta-resultados').innerHTML='';
  resultadosVenta=[];
  document.getElementById('venta-nota').value='';
  document.querySelector('input[name="metodo-pago"][value="efectivo"]').checked=true;
  setTimeout(()=>document.getElementById('venta-search').focus(),150);
}

// =============================================
// HISTORIAL
// =============================================
function renderHistorial() {
  const fechaISO=document.getElementById('hist-fecha').value;
  const fecha=isoAFechaCO(fechaISO);
  const ventas=DB.ventas.filter(v=>v.fecha===fecha).slice().reverse();
  const summary=document.getElementById('hist-summary');
  const cont=document.getElementById('hist-contenido');

  if (ventas.length===0) {
    summary.innerHTML='';
    cont.innerHTML=`<div class="estado-vacio"><i class="ti ti-history"></i><p>Sin ventas en esta fecha</p></div>`;
    return;
  }

  const totalDia=ventas.reduce((a,v)=>a+v.total,0);
  const efectivo=ventas.filter(v=>v.metodoPago!=='transferencia').reduce((a,v)=>a+v.total,0);
  const transferencia=ventas.filter(v=>v.metodoPago==='transferencia').reduce((a,v)=>a+v.total,0);

  summary.innerHTML=`<div id="dash-metrics" style="margin-bottom:1rem">
    <div class="metric rosa" style="display:inline-block;margin-right:12px;margin-bottom:8px;min-width:160px"><div class="mlabel">Total vendido</div><div class="mvalue">${fmt(totalDia)}</div></div>
    <div class="metric" style="display:inline-block;margin-right:12px;margin-bottom:8px;min-width:140px"><div class="mlabel">💵 Efectivo</div><div class="mvalue">${fmt(efectivo)}</div></div>
    <div class="metric" style="display:inline-block;margin-bottom:8px;min-width:160px"><div class="mlabel">🏦 Transferencia</div><div class="mvalue">${fmt(transferencia)}</div></div>
  </div>`;

  const filas=ventas.map(v=>`
    <tr>
      <td>${v.hora}</td>
      <td style="font-size:13px">${(v.items||[]).map(i=>esc(i.nombre)+' x'+i.cantidad).join('<br>')}</td>
      <td style="font-size:13px;color:var(--texto2)">${v.nota||'-'}</td>
      <td><span class="badge ${v.metodoPago==='transferencia'?'rosa':'verde'}">${v.metodoPago==='transferencia'?'🏦 Transferencia':'💵 Efectivo'}</span></td>
      <td style="font-weight:500">${fmt(v.total)}</td>
      <td style="color:var(--dorado-oscuro);font-weight:500">${fmt(v.ganancia)}</td>
      <td><div style="display:flex;gap:6px">
        <button class="btn-secundario btn-ver-factura" data-id="${v.id}" style="padding:5px 9px"><i class="ti ti-receipt"></i></button>
        <button class="btn-peligro btn-eliminar-venta" data-id="${v.id}" style="padding:5px 9px"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`).join('');

  cont.innerHTML=`<div class="tabla-wrap"><table>
    <thead><tr><th>Hora</th><th>Productos</th><th>Nota</th><th>Pago</th><th>Total</th><th>Ganancia</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-ver-factura').forEach(b=>b.addEventListener('click',()=>{
    const v=DB.ventas.find(x=>x.id===b.dataset.id); if(v) abrirFactura(v);
  }));
  cont.querySelectorAll('.btn-eliminar-venta').forEach(b=>b.addEventListener('click',()=>eliminarVenta(b.dataset.id)));
}

async function eliminarVenta(id) {
  if (!confirm('¿Eliminar esta venta? El stock no se restaura.')) return;
  DB.ventas=DB.ventas.filter(v=>v.id!==id);
  guardarLocal();
  await sheetsEscribir('clear','Ventas',null,null);
  await sheetsEscribir('append','Ventas',['ID','Fecha','Hora','Total','Ganancia','Nota','MetodoPago','Items','ClienteId','ClienteNombre','ClienteCedula','ClienteTelefono','ClienteDireccion','PagadoAhora','SaldoPendiente']);
  for (const v of DB.ventas)
    await sheetsEscribir('append','Ventas',[v.id,v.fecha,v.hora,v.total,v.ganancia,v.nota,v.metodoPago,JSON.stringify(v.items),v.clienteId||'',v.clienteNombre||'',v.clienteCedula||'',v.clienteTelefono||'',v.clienteDireccion||'',v.pagadoAhora!==undefined?v.pagadoAhora:'',v.saldoPendiente!==undefined?v.saldoPendiente:'']);
  renderHistorial(); renderDashboard(); mostrarToast('Venta eliminada');
}

// =============================================
// REPORTES — PUNTO 2
// =============================================
function getRangoPeriodo(periodo) {
  const hoy = new Date();
  let desde, hasta;

  if (periodo === 'dia') {
    desde = new Date(hoy); desde.setHours(0,0,0,0);
    hasta = new Date(hoy); hasta.setHours(23,59,59,999);
  } else if (periodo === 'semana') {
    // Lunes de esta semana
    const dia = hoy.getDay();
    const diff = dia === 0 ? -6 : 1 - dia;
    desde = new Date(hoy); desde.setDate(hoy.getDate() + diff); desde.setHours(0,0,0,0);
    hasta = new Date(hoy); hasta.setHours(23,59,59,999);
  } else if (periodo === 'mes') {
    desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    hasta = new Date(hoy); hasta.setHours(23,59,59,999);
  } else {
    desde = new Date(hoy.getFullYear(), 0, 1);
    hasta = new Date(hoy); hasta.setHours(23,59,59,999);
  }

  return { desde, hasta };
}

function renderReportes(periodo) {
  periodoreporte = periodo;

  // Actualizar botones activos
  document.querySelectorAll('.btn-reporte').forEach(b => {
    b.classList.toggle('active', b.dataset.periodo === periodo);
  });

  const { desde, hasta } = getRangoPeriodo(periodo);
  const ventas = DB.ventas.filter(v => {
    const d = parseFechaCO(v.fecha);
    return d >= desde && d <= hasta;
  });

  const totalVendido   = ventas.reduce((a,v)=>a+v.total,0);
  const totalGanancia  = ventas.reduce((a,v)=>a+v.ganancia,0);
  const totalEfectivo  = ventas.filter(v=>v.metodoPago!=='transferencia').reduce((a,v)=>a+v.total,0);
  const totalTransf    = ventas.filter(v=>v.metodoPago==='transferencia').reduce((a,v)=>a+v.total,0);
  const ganEfectivo    = ventas.filter(v=>v.metodoPago!=='transferencia').reduce((a,v)=>a+v.ganancia,0);
  const ganTransf      = ventas.filter(v=>v.metodoPago==='transferencia').reduce((a,v)=>a+v.ganancia,0);

  const labels = { dia:'hoy', semana:'esta semana', mes:'este mes', año:'este año' };

  // Métricas principales — solo ventas, sin mezclar gastos
  document.getElementById('reporte-metrics').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:1.5rem">
      <div class="metric rosa"><div class="mlabel">Total vendido ${labels[periodo]}</div><div class="mvalue">${fmt(totalVendido)}</div></div>
      <div class="metric dorado"><div class="mlabel">Ganancia ${labels[periodo]}</div><div class="mvalue">${fmt(totalGanancia)}</div></div>
      <div class="metric"><div class="mlabel">Transacciones</div><div class="mvalue">${ventas.length}</div></div>
    </div>`;

  // Desglose por método de pago — ventas
  document.getElementById('reporte-pago').innerHTML = `
    <div class="reporte-pago-card">
      <span class="rp-icon">💵</span>
      <div class="rp-label">Ventas en Efectivo</div>
      <div class="rp-value">${fmt(totalEfectivo)}</div>
      <div class="rp-sub">Ganancia: ${fmt(ganEfectivo)}</div>
    </div>
    <div class="reporte-pago-card">
      <span class="rp-icon">🏦</span>
      <div class="rp-label">Ventas por Transferencia</div>
      <div class="rp-value">${fmt(totalTransf)}</div>
      <div class="rp-sub">Ganancia: ${fmt(ganTransf)}</div>
    </div>
    <div class="reporte-pago-card" style="border:0.5px solid var(--rosa-medio)">
      <span class="rp-icon">📊</span>
      <div class="rp-label">Total combinado</div>
      <div class="rp-value">${fmt(totalVendido)}</div>
      <div class="rp-sub">Ganancia total: ${fmt(totalGanancia)}</div>
    </div>`;

  // Resumen neto del mes: siempre el mes actual, independiente del periodo elegido arriba
  renderResumenNetoMes();
}

// Resumen neto del mes actual: ganancia de ventas menos gastos, y ventas menos pagos a proveedores.
// Siempre calculado para el mes en curso (se "reinicia" solo porque nunca acumula meses anteriores).
function renderResumenNetoMes() {
  const hoy = new Date();
  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const finMes = new Date(hoy.getFullYear(), hoy.getMonth()+1, 0, 23,59,59,999);

  const ventasMes = DB.ventas.filter(v => { const d = parseFechaCO(v.fecha); return d>=inicioMes && d<=finMes; });
  const gastosMes = DB.gastos.filter(g => { const d = parseFechaCO(g.fecha); return d>=inicioMes && d<=finMes; });

  const totalVendidoMes = ventasMes.reduce((a,v)=>a+v.total,0);
  const gananciaMes     = ventasMes.reduce((a,v)=>a+v.ganancia,0);
  const totalGastosMes  = gastosMes.reduce((a,g)=>a+g.monto,0);
  const gananciaNetaMes = gananciaMes - totalGastosMes;

  const ganEfectivoMes    = ventasMes.filter(v=>v.metodoPago!=='transferencia').reduce((a,v)=>a+v.ganancia,0);
  const ganTransfMes      = ventasMes.filter(v=>v.metodoPago==='transferencia').reduce((a,v)=>a+v.ganancia,0);
  const gastosEfectivoMes = gastosMes.filter(g=>g.metodoPago!=='transferencia').reduce((a,g)=>a+g.monto,0);
  const gastosTransfMes   = gastosMes.filter(g=>g.metodoPago==='transferencia').reduce((a,g)=>a+g.monto,0);
  const netoEfectivo      = ganEfectivoMes - gastosEfectivoMes;
  const netoTransferencia = ganTransfMes - gastosTransfMes;

  const pagosProveedoresMes = DB.proveedores.flatMap(p => p.abonos||[])
    .filter(a => { const d = parseFechaCO(a.fecha); return d>=inicioMes && d<=finMes; })
    .reduce((s,a)=>s+a.monto,0);
  const ventasNetasMes = totalVendidoMes - pagosProveedoresMes;

  document.getElementById('resumen-neto-metrics').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
      <div class="metric dorado"><div class="mlabel">Ganancia del mes</div><div class="mvalue">${fmt(gananciaMes)}</div></div>
      <div class="metric danger"><div class="mlabel">Gastos del mes</div><div class="mvalue">${fmt(totalGastosMes)}</div></div>
      <div class="metric dorado"><div class="mlabel">Ganancia neta del mes</div><div class="mvalue">${fmt(gananciaNetaMes)}</div></div>
      <div class="metric"><div class="mlabel">Ventas del mes</div><div class="mvalue">${fmt(totalVendidoMes)}</div></div>
      <div class="metric danger"><div class="mlabel">Pagos a proveedores (mes)</div><div class="mvalue">${fmt(pagosProveedoresMes)}</div></div>
      <div class="metric"><div class="mlabel">Ventas netas del mes</div><div class="mvalue">${fmt(ventasNetasMes)}</div></div>
    </div>`;

  document.getElementById('resumen-neto-pago').innerHTML = `
    <div class="reporte-pago-card">
      <span class="rp-icon">💵</span>
      <div class="rp-label">Neto en Efectivo</div>
      <div class="rp-value">${fmt(netoEfectivo)}</div>
      <div class="rp-sub">Ganancia ${fmt(ganEfectivoMes)} − Gastos ${fmt(gastosEfectivoMes)}</div>
    </div>
    <div class="reporte-pago-card">
      <span class="rp-icon">🏦</span>
      <div class="rp-label">Neto en Transferencia</div>
      <div class="rp-value">${fmt(netoTransferencia)}</div>
      <div class="rp-sub">Ganancia ${fmt(ganTransfMes)} − Gastos ${fmt(gastosTransfMes)}</div>
    </div>`;
}

// =============================================
// CONFIGURACIÓN
// =============================================
function renderConfig() {
  document.getElementById('conf-stock-min').value = DB.config.stockMin;
  const lista = document.getElementById('usuarios-list');
  lista.innerHTML = DB.usuarios.map((u,i)=>`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:var(--blush-claro);border-radius:8px;margin-bottom:6px;border:0.5px solid var(--borde)">
      <div><span style="font-weight:500">${esc(u.user)}</span>
      <span class="badge ${u.rol==='admin'?'rosa':'ok'}" style="margin-left:8px">${u.rol}</span></div>
      ${DB.usuarios.length>1?`<button class="btn-peligro btn-eliminar-usuario" data-idx="${i}" style="padding:5px 9px"><i class="ti ti-trash"></i></button>`:''}
    </div>`).join('');
  lista.querySelectorAll('.btn-eliminar-usuario').forEach(b=>b.addEventListener('click',()=>eliminarUsuario(parseInt(b.dataset.idx))));
}

async function agregarUsuario() {
  const user=document.getElementById('nu-user').value.trim();
  const pass=document.getElementById('nu-pass').value;
  const rol=document.getElementById('nu-rol').value;
  if (!user||!pass) { alert('Completa usuario y contraseña'); return; }
  if (DB.usuarios.find(u=>u.user===user)) { alert('Ese usuario ya existe'); return; }
  DB.usuarios.push({user,pass,rol}); guardarLocal();
  await sheetsEscribir('append','Usuarios',[user,pass,rol]);
  document.getElementById('nu-user').value=''; document.getElementById('nu-pass').value='';
  renderConfig(); mostrarToast('Usuario agregado ✓');
}

function eliminarUsuario(idx) {
  if (!confirm('¿Eliminar este usuario?')) return;
  DB.usuarios.splice(idx,1); guardarLocal(); renderConfig(); mostrarToast('Usuario eliminado');
}

async function guardarConfig() {
  DB.config.stockMin=parseInt(document.getElementById('conf-stock-min').value)||5;
  guardarLocal();
  await guardarConfigSheet();
  mostrarToast('Configuración guardada ✓');
}

// =============================================
// NAVEGACIÓN CON TECLADO
// =============================================
// Permite moverse con ↑/↓ entre botones/campos de un contenedor (Enter ya activa el botón enfocado)
function habilitarNavegacionFlechas(contenedorId) {
  const contenedor = document.getElementById(contenedorId);
  contenedor.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const focusables = Array.from(contenedor.querySelectorAll('button:not([disabled]), input'))
      .filter(el => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const idx = focusables.indexOf(document.activeElement);
    e.preventDefault();
    if (idx === -1) { focusables[0].focus(); return; }
    const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
    focusables[Math.max(0, Math.min(focusables.length - 1, next))].focus();
  });
}

// Enter avanza al siguiente campo del formulario; en el último, ejecuta onFinal
function habilitarEnterAvanza(ids, onFinal) {
  ids.forEach((id, i) => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const siguiente = ids[i+1];
      if (siguiente) document.getElementById(siguiente).focus();
      else onFinal();
    });
  });
}

// =============================================
// EVENTOS
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  cargarLocal();
  if (DB.usuarios.length===0) DB.usuarios=[{user:'admin',pass:'Soloagro2812',rol:'admin'}];
  if (DB.config.trasladoContador === undefined) DB.config.trasladoContador = 0;
  if (!DB.clientes) DB.clientes = [];
  if (!DB.deudores) DB.deudores = [];
  if (!DB.anticipos) DB.anticipos = [];
  if (!DB.proveedores) DB.proveedores = [];
  if (!DB.gastos) DB.gastos = [];
  if (!DB.traslados) DB.traslados = [];

  // Sesión persistente
  const sesionGuardada = cargarSesion();
  if (sesionGuardada) {
    const valido = DB.usuarios.find(u=>u.user===sesionGuardada.user&&u.pass===sesionGuardada.pass);
    if (valido) { sesion=valido; entrarAlApp(); sincronizar(VENTAS_DIAS_SYNC_LIGERO); }
  }

  // Login
  document.getElementById('btn-login').addEventListener('click', doLogin);
  document.getElementById('login-pass').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });

  // Logout
  document.getElementById('btn-logout').addEventListener('click', doLogout);

  // Navegación
  document.querySelectorAll('.nav-tab').forEach(t=>t.addEventListener('click',()=>mostrarPanel(t.dataset.tab)));
  document.querySelector('[data-goto="ventas"]').addEventListener('click',()=>mostrarPanel('ventas'));

  // Menú lateral (móvil)
  document.getElementById('btn-menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('abierto');
    document.getElementById('sidebar-backdrop').classList.toggle('visible');
  });
  document.getElementById('sidebar-backdrop').addEventListener('click', cerrarSidebarMovil);

  // Cerrar modales
  document.querySelectorAll('.btn-cerrar-modal').forEach(b=>b.addEventListener('click',()=>cerrarModal(b.dataset.modal)));
  document.querySelectorAll('.modal-bg').forEach(bg=>bg.addEventListener('click',e=>{ if(e.target===bg) bg.classList.add('hidden'); }));

  // Inventario
  document.getElementById('btn-abrir-modal-producto').addEventListener('click',()=>abrirModalProducto(null));
  document.getElementById('btn-guardar-producto').addEventListener('click', guardarProducto);
  document.getElementById('inv-search').addEventListener('input', () => { inventarioMostrar = 10; renderInventario(); });
  habilitarEnterAvanza(['prod-ref','prod-nombre','prod-pcompra','prod-pventa1','prod-pventa2','prod-stock'], guardarProducto);

  // Factura / boucher
  document.getElementById('btn-imprimir-boucher').addEventListener('click', () => {
    if (facturaVentaActual) imprimirBoucher(facturaVentaActual);
  });

  // PIN
  document.getElementById('btn-verificar-pin').addEventListener('click', verificarPin);
  document.getElementById('pin-input').addEventListener('keydown',e=>{ if(e.key==='Enter') verificarPin(); });

  // Clave de secciones privadas
  document.getElementById('btn-verificar-clave-panel').addEventListener('click', verificarClavePanel);
  document.getElementById('clave-panel-input').addEventListener('keydown', e=>{ if(e.key==='Enter') verificarClavePanel(); });

  // Ventas — búsqueda con flechas y Enter
  const ventaSearch = document.getElementById('venta-search');
  ventaSearch.addEventListener('input', buscarProductoVenta);
  ventaSearch.addEventListener('keydown', e => {
    if (resultadosVenta.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      indiceVenta = Math.min(indiceVenta + 1, resultadosVenta.length - 1);
      renderResultadosVenta();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      indiceVenta = Math.max(indiceVenta - 1, 0);
      renderResultadosVenta();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = resultadosVenta[indiceVenta];
      if (p) abrirFlujRapido(p.id);
    }
  });

  document.getElementById('btn-limpiar-carrito').addEventListener('click',()=>{ carrito=[]; renderCarrito(); });
  document.getElementById('btn-confirmar-venta').addEventListener('click', confirmarVenta);

  // Modal precio (carrito)
  document.getElementById('mpv-btn-precio1').addEventListener('click',()=>seleccionarPrecio(1));
  document.getElementById('mpv-btn-precio2').addEventListener('click',()=>seleccionarPrecio(2));
  document.getElementById('btn-aplicar-precio').addEventListener('click', aplicarPrecioCustom);
  habilitarNavegacionFlechas('modal-precio');
  habilitarNavegacionFlechas('modal-rapido');

  // Flujo rápido — cantidad
  document.getElementById('btn-rapido-siguiente').addEventListener('click', rapidoMostrarPrecio);
  document.getElementById('rapido-cantidad').addEventListener('keydown', e=>{ if(e.key==='Enter') rapidoMostrarPrecio(); });

  // Flujo rápido — precio
  document.getElementById('rapido-btn-p1').addEventListener('click',()=>{
    rapidoAgregarConPrecio(rapidoProductoActual.pventa1);
  });
  document.getElementById('rapido-btn-p2').addEventListener('click',()=>{
    rapidoAgregarConPrecio(rapidoProductoActual.pventa2);
  });
  document.getElementById('rapido-btn-custom').addEventListener('click',()=>{
    const v = parseFloat(document.getElementById('rapido-precio-custom').value);
    if (!v||v<0) { alert('Ingresa un precio válido'); return; }
    rapidoAgregarConPrecio(v);
  });
  document.getElementById('rapido-precio-custom').addEventListener('keydown',e=>{
    if (e.key==='Enter') {
      const v=parseFloat(document.getElementById('rapido-precio-custom').value);
      if (v&&v>0) rapidoAgregarConPrecio(v);
    }
  });

  // Traslado — búsqueda con flechas y Enter
  const trasladoSearch = document.getElementById('traslado-search');
  trasladoSearch.addEventListener('input', buscarProductoTraslado);
  trasladoSearch.addEventListener('keydown', e => {
    if (resultadosTraslado.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      indiceTraslado = Math.min(indiceTraslado + 1, resultadosTraslado.length - 1);
      renderResultadosTraslado();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      indiceTraslado = Math.max(indiceTraslado - 1, 0);
      renderResultadosTraslado();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = resultadosTraslado[indiceTraslado];
      if (p) agregarATraslado(p.id);
    }
  });
  document.getElementById('btn-limpiar-traslado').addEventListener('click', () => {
    if (traslado.length===0) return;
    if (!confirm('¿Vaciar la lista de traslado?')) return;
    traslado = []; renderTraslado();
  });
  document.getElementById('btn-imprimir-traslado').addEventListener('click', imprimirTraslado);
  document.getElementById('btn-ct-agregar').addEventListener('click', confirmarCantidadTraslado);
  document.getElementById('ct-cantidad').addEventListener('keydown', e => { if (e.key==='Enter') confirmarCantidadTraslado(); });

  // Clientes
  inicializarBuscadorCliente('venta', 'venta-cliente-buscar', 'venta-cliente-resultados', seleccionarClienteVenta);
  document.getElementById('btn-nuevo-cliente-venta').addEventListener('click', () => abrirModalNuevoCliente('venta'));
  document.getElementById('btn-quitar-cliente-venta').addEventListener('click', quitarClienteVenta);
  document.getElementById('btn-guardar-cliente').addEventListener('click', guardarCliente);

  // Deudores
  inicializarBuscadorCliente('deudor', 'deudor-cliente-buscar', 'deudor-cliente-resultados', seleccionarClienteDeudor);
  document.getElementById('btn-nuevo-cliente-deudor').addEventListener('click', () => abrirModalNuevoCliente('deudor'));
  document.getElementById('btn-quitar-cliente-deudor').addEventListener('click', quitarClienteDeudor);
  inicializarBuscadorProducto('deudor', 'deudor-producto-buscar', 'deudor-producto-resultados', agregarProductoDeudor);
  document.getElementById('btn-abrir-modal-deudor').addEventListener('click', () => abrirModalDeudor(null));
  document.getElementById('btn-guardar-deudor').addEventListener('click', guardarDeudor);
  document.getElementById('btn-guardar-abono').addEventListener('click', guardarAbono);
  document.getElementById('abono-monto').addEventListener('keydown', e => { if (e.key==='Enter') guardarAbono(); });

  // Anticipos
  inicializarBuscadorCliente('anticipo', 'anticipo-cliente-buscar', 'anticipo-cliente-resultados', seleccionarClienteAnticipo);
  document.getElementById('btn-nuevo-cliente-anticipo').addEventListener('click', () => abrirModalNuevoCliente('anticipo'));
  document.getElementById('btn-quitar-cliente-anticipo').addEventListener('click', quitarClienteAnticipo);
  inicializarBuscadorProducto('anticipo', 'anticipo-producto-buscar', 'anticipo-producto-resultados', agregarProductoAnticipo);
  document.getElementById('btn-abrir-modal-anticipo').addEventListener('click', () => abrirModalAnticipo(null));
  document.getElementById('btn-guardar-anticipo').addEventListener('click', guardarAnticipo);

  // Proveedores
  document.getElementById('btn-abrir-modal-proveedor').addEventListener('click', abrirModalProveedor);
  document.getElementById('btn-guardar-proveedor').addEventListener('click', guardarProveedor);
  document.getElementById('btn-guardar-abono-proveedor').addEventListener('click', guardarAbonoProveedor);
  document.getElementById('abono-proveedor-monto').addEventListener('keydown', e => { if (e.key==='Enter') guardarAbonoProveedor(); });

  // Gastos
  document.getElementById('btn-abrir-modal-gasto').addEventListener('click', abrirModalGasto);
  document.getElementById('btn-guardar-gasto').addEventListener('click', guardarGasto);
  document.querySelectorAll('.gasto-cat-btn').forEach(b =>
    b.addEventListener('click', () => seleccionarCategoriaGasto(b.dataset.cat, b)));

  // Historial
  document.getElementById('hist-fecha').addEventListener('change', renderHistorial);

  // Reportes
  document.querySelectorAll('.btn-reporte').forEach(b=>
    b.addEventListener('click',()=> renderReportes(b.dataset.periodo)));

  // Config
  document.getElementById('btn-agregar-usuario').addEventListener('click', agregarUsuario);
  document.getElementById('btn-guardar-config').addEventListener('click', guardarConfig);
});