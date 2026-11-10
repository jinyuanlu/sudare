import { render } from 'preact'
import { App } from './App'
import { boot } from './store'
import './styles.css'

boot()
render(<App />, document.getElementById('app')!)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined))
}
