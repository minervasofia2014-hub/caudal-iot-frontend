import { useEffect, useRef } from 'react'
import L from 'leaflet'

//puntos de ejemplo cerca de bucaramanga (floridablanca), simulando donde
//quedaria la bocatoma y los 2 ramales de una vereda real
const PUNTOS = [
    { id: 'bocatoma', nombre: 'Bocatoma', lat: 7.0903, lng: -73.1345, color: '#0077b6' },
    { id: 'ramal1', nombre: 'Ramal 1', lat: 7.0920, lng: -73.1300, color: '#2a9d8f' },
    { id: 'ramal2', nombre: 'Ramal 2', lat: 7.0880, lng: -73.1290, color: '#e76f51' },
]

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

export default function MapaUbicacion() {
    const contenedorRef = useRef(null)
    const mapaRef = useRef(null)

    useEffect(() => {
        if (mapaRef.current || !contenedorRef.current) return

        const centro = [7.0900, -73.1310]
        const mapa = L.map(contenedorRef.current, {
            center: centro,
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

        PUNTOS.forEach((p) => {
            L.marker([p.lat, p.lng], { icon: crearIcono(p.color) })
                .addTo(mapa)
                .bindPopup(`<strong>${p.nombre}</strong>`)
        })

        mapaRef.current = mapa

        return () => {
            mapa.remove()
            mapaRef.current = null
        }
    }, [])

    return (
        <div className="panel panel-wide mapa-section">
            <div className="panel-heading">
                <div>
                    <p className="eyebrow">Ubicación</p>
                    <h2>Mapa del sistema — Vereda (simulado)</h2>
                </div>
            </div>
            <div className="mapa-contenedor" ref={contenedorRef} />
            <div className="mapa-leyenda">
                {PUNTOS.map((p) => (
                    <span key={p.id}>
                        <span className="dot" style={{ background: p.color }} /> {p.nombre}
                    </span>
                ))}
            </div>
        </div>
    )
}