import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import './fonts.css'
import './styles.css'
import { LogoLab } from './brand/LogoLab.js'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.location.pathname === '/logo-lab' ? <LogoLab /> : <App />}
  </React.StrictMode>,
)
