import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'

//puntos de ejemplo cerca de bucaramanga (floridablanca), simulando donde
//quedaria la bocatoma y los 2 ramales de una vereda real
const PUNTOS = [
    { id: 'bocatoma', nombre: 'Bocatoma', lat: 7.0903, lng: -73.1345, color: '#0077b6' },
    { id: 'ramal1', nombre: 'Ramal 1', lat: 7.0920, lng: -73.1300, color: '#2a9d8f' },
    { id: 'ramal2', nombre: 'Ramal 2', lat: 7.0880, lng: -73.1290, color: '#e76f51' },
]

const CENTRO = [7.0900, -73.1310]
const VERDE = '#2e7d32'   // usuario activo
const ROJO = '#c62828'    // usuario inactivo

//icono redondo para la infraestructura (bocatoma y ramales)
function crearIcono(color) {
    return L.divIcon({
        className: 'mapa-marcador',
        html: `<div style="
            width: 22px; height: 22px; border-radius: 50%;
            background: ${color}; border: 3px solid white;
            box-shadow: 0 2px 6px rgba(0,0,0,0.35);
        "></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
    })
}

//icono para los usuarios: verde si esta activo, rojo si no
function crearIconoUsuario(activo) {
    const color = activo ? VERDE : ROJO
    return L.divIcon({
        className: 'mapa-marcador-usuario',
        html: `<div style="
            width: 16px; height: 16px; border-radius: 50%;
            background: ${color}; border: 2px solid white;
            box-shadow: 0 1px 4px rgba(0,0,0,0.4);
        "></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
    })
}

//si el usuario no tiene coordenadas, le damos una posicion ESTABLE (siempre la misma)
//cerca de la vereda, calculada a partir de su nombre de usuario
function posicionUsuario(u) {
    if (typeof u.latitud === 'number' && typeof u.longitud === 'number') {
        return [u.latitud, u.longitud]
    }
    let h = 0
    const s = u.usuario || ''
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    const desplazamientoLat = ((h % 1000) / 1000 - 0.5) * 0.008        // ~±0.004 grados
    const desplazamientoLng = ((Math.floor(h / 1000) % 1000) / 1000 - 0.5) * 0.008
    return [CENTRO[0] + desplazamientoLat, CENTRO[1] + desplazamientoLng]
}

