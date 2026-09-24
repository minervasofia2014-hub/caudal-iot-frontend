// ============================================================================
//  App.jsx  —  COMPONENTE PRINCIPAL DEL PANEL DE MONITOREO HIDRÁULICO IoT
// ----------------------------------------------------------------------------
//  Aquí vive toda la aplicación web del acueducto veredal:
//    · Autenticación (ingreso, registro, recuperar y cambiar contraseña)
//    · Dashboard en tiempo real (gráficas por sensor y balance hídrico)
//    · Control de electroválvulas (actuadores)
//    · Historial de caudal y de reinicios
//    · Administración de usuarios (solo para el administrador)
//  El componente se comunica con el backend (Node/Express) por medio de la
//  API REST usando la librería axios.
// ============================================================================

// Hooks de React:
//   useEffect -> ejecuta código como reacción a cambios (efectos secundarios)
//   useMemo   -> memoriza un valor para no recalcularlo en cada render
//   useState  -> declara una variable de estado (dato que, al cambiar, redibuja)
import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'                    // cliente HTTP para hablar con la API REST
import MapaUbicacion from './MapaUbicacion'  // componente del mapa (Leaflet)
import './App.css'                           // estilos propios de esta pantalla

// --- CONSTANTES DE CONFIGURACIÓN --------------------------------------------

// Dirección del backend. En producción la toma de la variable de entorno
// VITE_API_URL (configurada en Render); si no existe, usa el servidor local.
const URL_BACKEND = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// Cada cuántos milisegundos se vuelve a pedir el dashboard (3 s = casi vivo).
const INTERVALO_REFRESCO = 3000

// Nombre de la "gaveta" en el navegador (localStorage) donde se guarda la
// credencial de sesión, para que al recargar la página el usuario siga dentro.
const LLAVE_TOKEN = 'caudal_auth_token'

// Traducción de los códigos de estado que envía el backend a texto legible.
const TEXTOS_ESTADO = {
    seco: 'Seco',
    normal: 'Normal',
    exceso: 'Exceso',
    error: 'Error',
    desconectado: 'Desconectado',
}

// --- FUNCIONES AUXILIARES (helpers) -----------------------------------------

// Convierte una fecha cruda (ISO del backend) a un formato colombiano legible.
function formatearFecha(valor) {
    if (!valor) return 'Sin dato'
    const fecha = new Date(valor)
    // Si la fecha no es válida (por ejemplo "Sin hora" del ESP32 antes de
    // sincronizar el reloj), no reventar: devolvemos un texto seguro.
    if (isNaN(fecha.getTime())) return 'Sin dato'
    return new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'medium' }).format(fecha)
}

// Convierte cualquier valor a número de forma segura. Si no es un número
// válido devuelve 0, para que las gráficas y cálculos nunca fallen.
function valorNumerico(valor) {
    const numero = Number(valor)
    return Number.isFinite(numero) ? numero : 0
}

// ============================================================================
//  COMPONENTE: GraficaLinea
//  Dibuja una mini-gráfica de líneas (SVG hecho a mano, sin librerías) con la
//  serie de caudal de un sensor. Recibe los datos, el color y una etiqueta.
// ============================================================================
function GraficaLinea({ data, color = '#176b87', label }) {
    const ancho = 600, alto = 160, margen = 20
    // Valor máximo de la serie (mínimo 1) para escalar la altura de la línea.
    const maximo = Math.max(...data.map((d) => d.value), 1)
    // Convierte cada dato en una coordenada "x,y" dentro del lienzo SVG.
    const puntos = data.map((d, i) => {
        const x = margen + (i * (ancho - margen * 2)) / Math.max(data.length - 1, 1)
        const y = alto - margen - (d.value / maximo) * (alto - margen * 2)
        return `${x},${y}`
    })
    return (
        <div className="sparkline-wrap">
            {label && <p className="sparkline-label">{label}</p>}
            <svg className="chart" viewBox={`0 0 ${ancho} ${alto}`} role="img">
                {/* Ejes X e Y de la gráfica */}
                <line x1={margen} x2={ancho - margen} y1={alto - margen} y2={alto - margen} stroke="#ccc" strokeWidth="1" />
                <line x1={margen} x2={margen} y1={margen} y2={alto - margen} stroke="#ccc" strokeWidth="1" />
                {/* Con 2 o más datos dibujamos la línea y los puntos */}
                {data.length > 1 && (
                    <>
                        <polyline fill="none" points={puntos.join(' ')} stroke={color} strokeWidth="3" strokeLinejoin="round" />
                        {puntos.map((punto, i) => { const [cx, cy] = punto.split(','); return <circle cx={cx} cy={cy} fill={color} key={i} r="4" /> })}
                    </>
                )}
                {data.length <= 1 && (
                    <>
                        {/* Sin datos (recién reiniciado): línea plana en 0 en la base */}
                        <line x1={margen} x2={ancho - margen} y1={alto - margen} y2={alto - margen} stroke={color} strokeWidth="3" />
                        <text x={margen + 4} y={alto - margen - 6} fill="#aaa" fontSize="12">0</text>
                    </>
                )}
            </svg>
        </div>
    )
}

