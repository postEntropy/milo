// The theme has to be on the document before the first paint, not in a React effect:
// Safari reads the page's colour for its own bars as it paints, so a light first frame
// — the stylesheet's own default — is what leaves them light. It is a real file rather
// than an inline script because the page's CSP allows no inline script; same rule the
// app applies on mount, from the same key (`milo-theme`).
;(() => {
  const saved = localStorage.getItem('milo-theme')
  const dark = saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
})()