export default function MapaUbicacion({ api, cabeceras, lecturas = [] }) {
    const contenedorRef = useRef(null)
    const mapaRef = useRef(null)
    const capaUsuariosRef = useRef(null)
    const capaInfraRef = useRef(null)
    const [mapaListo, setMapaListo] = useState(false)
    const [usuarios, setUsuarios] = useState([])
    const [filtroMapa, setFiltroMapa] = useState('todos') // todos | activos | inactivos

    // a qué sensor corresponde cada punto de infraestructura del mapa
    const PUNTO_SENSOR = { bocatoma: 'sensor_01', ramal1: 'sensor_02', ramal2: 'sensor_03' }

    // nombres legibles y colores por sensor
    const INFO_SENSOR = {
        sensor_01: { nombre: 'Bocatoma', color: '#0077b6' },
        sensor_02: { nombre: 'Ramal 1', color: '#2a9d8f' },
        sensor_03: { nombre: 'Ramal 2', color: '#e76f51' },
    }

    // arma una mini-gráfica SVG (sparkline) del caudal de un sensor.
    // Si no hay sensor o no hay datos, dibuja una línea plana en 0.0.
    function graficaSensorHTML(sensorId, nombreForzado) {
        const info = INFO_SENSOR[sensorId]
        const nombre = nombreForzado || (info ? info.nombre : 'Sin punto')
        const color = info ? info.color : '#888'
        let serie = []
        if (sensorId && INFO_SENSOR[sensorId]) {
            serie = lecturas
                .filter(r => r.sensor_id === sensorId)
                .slice(0, 20).reverse()
                .map(r => Number(r.caudal_entrada) || 0)
        }
        // si no hay datos suficientes, se dibuja una línea plana en 0.0
        let planaCero = false
        if (serie.length < 2) { serie = [0, 0]; planaCero = true }

        const w = 200, h = 60, pad = 6
        const max = Math.max(...serie, 1), min = Math.min(...serie, 0)
        const rango = (max - min) || 1
        const pts = serie.map((v, i) => {
            const x = pad + (i * (w - 2 * pad)) / (serie.length - 1)
            const y = h - pad - ((v - min) / rango) * (h - 2 * pad)
            return `${x.toFixed(1)},${y.toFixed(1)}`
        }).join(' ')
        const actual = (planaCero ? 0 : serie[serie.length - 1]).toFixed(1)
        return `<div style="margin-top:6px">
            <strong style="color:${color}">${nombre}</strong>
            <span style="float:right;font-weight:bold;color:${color}">${actual} mL/min</span>
            <svg width="${w}" height="${h}" style="display:block;margin-top:4px">
              <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="#e0e0e0" stroke-width="1"/>
              <polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>
            </svg></div>`
    }

    //Se crea el mapa una sola vez, con la infraestructura (bocatoma y ramales)
    useEffect(() => {
        if (mapaRef.current || !contenedorRef.current) return

        const mapa = L.map(contenedorRef.current, {
            center: CENTRO,
            zoom: 15,
            scrollWheelZoom: false,
        })

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19,
        }).addTo(mapa)

        const coordenadas = PUNTOS.map((p) => [p.lat, p.lng])
        //esta linea punteada representa la tuberia (bocatoma -> ramal1 -> ramal2)
        L.polyline(coordenadas, { color: '#176b87', weight: 3, dashArray: '6 6' }).addTo(mapa)

        //capas aparte para infraestructura y usuarios, así se redibujan con datos frescos
        capaInfraRef.current = L.layerGroup().addTo(mapa)
        capaUsuariosRef.current = L.layerGroup().addTo(mapa)

        mapaRef.current = mapa
        setMapaListo(true)

        return () => {
            mapa.remove()
            mapaRef.current = null
            capaUsuariosRef.current = null
            capaInfraRef.current = null
            setMapaListo(false)
        }
    }, [])

    //Se traen los usuarios al montar y cada 15 seg (para reflejar activo/inactivo)
    useEffect(() => {
        if (!api) return
        let vivo = true
        async function cargar() {
            try {
                const { data } = await api.get('/api/usuarios/mapa', { headers: cabeceras })
                if (vivo) setUsuarios(Array.isArray(data) ? data : [])
            } catch { /* si falla, dejamos el mapa solo con la infraestructura */ }
        }
        cargar()
        const id = setInterval(cargar, 15000)
        return () => { vivo = false; clearInterval(id) }
    }, [api, cabeceras])

    //Cada vez que cambian los usuarios/lecturas (o el mapa queda listo), se redibuja todo
    useEffect(() => {
        if (!mapaListo || !capaUsuariosRef.current || !capaInfraRef.current) return

        //--- puntos de infraestructura (Bocatoma, Ramal 1, Ramal 2) con su gráfica ---
        const capaInfra = capaInfraRef.current
        capaInfra.clearLayers()
        PUNTOS.forEach((p) => {
            const grafica = graficaSensorHTML(PUNTO_SENSOR[p.id])
            L.marker([p.lat, p.lng], { icon: crearIcono(p.color) })
                .addTo(capaInfra)
                .bindPopup(`<strong>${p.nombre}</strong>${grafica}`, { minWidth: 220 })
        })

        //--- usuarios ---
        const capa = capaUsuariosRef.current
        capa.clearLayers()
        const visibles = usuarios.filter((u) =>
            filtroMapa === 'activos' ? u.esta_activo : filtroMapa === 'inactivos' ? !u.esta_activo : true)
        visibles.forEach((u) => {
            const [lat, lng] = posicionUsuario(u)
            const nombre = (u.nombre || u.usuario || 'Usuario').trim()
            const estado = u.esta_activo ? 'Activo' : 'Inactivo'
            const grafica = graficaSensorHTML(u.sensor_asociado)
            L.marker([lat, lng], { icon: crearIconoUsuario(u.esta_activo) })
                .addTo(capa)
                .bindPopup(`<strong>${nombre}</strong><br/>@${u.usuario}<br/>Estado: ${estado}${grafica}`, { minWidth: 220 })
        })
    }, [usuarios, mapaListo, lecturas, filtroMapa])

    const activos = usuarios.filter((u) => u.esta_activo).length
    const inactivos = usuarios.length - activos

    return (
        <div className="panel panel-wide mapa-section">
            <div className="panel-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div>
                    <p className="eyebrow">Ubicación</p>
                    <h2>Mapa del sistema — Vereda (simulado)</h2>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-mini" type="button" onClick={() => setFiltroMapa('todos')} style={filtroMapa === 'todos' ? { background: '#176b87', color: '#fff', borderColor: '#176b87' } : {}}>Todos ({usuarios.length})</button>
                    <button className="btn-mini" type="button" onClick={() => setFiltroMapa('activos')} style={filtroMapa === 'activos' ? { background: '#2e7d32', color: '#fff', borderColor: '#2e7d32' } : {}}>🟢 Activos ({activos})</button>
                    <button className="btn-mini" type="button" onClick={() => setFiltroMapa('inactivos')} style={filtroMapa === 'inactivos' ? { background: '#c62828', color: '#fff', borderColor: '#c62828' } : {}}>🔴 Inactivos ({inactivos})</button>
                </div>
            </div>
            <div className="mapa-contenedor" ref={contenedorRef} />
            <div className="mapa-leyenda">
                {PUNTOS.map((p) => (
                    <span key={p.id}>
                        <span className="dot" style={{ background: p.color }} /> {p.nombre}
                    </span>
                ))}
                <span><span className="dot" style={{ background: VERDE }} /> Usuario activo ({activos})</span>
                <span><span className="dot" style={{ background: ROJO }} /> Usuario inactivo ({inactivos})</span>
            </div>
        </div>
    )
}