// ============================================================================
//  COMPONENTE: BarraBalance
//  Muestra el BALANCE HÍDRICO: compara el agua que entra (bocatoma) con la que
//  sale por los dos ramales, calcula la pérdida y decide si hay posible fuga.
// ============================================================================
function BarraBalance({ entrada, salida1, salida2, balance }) {
    // Si el backend ya manda el balance por ventana (volumen real acumulado), lo usamos.
    // Si no (backend viejo), caemos al caudal instantáneo como respaldo.
    const usaVentana = balance && balance.entrada_prom != null
    const ent = usaVentana ? valorNumerico(balance.entrada_prom) : valorNumerico(entrada)
    const sal1 = usaVentana ? valorNumerico(balance.salida1_prom) : valorNumerico(salida1)
    const sal2 = usaVentana ? valorNumerico(balance.salida2_prom) : valorNumerico(salida2)

    // Pérdida = lo que entró menos lo que salió (nunca negativa).
    const totalSalida = sal1 + sal2
    const perdida = Math.max(0, ent - totalSalida)

    // Umbral de fuga más realista: la pérdida debe ser significativa en PORCENTAJE
    // (>15% de la entrada) y además superar un piso absoluto, para no marcar fuga por
    // el ruido normal de sensores que trabajan cerca de su límite inferior.
    const TOLERANCIA_PCT = 0.15
    const PISO_MLMIN = 40
    const hayFuga = ent > 0 && perdida > ent * TOLERANCIA_PCT && perdida > PISO_MLMIN

    // Eficiencia = porcentaje del agua de entrada que efectivamente llegó a los ramales.
    const eficiencia = ent > 0 ? Math.min(100, (totalSalida / ent) * 100).toFixed(1) : 100
    const desc = usaVentana
        ? `Promedio de los últimos ${balance.ventana_min} min · calculado con el volumen real (total_mL) de cada sensor`
        : 'Comparación entre el agua que salió del tanque y la que llegó a los ramales'
    return (
        <div className="balance-section">
            <h2 className="balance-title">Balance Hídrico</h2>
            <p className="balance-desc">{desc}</p>
            {/* Fórmula visual: Entrada = Ramal1 + Ramal2 (+ Pérdida si la hay) */}
            <div className="balance-formula">
                <div className="balance-box entrada"><span className="balance-icon">💧</span><strong>{ent.toFixed(1)}</strong><small>mL/min entrada<br />(Sensor 1 · Bocatoma)</small></div>
                <div className="balance-equals">=</div>
                <div className="balance-box salida"><span className="balance-icon">🔵</span><strong>{sal1.toFixed(1)}</strong><small>mL/min<br />(Sensor 2 · Ramal 1)</small></div>
                <div className="balance-plus">+</div>
                <div className="balance-box salida"><span className="balance-icon">🔵</span><strong>{sal2.toFixed(1)}</strong><small>mL/min<br />(Sensor 3 · Ramal 2)</small></div>
                {hayFuga && (<><div className="balance-plus">+</div><div className="balance-box fuga"><span className="balance-icon">⚠️</span><strong>{perdida.toFixed(1)}</strong><small>mL/min<br />Pérdida detectada</small></div></>)}
            </div>
            {/* Barra proporcional: cada segmento ocupa el % del caudal de entrada */}
            <div className="balance-bar-wrap">
                <div className="balance-bar">
                    {ent > 0 && (<>
                        <div className="balance-bar-seg ramal1" style={{ width: `${Math.min(100, (sal1 / ent) * 100)}%` }} title={`Ramal 1: ${sal1.toFixed(1)} mL/min`} />
                        <div className="balance-bar-seg ramal2" style={{ width: `${Math.min(100, (sal2 / ent) * 100)}%` }} title={`Ramal 2: ${sal2.toFixed(1)} mL/min`} />
                        {hayFuga && <div className="balance-bar-seg perdida" style={{ width: `${Math.min(100, (perdida / ent) * 100)}%` }} title={`Pérdida: ${perdida.toFixed(1)} mL/min`} />}
                    </>)}
                </div>
                <div className="balance-bar-legend">
                    <span><span className="dot ramal1-dot" /> Ramal 1</span>
                    <span><span className="dot ramal2-dot" /> Ramal 2</span>
                    {hayFuga && <span><span className="dot perdida-dot" /> Pérdida</span>}
                </div>
            </div>
            {/* Mensaje final: verde si está balanceado, naranja si hay posible fuga */}
            <div className={`balance-status ${hayFuga ? 'fuga' : 'ok'}`}>
                {hayFuga ? `⚠️ Posible fuga — Eficiencia: ${eficiencia}% — Pérdida: ${perdida.toFixed(1)} mL/min` : `✅ Sistema balanceado — Eficiencia: ${eficiencia}%`}
            </div>
        </div>
    )
}

// ============================================================================
//  COMPONENTE: TarjetaSensor
//  Tarjeta individual de un sensor: nombre, caudal actual, mini-gráfica y
//  totales acumulados. Se usa una por cada uno de los 3 sensores.
// ============================================================================
function TarjetaSensor({ titulo, sensorId, ubicacion, color, lecturas }) {
    // Filtra del listado general solo las lecturas de ESTE sensor.
    const datosSensor = lecturas.filter(r => r.sensor_id === sensorId)
    const ultimo = datosSensor[0]                                  // la más reciente
    const caudal = valorNumerico(ultimo?.caudal_entrada)
    // Toma las últimas 20 lecturas y las invierte (viejo -> nuevo) para graficar.
    const serie = datosSensor.slice(0, 20).reverse().map(r => ({ label: formatearFecha(r.fecha), value: valorNumerico(r.caudal_entrada) }))
    return (
        <article className="sensor-card">
            <div className="sensor-card-header" style={{ borderColor: color }}>
                <div><p className="eyebrow" style={{ color }}>{ubicacion}</p><h3>{titulo}</h3></div>
                <div className="sensor-caudal" style={{ color }}><strong>{caudal.toFixed(1)}</strong><small>mL/min</small></div>
            </div>
            <GraficaLinea data={serie} color={color} />
            <div className="sensor-card-footer">
                <span>Total acumulado: <strong>{valorNumerico(ultimo?.total_mL).toFixed(0)} mL</strong></span>
                <span>Última lectura: <strong>{formatearFecha(ultimo?.fecha)}</strong></span>
            </div>
        </article>
    )
}

// ============================================================================
//  COMPONENTE: ChipEstado
//  Pastilla que indica si el comando enviado a una electroválvula ya fue
//  confirmado físicamente por el ESP32 (estado real == estado solicitado).
// ============================================================================
function ChipEstado({ actuador }) {
    if (!actuador) return <span className="actuador-chip actuador-pendiente">Sin datos aún</span>
    // Está sincronizado cuando lo que se pidió coincide con lo que reportó el hardware.
    const sincronizado = actuador.estado_solicitado ? actuador.estado_solicitado === actuador.estado_real : true
    return (
        <span className={`actuador-chip ${sincronizado ? 'actuador-ok' : 'actuador-pendiente'}`}>
            {actuador.estado_real || 'Sin confirmar'}{!sincronizado && ' (aplicando...)'}
        </span>
    )
}

