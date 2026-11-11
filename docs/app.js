const THEMES = ['auto', 'light', 'dark']
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const themeButton = document.getElementById('themeBtn')
const themeLabel = document.getElementById('themeLabel')

let themeMode = 'auto'
try {
  const stored = localStorage.getItem('yoinks-landing-theme')
  if (THEMES.includes(stored)) themeMode = stored
} catch {}

function applyTheme() {
  const resolved = themeMode === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : themeMode
  document.documentElement.dataset.theme = resolved
  if (themeLabel) themeLabel.textContent = themeMode
  if (themeButton) themeButton.setAttribute('aria-label', `Color theme: ${themeMode}`)

  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = resolved === 'dark' ? '#0f0f11' : '#ffffff'

  const icon = document.querySelector('link[rel="icon"]')
  if (icon) icon.href = resolved === 'dark' ? 'assets/logo-dark.svg' : 'assets/logo-light.svg'
}

themeButton?.addEventListener('click', () => {
  themeMode = THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length]
  try {
    localStorage.setItem('yoinks-landing-theme', themeMode)
  } catch {}
  applyTheme()
})

darkQuery.addEventListener('change', () => {
  if (themeMode === 'auto') applyTheme()
})

applyTheme()

const copyButton = document.getElementById('copyBtn')
const installCode = document.getElementById('installCode')

function fallbackCopy(text) {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {}
  area.remove()
  return copied
}

copyButton?.addEventListener('click', async () => {
  const text = installCode?.textContent?.trim() ?? ''
  if (!text) return

  let copied = false
  try {
    await navigator.clipboard.writeText(text)
    copied = true
  } catch {
    copied = fallbackCopy(text)
  }

  copyButton.textContent = copied ? 'copied' : 'select & copy'
  copyButton.disabled = true
  setTimeout(() => {
    copyButton.textContent = 'copy'
    copyButton.disabled = false
  }, 1800)
})
