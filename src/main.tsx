import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { configError } from './lib/supabase'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {configError ? (
      <main className="auth">
        <h1>Setup needed</h1>
        <p className="card msg">{configError}</p>
      </main>
    ) : (
      <App />
    )}
  </StrictMode>,
)

// The service worker only makes the app installable; it caches nothing (see public/sw.js).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