// ============================================================================
//  COMPONENTE: PanelUsuarios  (solo administrador)
//  Tabla para gestionar cuentas: aprobar, activar/desactivar, dar/quitar rol
//  de administrador y asignar ubicación (lat/lng) + punto de la vereda.
// ============================================================================
function PanelUsuarios({ api, cabeceras }) {
    // --- Estados locales del panel ---
    const [usuarios, setUsuarios] = useState([])
    const [cargando, setCargando] = useState(true)
    const [error, setError] = useState('')
    const [ocupado, setOcupado] = useState(null)     // id del usuario que se está guardando
    const [coords, setCoords] = useState({})         // edición de lat/lng por usuario
    const [filtro, setFiltro] = useState('todos')    // todos | activos | inactivos

    // Pide al backend la lista completa de usuarios.
    async function cargarUsuarios() {
        try { const { data } = await api.get('/api/usuarios', { headers: cabeceras }); setUsuarios(data); setError('') }
        catch { setError('No fue posible cargar los usuarios.') }
        finally { setCargando(false) }
    }
    // Se ejecuta una sola vez, al montar el panel.
    useEffect(() => { cargarUsuarios() }, [])

    // valor mostrado en cada casilla: lo que el admin está escribiendo, o lo guardado
    const valorCoord = (u, campo) => {
        if (coords[u._id]?.[campo] !== undefined) return coords[u._id][campo]
        const v = campo === 'lat' ? u.latitud : u.longitud
        return v === null || v === undefined ? '' : v
    }
    // Guarda temporalmente lo que el admin escribe antes de enviarlo.
    const editarCoord = (id, campo, valor) => {
        setCoords((c) => ({ ...c, [id]: { ...c[id], [campo]: valor } }))
    }
    // Envía al backend la ubicación y el sensor asignado a un usuario.
    async function guardarCoords(u) {
        setOcupado(u._id)
        try {
            const latitud = valorCoord(u, 'lat')
            const longitud = valorCoord(u, 'lng')
            const sensor_asociado = coords[u._id]?.sensor !== undefined ? coords[u._id].sensor : (u.sensor_asociado || '')
            await api.put(`/api/usuarios/${u._id}`, { ...u, latitud, longitud, sensor_asociado }, { headers: cabeceras })
            setCoords((c) => { const n = { ...c }; delete n[u._id]; return n })   // limpia el borrador
            await cargarUsuarios()                                                // recarga la tabla
        } catch { alert('No fue posible guardar los datos del usuario') }
        finally { setOcupado(null) }
    }

    // Aprueba una cuenta pendiente.
    async function aprobar(id) {
        setOcupado(id)
        try { await api.patch(`/api/usuarios/${id}/aprobar`, null, { headers: cabeceras }); await cargarUsuarios() }
        catch { alert('No fue posible aprobar el usuario') }
        finally { setOcupado(null) }
    }
    // Alterna el rol de administrador.
    async function cambiarRol(u) {
        setOcupado(u._id)
        try { await api.put(`/api/usuarios/${u._id}`, { ...u, es_administrador: !u.es_administrador }, { headers: cabeceras }); await cargarUsuarios() }
        catch { alert('No fue posible actualizar el usuario') }
        finally { setOcupado(null) }
    }
    // Alterna activo/inactivo (sustituye al antiguo botón "eliminar").
    async function alternarActivo(u) {
        setOcupado(u._id)
        try { await api.put(`/api/usuarios/${u._id}`, { ...u, esta_activo: !u.esta_activo }, { headers: cabeceras }); await cargarUsuarios() }
        catch { alert('No fue posible cambiar el estado del usuario') }
        finally { setOcupado(null) }
    }
    // Conteos para las etiquetas de los botones de filtro.
    const total = usuarios.length
    const nActivos = usuarios.filter(u => u.esta_activo).length
    const nInactivos = total - nActivos
    // Aplica el filtro seleccionado sobre la lista.
    const usuariosFiltrados = usuarios.filter(u =>
        filtro === 'activos' ? u.esta_activo : filtro === 'inactivos' ? !u.esta_activo : true)

    if (cargando) return <p>Cargando usuarios...</p>
    return (
        <section className="panel panel-wide historial-section">
            <div className="panel-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div><p className="eyebrow">Administración</p><h2>Usuarios registrados</h2></div>
                {/* Botones de filtro: Todos / Activos / Inactivos */}
                <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-mini" type="button" onClick={() => setFiltro('todos')} style={filtro === 'todos' ? { background: '#176b87', color: '#fff', borderColor: '#176b87' } : {}}>Todos ({total})</button>
                    <button className="btn-mini" type="button" onClick={() => setFiltro('activos')} style={filtro === 'activos' ? { background: '#2e7d32', color: '#fff', borderColor: '#2e7d32' } : {}}>🟢 Activos ({nActivos})</button>
                    <button className="btn-mini" type="button" onClick={() => setFiltro('inactivos')} style={filtro === 'inactivos' ? { background: '#c62828', color: '#fff', borderColor: '#c62828' } : {}}>🔴 Inactivos ({nInactivos})</button>
                </div>
            </div>
            {error && <div className="alert-banner">{error}</div>}
            <div className="table-wrap">
                <table>
                    <thead><tr><th>Usuario</th><th>Nombre</th><th>Correo</th><th>Estado</th><th>Rol</th><th>Ubicación (lat, lng) y punto</th><th>Acciones</th></tr></thead>
                    <tbody>
                        {/* Una fila por cada usuario que pase el filtro */}
                        {usuariosFiltrados.map((u) => (
                            <tr key={u._id}>
                                <td>{u.usuario}</td>
                                <td>{u.nombre} {u.apellido}</td>
                                <td>{u.correo_electronico}</td>
                                <td><span className={`table-status ${u.esta_activo ? 'status-normal' : 'status-desconectado'}`}>{u.esta_activo ? 'Aprobado' : 'Pendiente'}</span></td>
                                <td>{u.es_administrador ? '👑 Admin' : 'Usuario'}</td>
                                {/* Edición de coordenadas y punto de la vereda */}
                                <td className="admin-actions">
                                    <input type="number" step="any" placeholder="lat" value={valorCoord(u, 'lat')} onChange={(e) => editarCoord(u._id, 'lat', e.target.value)} style={{ width: 90 }} />
                                    <input type="number" step="any" placeholder="lng" value={valorCoord(u, 'lng')} onChange={(e) => editarCoord(u._id, 'lng', e.target.value)} style={{ width: 90 }} />
                                    <select value={coords[u._id]?.sensor !== undefined ? coords[u._id].sensor : (u.sensor_asociado || '')} onChange={(e) => editarCoord(u._id, 'sensor', e.target.value)} style={{ width: 110 }}>
                                        <option value="">— punto —</option>
                                        <option value="sensor_01">Bocatoma</option>
                                        <option value="sensor_02">Ramal 1</option>
                                        <option value="sensor_03">Ramal 2</option>
                                    </select>
                                    <button className="btn-mini" disabled={ocupado === u._id} onClick={() => guardarCoords(u)} type="button">📍 Guardar</button>
                                </td>
                                {/* Acciones: aprobar, activar/desactivar y cambiar rol */}
                                <td className="admin-actions">
                                    {!u.esta_activo && <button className="btn-mini btn-mini-aprobar" disabled={ocupado === u._id} onClick={() => aprobar(u._id)} type="button">Aprobar</button>}
                                    <button className="btn-mini" disabled={ocupado === u._id} onClick={() => alternarActivo(u)} type="button" style={{ background: u.esta_activo ? '#e8f5e9' : '#fdecea', color: u.esta_activo ? '#2e7d32' : '#c62828', borderColor: u.esta_activo ? '#2e7d32' : '#c62828' }}>{u.esta_activo ? '🟢 Activo' : '🔴 Inactivo'}</button>
                                    <button className="btn-mini" disabled={ocupado === u._id} onClick={() => cambiarRol(u)} type="button">{u.es_administrador ? 'Quitar admin' : 'Hacer admin'}</button>
                                </td>
                            </tr>
                        ))}
                        {/* Mensaje cuando el filtro no arroja resultados */}
                        {usuariosFiltrados.length === 0 && <tr><td colSpan="7" style={{ textAlign: 'center', color: '#aaa' }}>Sin usuarios en este filtro</td></tr>}
                    </tbody>
                </table>
            </div>
        </section>
    )
}

