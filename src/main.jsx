// ============================================================================
//  main.jsx  —  PUNTO DE ENTRADA DE LA APLICACIÓN REACT
// ----------------------------------------------------------------------------
//  Este archivo es el primero que ejecuta el navegador. Su única tarea es
//  "montar" (renderizar) el componente principal <App /> dentro del HTML.
//  Todo lo demás (login, dashboard, mapa, etc.) vive dentro de <App />.
// ============================================================================

// StrictMode: envoltorio de React que activa comprobaciones extra SOLO en
// desarrollo (avisa de código obsoleto o efectos mal escritos). No afecta la
// versión final que se publica en producción.
import { StrictMode } from 'react'

// createRoot: API moderna de React 18 para crear la "raíz" donde se dibuja
// toda la interfaz.
import { createRoot } from 'react-dom/client'

// Hoja de estilos base de la aplicación.
import './index.css'

// Componente principal que contiene toda la lógica de la aplicación.
import App from './App.jsx'

// Busca en el HTML el elemento con id="root" (definido en index.html) y
// renderiza dentro de él el árbol de componentes de React.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)