// ============================================================================
//  COMPONENTE: HistorialReinicios
//  Dos vistas en una:
//    · "Caudal (promedios)": historial archivado por día/semana/mes y sensor.
//    · "Reinicios": registro de cada vez que se pusieron los contadores en 0.
// ============================================================================
function HistorialReinicios({ api, cabeceras }) {
    const [vista, setVista] = useState('caudal')          // caudal | reinicios
    const [rango, setRango] = useState('semanal')         // semanal | mensual | diario
    const [sensorFiltro, setSensorFiltro] = useState('todos') // todos | sensor_01/02/03
    const [caudal, setCaudal] = useState([])
    const [reinicios, setReinicios] = useState([])

    // historial de caudal (promedios) según el rango elegido.
    // Se recarga solo cada 30 s y también cuando cambia el rango.
    useEffect(() => {
        let vivo = true    // bandera para no actualizar si el componente se desmontó
        async function cargar() {
            try { const { data } = await api.get(`/api/v1/historial/?rango=${rango}`, { headers: cabeceras }); if (vivo) setCaudal(data?.datos || []) }
            catch { if (vivo) setCaudal([]) }
        }
        cargar()
        const id = setInterval(cargar, 30000)
        return () => { vivo = false; clearInterval(id) }   // limpieza al desmontar
    }, [api, cabeceras, rango])

    // historial de reinicios (se recarga cada 30 s).
    useEffect(() => {
        let vivo = true
        async function cargar() {
            try { const { data } = await api.get('/api/v1/reinicios/', { headers: cabeceras }); if (vivo) setReinicios(data?.datos || []) }
            catch { if (vivo) setReinicios([]) }
        }
        cargar()
        const id = setInterval(cargar, 30000)
        return () => { vivo = false; clearInterval(id) }
    }, [api, cabeceras])

    // Traduce el id técnico del sensor a su nombre en la vereda.
    const nombrePunto = (s) => s === 'sensor_01' ? 'Bocatoma' : s === 'sensor_02' ? 'Ramal 1' : s === 'sensor_03' ? 'Ramal 2' : s

    return (
        <div className="panel panel-wide" style={{ marginTop: 16 }}>
            <div className="panel-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div><p className="eyebrow">Historial</p><h2>Registros del sistema</h2></div>
                {/* Cambia entre la vista de caudal y la de reinicios */}
                <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-mini" type="button" onClick={() => setVista('caudal')} style={vista === 'caudal' ? { background: '#176b87', color: '#fff', borderColor: '#176b87' } : {}}>Caudal (promedios)</button>
                    <button className="btn-mini" type="button" onClick={() => setVista('reinicios')} style={vista === 'reinicios' ? { background: '#b8860b', color: '#fff', borderColor: '#b8860b' } : {}}>Reinicios</button>
                </div>
            </div>

            {/* ----- VISTA 1: promedios de caudal ----- */}
            {vista === 'caudal' && (
                <>
                    {/* Filtros de periodo (día/semana/mes) y de sensor */}
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        <button className="btn-mini" type="button" onClick={() => setRango('diario')} style={rango === 'diario' ? { background: '#2a9d8f', color: '#fff', borderColor: '#2a9d8f' } : {}}>Por día</button>
                        <button className="btn-mini" type="button" onClick={() => setRango('semanal')} style={rango === 'semanal' ? { background: '#2a9d8f', color: '#fff', borderColor: '#2a9d8f' } : {}}>Por semana</button>
                        <button className="btn-mini" type="button" onClick={() => setRango('mensual')} style={rango === 'mensual' ? { background: '#2a9d8f', color: '#fff', borderColor: '#2a9d8f' } : {}}>Por mes</button>
                        <span style={{ margin: '0 4px', color: '#ccc' }}>|</span>
                        <button className="btn-mini" type="button" onClick={() => setSensorFiltro('todos')} style={sensorFiltro === 'todos' ? { background: '#176b87', color: '#fff', borderColor: '#176b87' } : {}}>Todos</button>
                        <button className="btn-mini" type="button" onClick={() => setSensorFiltro('sensor_01')} style={sensorFiltro === 'sensor_01' ? { background: '#0077b6', color: '#fff', borderColor: '#0077b6' } : {}}>Bocatoma</button>
                        <button className="btn-mini" type="button" onClick={() => setSensorFiltro('sensor_02')} style={sensorFiltro === 'sensor_02' ? { background: '#2a9d8f', color: '#fff', borderColor: '#2a9d8f' } : {}}>Ramal 1</button>
                        <button className="btn-mini" type="button" onClick={() => setSensorFiltro('sensor_03')} style={sensorFiltro === 'sensor_03' ? { background: '#e76f51', color: '#fff', borderColor: '#e76f51' } : {}}>Ramal 2</button>
                    </div>
                    <div className="table-wrap">
                        <table>
                            <thead><tr><th>{rango === 'mensual' ? 'Mes' : rango === 'diario' ? 'Día' : 'Semana'}</th><th>Punto</th><th>Caudal promedio (mL/min)</th><th>Bloques</th></tr></thead>
                            <tbody>
                                {/* Filas de promedios, aplicando el filtro por sensor */}
                                {caudal.filter(d => sensorFiltro === 'todos' || d.sensor_id === sensorFiltro).map((d, i) => (
                                    <tr key={i}>
                                        <td>{d.periodo}</td>
                                        <td>{nombrePunto(d.sensor_id)}</td>
                                        <td><strong>{d.caudal_promedio}</strong></td>
                                        <td>{d.bloques}</td>
                                    </tr>
                                ))}
                                {caudal.filter(d => sensorFiltro === 'todos' || d.sensor_id === sensorFiltro).length === 0 && <tr><td colSpan="4" style={{ textAlign: 'center', color: '#aaa' }}>Aún no hay promedios archivados</td></tr>}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {/* ----- VISTA 2: historial de reinicios ----- */}
            {vista === 'reinicios' && (
                <div className="table-wrap">
                    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                        <thead>
                            <tr style={{ background: '#176b87', color: '#fff' }}>
                                <th style={{ padding: '10px 12px', textAlign: 'left' }}>#</th>
                                <th style={{ padding: '10px 12px', textAlign: 'left' }}>Fecha del reinicio</th>
                                <th style={{ padding: '10px 12px', textAlign: 'left' }}>Realizado por</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Bocatoma</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Ramal 1</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Ramal 2</th>
                            </tr>
                        </thead>
                        <tbody>
                            {/* Cada fila = un reinicio, con el total acumulado que tenía cada sensor */}
                            {reinicios.map((r, i) => (
                                <tr key={i} style={{ background: i % 2 === 0 ? '#f7fafb' : '#ffffff', borderBottom: '1px solid #e6ecee' }}>
                                    <td style={{ padding: '9px 12px', color: '#888' }}>{i + 1}</td>
                                    <td style={{ padding: '9px 12px', fontWeight: 600 }}>{formatearFecha(r.fecha)}</td>
                                    <td style={{ padding: '9px 12px' }}>👤 {r.reiniciado_por}</td>
                                    <td style={{ padding: '9px 12px', textAlign: 'right' }}>{Math.round(r.total_s1)} mL</td>
                                    <td style={{ padding: '9px 12px', textAlign: 'right' }}>{Math.round(r.total_s2)} mL</td>
                                    <td style={{ padding: '9px 12px', textAlign: 'right' }}>{Math.round(r.total_s3)} mL</td>
                                </tr>
                            ))}
                            {reinicios.length === 0 && <tr><td colSpan="6" style={{ textAlign: 'center', color: '#aaa', padding: 14 }}>Aún no se ha reiniciado el sistema</td></tr>}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

// ============================================================================
//  COMPONENTE PRINCIPAL: App
//  Orquesta toda la aplicación: maneja la sesión, decide qué pantalla mostrar
//  (login o dashboard) y trae los datos del backend en tiempo real.
// ============================================================================
function App() {
    // --- Estado de la sesión ---
    // Recupera la credencial guardada en el navegador (si existe) al iniciar.
    const [tokenSesion, setTokenSesion] = useState(() => window.localStorage.getItem(LLAVE_TOKEN))
    const [usuarioActual, setUsuarioActual] = useState(null)
    const [verificandoSesion, setVerificandoSesion] = useState(Boolean(tokenSesion))

    // --- Estado de los formularios de autenticación ---
    const [modoAuth, setModoAuth] = useState('login')  // login | register | recuperar
    const [formLogin, setFormLogin] = useState({ usuario: '', contraseña: '' })
    const [errorLogin, setErrorLogin] = useState('')
    const [cargandoLogin, setCargandoLogin] = useState(false)
    const [formRegistro, setFormRegistro] = useState({ usuario: '', contraseña: '', correo_electronico: '', nombre: '', apellido: '' })
    const [errorRegistro, setErrorRegistro] = useState('')
    const [exitoRegistro, setExitoRegistro] = useState('')
    const [cargandoRegistro, setCargandoRegistro] = useState(false)
    const [formRecuperar, setFormRecuperar] = useState({ usuario: '', correo_electronico: '', nueva_contraseña: '' })
    const [errorRecuperar, setErrorRecuperar] = useState('')
    const [exitoRecuperar, setExitoRecuperar] = useState('')
    const [cargandoRecuperar, setCargandoRecuperar] = useState(false)
    const [mostrarCambiarClave, setMostrarCambiarClave] = useState(false)
    const [formCambiarClave, setFormCambiarClave] = useState({ contraseña_actual: '', nueva_contraseña: '' })
    const [errorCambiarClave, setErrorCambiarClave] = useState('')
    const [exitoCambiarClave, setExitoCambiarClave] = useState('')

    // --- Estado del dashboard ---
    const [dashboard, setDashboard] = useState(null)   // datos que llegan del backend
    const [error, setError] = useState('')
    const [cargando, setCargando] = useState(true)
    const [vista, setVista] = useState('dashboard')     // dashboard | usuarios
    const [filtroSensor, setFiltroSensor] = useState('todos')
    const [paginaActual, setPaginaActual] = useState(1)
    const FILAS_POR_PAGINA = 10

    // Cliente axios memorizado (se crea una sola vez) apuntando al backend.
    const api = useMemo(() => axios.create({ baseURL: URL_BACKEND }), [])
    // Cabecera de autorización con la credencial de sesión; se recalcula si cambia.
    const cabeceras = useMemo(() => (tokenSesion ? { Authorization: `Token ${tokenSesion}` } : {}), [tokenSesion])

    // EFECTO 1: al arrancar (o si cambia la credencial), valida la sesión contra
    // el backend. Si la credencial ya no sirve, la borra y saca al usuario al login.
    useEffect(() => {
        let activo = true
        async function validarSesion() {
            if (!tokenSesion) { setVerificandoSesion(false); setCargando(false); return }
            try {
                const { data } = await api.get('/api/auth/me/', { headers: cabeceras })
                if (!activo) return
                setUsuarioActual(data.usuario)
            } catch {
                if (!activo) return
                window.localStorage.removeItem(LLAVE_TOKEN)
                setTokenSesion(''); setUsuarioActual(null)
            } finally { if (activo) setVerificandoSesion(false) }
        }
        validarSesion()
        return () => { activo = false }
    }, [api, cabeceras, tokenSesion])

    // EFECTO 2: mientras haya sesión válida, pide el dashboard cada 3 segundos
    // (INTERVALO_REFRESCO) para mantener las gráficas casi en vivo. Si el servidor
    // responde 401/403 (sesión vencida), cierra sesión automáticamente.
    useEffect(() => {
        if (!tokenSesion || !usuarioActual) return undefined
        let activo = true
        async function cargarDashboard() {
            try {
                const { data } = await api.get('/api/v1/dashboard/', { headers: cabeceras })
                if (!activo) return
                setDashboard(data); setError('')
            } catch (err) {
                if (!activo) return
                if (err.response?.status === 401 || err.response?.status === 403) {
                    window.localStorage.removeItem(LLAVE_TOKEN)
                    setTokenSesion(''); setUsuarioActual(null); setDashboard(null); return
                }
                setError('No fue posible conectar con el servidor.')
            } finally { if (activo) setCargando(false) }
        }
        cargarDashboard()
        const timer = window.setInterval(cargarDashboard, INTERVALO_REFRESCO)
        return () => { activo = false; window.clearInterval(timer) }
    }, [api, cabeceras, tokenSesion, usuarioActual])

    // --- ACCIONES DE AUTENTICACIÓN ---

    // Inicia sesión: envía usuario/contraseña, guarda la credencial y entra al panel.
    async function manejarLogin(e) {
        e.preventDefault(); setErrorLogin(''); setCargandoLogin(true)
        try {
            const { data } = await api.post('/api/auth/login/', formLogin)
            window.localStorage.setItem(LLAVE_TOKEN, data.token)
            setTokenSesion(data.token); setUsuarioActual(data.usuario)
            setFormLogin({ usuario: '', contraseña: '' }); setDashboard(null); setCargando(true)
        } catch (err) { setErrorLogin(err.response?.data?.detail || 'No fue posible iniciar sesión.') }
        finally { setCargandoLogin(false) }
    }

    // Registra una cuenta nueva (queda pendiente hasta que un admin la apruebe).
    async function manejarRegistro(e) {
        e.preventDefault(); setErrorRegistro(''); setExitoRegistro(''); setCargandoRegistro(true)
        try {
            const { data } = await api.post('/api/auth/register/', formRegistro)
            setExitoRegistro(data.detail || 'Cuenta creada. Un administrador debe aprobarla.')
            setFormRegistro({ usuario: '', contraseña: '', correo_electronico: '', nombre: '', apellido: '' })
            setModoAuth('login')
        } catch (err) { setErrorRegistro(err.response?.data?.detail || 'No fue posible crear la cuenta.') }
        finally { setCargandoRegistro(false) }
    }

    // Recupera contraseña validando usuario + correo y fijando una nueva clave.
    async function manejarRecuperar(e) {
        e.preventDefault(); setErrorRecuperar(''); setExitoRecuperar(''); setCargandoRecuperar(true)
        try {
            const { data } = await api.post('/api/auth/recuperar/', formRecuperar)
            setExitoRecuperar(data.detail || 'Contraseña actualizada')
            setFormRecuperar({ usuario: '', correo_electronico: '', nueva_contraseña: '' })
            setTimeout(() => setModoAuth('login'), 2000)
        } catch (err) { setErrorRecuperar(err.response?.data?.detail || 'No fue posible recuperar la contraseña') }
        finally { setCargandoRecuperar(false) }
    }

    // Cambia la contraseña estando ya dentro (requiere la contraseña actual).
    async function manejarCambiarClave(e) {
        e.preventDefault(); setErrorCambiarClave(''); setExitoCambiarClave('')
        try {
            const { data } = await api.post('/api/auth/cambiar-clave/', formCambiarClave, { headers: cabeceras })
            setExitoCambiarClave(data.detail || 'Contraseña cambiada')
            setFormCambiarClave({ contraseña_actual: '', nueva_contraseña: '' })
            setTimeout(() => setMostrarCambiarClave(false), 2000)
        } catch (err) { setErrorCambiarClave(err.response?.data?.detail || 'No fue posible cambiar la contraseña') }
    }

    // Cierra sesión: avisa al backend y limpia toda la información local.
    async function cerrarSesion() {
        try { if (tokenSesion) await api.post('/api/auth/logout/', null, { headers: cabeceras }) } catch {}
        finally {
            window.localStorage.removeItem(LLAVE_TOKEN)
            setTokenSesion(''); setUsuarioActual(null); setDashboard(null); setError(''); setCargando(false)
            setVista('dashboard'); setMostrarCambiarClave(false)
        }
    }

    // Envía un comando de abrir/cerrar a una electroválvula (viaja por MQTT al ESP32).
    async function controlarValvula(sensor, accion) {
        try { await api.post('/api/v1/valvula/', { sensor, accion }, { headers: cabeceras }) }
        catch { alert('❌ Error al enviar comando') }
    }

    // Reinicia los contadores de los 3 sensores a 0 (guardando antes un histórico).
    async function reiniciarSistema() {
        if (!window.confirm('¿Reiniciar los contadores de los 3 sensores a 0?\nSe guardará un registro histórico y se borrará el historial de mediciones. Esta acción no se puede deshacer.')) return
        try {
            await api.post('/api/v1/reiniciar/', null, { headers: cabeceras })
            // Vacía las lecturas locales de una vez para que las gráficas queden en 0
            setDashboard(prev => prev ? { ...prev, recent_readings: [], latest: null } : prev)
            setError('')
        } catch { alert('No fue posible reiniciar el sistema.') }
    }

    // --- RENDERIZADO CONDICIONAL ---

    // 1) Mientras se verifica la credencial guardada, mostramos una pantalla de espera.
    if (verificandoSesion) {
        return (<main className="auth-page"><section className="auth-panel"><p className="eyebrow">Acueducto veredal</p><h1>Validando acceso</h1><p>Comprobando tu sesión...</p></section></main>)
    }

    // 2) Si NO hay sesión, mostramos la pantalla de autenticación (login/registro/recuperar).
    if (!tokenSesion || !usuarioActual) {
        return (
            <main className="auth-page">
                <section className="auth-panel">
                    <p className="eyebrow">Acueducto veredal</p>
                    <h1>{modoAuth === 'login' ? 'Ingreso administrativo' : modoAuth === 'register' ? 'Crear cuenta' : 'Recuperar contraseña'}</h1>
                    <p>{modoAuth === 'login' ? 'Inicia sesión con una cuenta aprobada para ver el dashboard.' : modoAuth === 'register' ? 'Solicita una cuenta. Un administrador debe aprobarla.' : 'Ingresa tu usuario y correo electrónico para restablecer tu contraseña.'}</p>
                    {/* Pestañas para alternar entre los tres formularios */}
                    <div className="auth-switch" role="tablist">
                        <button className={modoAuth === 'login' ? 'active' : ''} onClick={() => { setModoAuth('login'); setErrorLogin('') }} role="tab" type="button">Ingresar</button>
                        <button className={modoAuth === 'register' ? 'active' : ''} onClick={() => { setModoAuth('register'); setErrorRegistro(''); setExitoRegistro('') }} role="tab" type="button">Crear cuenta</button>
                        <button className={modoAuth === 'recuperar' ? 'active' : ''} onClick={() => { setModoAuth('recuperar'); setErrorRecuperar(''); setExitoRecuperar('') }} role="tab" type="button">Recuperar</button>
                    </div>
                    {/* Formulario de INGRESO */}
                    {modoAuth === 'login' ? (
                        <form className="login-form" onSubmit={manejarLogin}>
                            <label>Usuario<input autoComplete="username" onChange={e => setFormLogin(c => ({ ...c, usuario: e.target.value }))} required type="text" value={formLogin.usuario} /></label>
                            <label>Contraseña<input autoComplete="current-password" onChange={e => setFormLogin(c => ({ ...c, contraseña: e.target.value }))} required type="password" value={formLogin.contraseña} /></label>
                            {exitoRegistro && <div className="success-banner">{exitoRegistro}</div>}
                            {exitoRecuperar && <div className="success-banner">{exitoRecuperar}</div>}
                            {errorLogin && <div className="alert-banner">{errorLogin}</div>}
                            <button disabled={cargandoLogin} type="submit">{cargandoLogin ? 'Ingresando...' : 'Ingresar'}</button>
                        </form>
                    ) : modoAuth === 'register' ? (
                        /* Formulario de REGISTRO */
                        <form className="login-form" onSubmit={manejarRegistro}>
                            <label>Usuario<input onChange={e => setFormRegistro(c => ({ ...c, usuario: e.target.value }))} required type="text" value={formRegistro.usuario} /></label>
                            <label>Correo<input onChange={e => setFormRegistro(c => ({ ...c, correo_electronico: e.target.value }))} type="email" value={formRegistro.correo_electronico} /></label>
                            <div className="form-row">
                                <label>Nombre<input onChange={e => setFormRegistro(c => ({ ...c, nombre: e.target.value }))} type="text" value={formRegistro.nombre} /></label>
                                <label>Apellido<input onChange={e => setFormRegistro(c => ({ ...c, apellido: e.target.value }))} type="text" value={formRegistro.apellido} /></label>
                            </div>
                            <label>Contraseña<input minLength="8" onChange={e => setFormRegistro(c => ({ ...c, contraseña: e.target.value }))} required type="password" value={formRegistro.contraseña} /></label>
                            {errorRegistro && <div className="alert-banner">{errorRegistro}</div>}
                            <button disabled={cargandoRegistro} type="submit">{cargandoRegistro ? 'Creando...' : 'Crear cuenta'}</button>
                        </form>
                    ) : modoAuth === 'recuperar' ? (
                        /* Formulario de RECUPERACIÓN */
                        <form className="login-form" onSubmit={manejarRecuperar}>
                            <label>Usuario<input onChange={e => setFormRecuperar(c => ({ ...c, usuario: e.target.value }))} required type="text" value={formRecuperar.usuario} /></label>
                            <label>Correo electrónico<input onChange={e => setFormRecuperar(c => ({ ...c, correo_electronico: e.target.value }))} required type="email" value={formRecuperar.correo_electronico} /></label>
                            <label>Nueva contraseña<input minLength="8" onChange={e => setFormRecuperar(c => ({ ...c, nueva_contraseña: e.target.value }))} required type="password" value={formRecuperar.nueva_contraseña} /></label>
                            {errorRecuperar && <div className="alert-banner">{errorRecuperar}</div>}
                            {exitoRecuperar && <div className="success-banner">{exitoRecuperar}</div>}
                            <button disabled={cargandoRecuperar} type="submit">{cargandoRecuperar ? 'Recuperando...' : 'Recuperar contraseña'}</button>
                        </form>
                    ) : null}
                </section>
            </main>
        )
    }

    // 3) Con sesión válida: preparamos los datos del dashboard antes de dibujarlo.
    const lecturas = dashboard?.recent_readings || []           // últimas lecturas de los sensores
    const estado = dashboard?.latest?.estado || 'desconectado'  // estado general del sistema
    const alerta = dashboard?.latest?.alerta                    // mensaje de alerta, si hay
    const actuadores = dashboard?.actuadores || []
    const buscarActuador = (id) => actuadores.find(a => a.nombre_actuador === id)
    // Separamos la última lectura de cada sensor para el balance hídrico.
    const s1 = lecturas.find(r => r.sensor_id === 'sensor_01')
    const s2 = lecturas.find(r => r.sensor_id === 'sensor_02')
    const s3 = lecturas.find(r => r.sensor_id === 'sensor_03')
    const entrada = valorNumerico(s1?.caudal_entrada)
    const salida1 = valorNumerico(s2?.caudal_entrada)
    const salida2 = valorNumerico(s3?.caudal_entrada)
    const NOMBRES_SENSOR = { sensor_01: 'Bocatoma', sensor_02: 'Ramal 1', sensor_03: 'Ramal 2' }
    // Filtrado y paginación de la tabla de "Lecturas recientes".
    const lecturasFiltradas = filtroSensor === 'todos' ? lecturas : lecturas.filter((r) => r.sensor_id === filtroSensor)
    const totalPaginas = Math.max(1, Math.ceil(lecturasFiltradas.length / FILAS_POR_PAGINA))
    const paginaSegura = Math.min(paginaActual, totalPaginas)
    const inicioPagina = (paginaSegura - 1) * FILAS_POR_PAGINA
    const lecturasPagina = lecturasFiltradas.slice(inicioPagina, inicioPagina + FILAS_POR_PAGINA)
    function cambiarFiltro(valor) { setFiltroSensor(valor); setPaginaActual(1) }

    // --- PANTALLA DEL DASHBOARD ---
    return (
        <main className="dashboard-page">
            {/* Cabecera: título, estado, usuario y botones globales */}
            <header className="dashboard-header">
                <div>
                    <p className="eyebrow">Acueducto veredal</p>
                    <h1>Monitoreo hidráulico IoT</h1>
                    <p>3 sensores YF-S401 · ESP32 · MQTT · MongoDB</p>
                </div>
                <div className="header-actions">
                    <div className={`status-pill status-${estado}`}><span />{TEXTOS_ESTADO[estado] || estado}</div>
                    <span className="user-badge">{usuarioActual.es_administrador ? '👑 Admin' : '👤 ' + usuarioActual.usuario}</span>
                    {/* El botón de reiniciar solo lo ve el administrador */}
                    {usuarioActual.es_administrador && (
                        <button className="logout-button" onClick={reiniciarSistema} type="button" style={{ background: '#c0392b', color: '#fff', borderColor: '#c0392b' }}>Reiniciar</button>
                    )}
                    <button className="logout-button" onClick={() => setMostrarCambiarClave(!mostrarCambiarClave)} type="button">🔑</button>
                    <button className="logout-button" onClick={cerrarSesion} type="button">Salir</button>
                </div>
            </header>

            {/* Selector Dashboard/Usuarios (solo administrador) */}
            {usuarioActual.es_administrador && (
                <div className="auth-switch vista-switch" role="tablist" style={{ marginBottom: 24 }}>
                    <button className={vista === 'dashboard' ? 'active' : ''} onClick={() => setVista('dashboard')} role="tab" type="button">Dashboard</button>
                    <button className={vista === 'usuarios' ? 'active' : ''} onClick={() => setVista('usuarios')} role="tab" type="button">Usuarios</button>
                </div>
            )}

            {/* Banners de error del servidor y de alerta del sistema */}
            {error && <section className="alert-banner">{error}</section>}
            {alerta && <section className="alert-banner">{alerta}</section>}

            {/* Formulario emergente para cambiar contraseña */}
            {mostrarCambiarClave && (
                <section className="panel panel-wide" style={{ marginBottom: 24, padding: 24 }}>
                    <h2>Cambiar contraseña</h2>
                    <form className="login-form" onSubmit={manejarCambiarClave} style={{ maxWidth: 400 }}>
                        <label>Contraseña actual<input onChange={e => setFormCambiarClave(c => ({ ...c, contraseña_actual: e.target.value }))} required type="password" value={formCambiarClave.contraseña_actual} /></label>
                        <label>Nueva contraseña<input minLength="8" onChange={e => setFormCambiarClave(c => ({ ...c, nueva_contraseña: e.target.value }))} required type="password" value={formCambiarClave.nueva_contraseña} /></label>
                        {errorCambiarClave && <div className="alert-banner">{errorCambiarClave}</div>}
                        {exitoCambiarClave && <div className="success-banner">{exitoCambiarClave}</div>}
                        <button type="submit">Cambiar contraseña</button>
                    </form>
                </section>
            )}

            {/* Si el admin eligió "Usuarios" mostramos ese panel; si no, el dashboard */}
            {vista === 'usuarios' && usuarioActual.es_administrador ? (
                <PanelUsuarios api={api} cabeceras={cabeceras} />
            ) : (
                <>
                    {/* Gráficas en tiempo real, una por sensor */}
                    <section className="sensors-section">
                        <h2 className="section-title">Gráficas por sensor</h2>
                        <div className="sensors-grid">
                            <TarjetaSensor titulo="Sensor 1 — Bocatoma" sensorId="sensor_01" ubicacion="Entrada principal" color="#0077b6" lecturas={lecturas} />
                            <TarjetaSensor titulo="Sensor 2 — Ramal 1" sensorId="sensor_02" ubicacion="Salida ramal 1" color="#2a9d8f" lecturas={lecturas} />
                            <TarjetaSensor titulo="Sensor 3 — Ramal 2" sensorId="sensor_03" ubicacion="Salida ramal 2" color="#e76f51" lecturas={lecturas} />
                        </div>
                    </section>

                    {/* Módulo de balance hídrico */}
                    <section className="balance-wrap">
                        <BarraBalance entrada={entrada} salida1={salida1} salida2={salida2} balance={dashboard?.balance} />
                    </section>

                    {/* Mapa de la vereda con la ubicación de los usuarios */}
                    <MapaUbicacion api={api} cabeceras={cabeceras} lecturas={lecturas} />

                    {/* Control manual de las 3 electroválvulas */}
                    <section className="valvulas-section">
                        <h2 className="section-title">Control de electroválvulas</h2>
                        <div className="valvulas-grid">
                            {['ev01', 'ev02', 'ev03'].map((ev, i) => (
                                <article className="valvula-card" key={ev}>
                                    <h3>Electroválvula {i + 1} — {['Bocatoma', 'Ramal 1', 'Ramal 2'][i]}</h3>
                                    <p className="valvula-sub">Sensor {i + 1} · {['sensor_01', 'sensor_02', 'sensor_03'][i]}</p>
                                    <p className="valvula-sub">Estado confirmado: <ChipEstado actuador={buscarActuador(ev)} /></p>
                                    <div className="valvula-btns">
                                        <button className="btn-abrir" onClick={() => controlarValvula(ev, 'ABRIR')} type="button">🔓 Abrir</button>
                                        <button className="btn-cerrar" onClick={() => controlarValvula(ev, 'CERRAR')} type="button">🔒 Cerrar</button>
                                    </div>
                                </article>
                            ))}
                        </div>
                    </section>

                    {/* Historial de promedios y de reinicios */}
                    <HistorialReinicios api={api} cabeceras={cabeceras} />

                    {/* Tabla paginada de las lecturas más recientes */}
                    <section className="panel panel-wide historial-section">
                        <div className="panel-heading">
                            <div><p className="eyebrow">Historial</p><h2>Lecturas recientes</h2></div>
                            {cargando && <small>Actualizando...</small>}
                        </div>
                        <div className="historial-filtros">
                            <label>Filtrar por sensor:
                                <select onChange={(e) => cambiarFiltro(e.target.value)} value={filtroSensor}>
                                    <option value="todos">Todos</option>
                                    <option value="sensor_01">Bocatoma</option>
                                    <option value="sensor_02">Ramal 1</option>
                                    <option value="sensor_03">Ramal 2</option>
                                </select>
                            </label>
                            <span className="historial-conteo">{lecturasFiltradas.length} lectura{lecturasFiltradas.length !== 1 ? 's' : ''}</span>
                        </div>
                        <div className="table-wrap">
                            <table>
                                <thead><tr><th>#</th><th>Fecha</th><th>Sensor</th><th>Caudal (mL/min)</th><th>Estado</th><th>Origen</th></tr></thead>
                                <tbody>
                                    {lecturasPagina.map((r, i) => (
                                        <tr key={r.id}>
                                            <td>{inicioPagina + i + 1}</td>
                                            <td>{formatearFecha(r.fecha)}</td>
                                            <td>{NOMBRES_SENSOR[r.sensor_id] || r.sensor_id}</td>
                                            <td>{valorNumerico(r.caudal_entrada).toFixed(1)}</td>
                                            <td><span className={`table-status status-${r.estado}`}>{TEXTOS_ESTADO[r.estado]}</span></td>
                                            <td>{r.origen_dato}</td>
                                        </tr>
                                    ))}
                                    {lecturasPagina.length === 0 && <tr><td colSpan="6" style={{ textAlign: 'center', color: '#aaa' }}>Sin lecturas aún</td></tr>}
                                </tbody>
                            </table>
                        </div>
                        {/* Controles de paginación */}
                        <div className="historial-paginador">
                            <button disabled={paginaSegura <= 1} onClick={() => setPaginaActual(1)} type="button">« Primera</button>
                            <button disabled={paginaSegura <= 1} onClick={() => setPaginaActual(p => Math.max(1, p - 1))} type="button">‹ Anterior</button>
                            <span>Página {paginaSegura} de {totalPaginas}</span>
                            <button disabled={paginaSegura >= totalPaginas} onClick={() => setPaginaActual(p => Math.min(totalPaginas, p + 1))} type="button">Siguiente ›</button>
                            <button disabled={paginaSegura >= totalPaginas} onClick={() => setPaginaActual(totalPaginas)} type="button">Última »</button>
                        </div>
                    </section>
                </>
            )}
        </main>
    )
}

export default App