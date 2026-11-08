const $ = id => document.getElementById(id)
const $$ = selector => [...document.querySelectorAll(selector)]

const DEFAULT_HINT = 'press enter · esc to clear'
const THEMES = ['auto', 'light', 'dark']
const TERMINAL_STATUSES = ['done', 'error', 'cancelled']

const state = {
  tab: 'yoink',
  session: null,
  playlist: null,
  currentJobId: null,
  jobs: [],
  library: [],
  settings: null,
  diagnostics: null,
  probeAbort: null,
  probeCancelled: false,
  jobStream: null,
  lastStatuses: new Map(),
  notify: localStorage.getItem('yoinks-notify') === '1',
  installPrompt: null,
  libraryQuery: '',
  refreshingJobs: false,
}

// ------------------------------------------------------------------ helpers

async function api(path, options = {}) {
  const headers = {...(options.body ? {'Content-Type': 'application/json'} : {}), ...(options.headers ?? {})}
  const response = await fetch(path, {...options, headers})
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`
}

function fmtSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  return `${fmtBytes(bytesPerSecond)}/s`
}

function fmtDate(timestamp) {
  if (!timestamp) return ''
  try {
    return new Date(timestamp).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})
  } catch {
    return ''
  }
}

function normalizeUrl(raw) {
  let value = String(raw || '').trim()
  if (!value) return null
  if (!/^https?:\/\//i.test(value)) {
    if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value)) value = `https://${value}`
    else return null
  }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function prettySite(extractor) {
  if (!extractor) return ''
  const key = String(extractor).toLowerCase()
  const names = {
    youtube: 'YouTube',
    twitter: 'X / Twitter',
    instagram: 'Instagram',
    tiktok: 'TikTok',
    threads: 'Threads',
    facebook: 'Facebook',
    reddit: 'Reddit',
    vimeo: 'Vimeo',
    twitch: 'Twitch',
    generic: 'direct file',
  }
  return names[key] || String(extractor)
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function toast(message, kind = 'info') {
  const node = el('div', `toast${kind === 'error' ? ' error' : ''}`, message)
  $('toasts').append(node)
  setTimeout(() => node.remove(), 4200)
}

function setHint(text, isError = false) {
  const hint = $('homeHint')
  hint.textContent = text
  hint.classList.toggle('error', isError)
}

function setThumb(img, wrap, url) {
  if (!url) {
    wrap.classList.add('empty')
    img.removeAttribute('src')
    return
  }
  wrap.classList.remove('empty')
  img.src = url
  img.onerror = () => wrap.classList.add('empty')
}

// ------------------------------------------------------------------ theme

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
let themeMode = localStorage.getItem('yoinks-theme')
if (!THEMES.includes(themeMode)) themeMode = 'auto'

function applyTheme() {
  const resolved = themeMode === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : themeMode
  document.documentElement.dataset.theme = resolved
  $('themeLabel').textContent = themeMode
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = resolved === 'dark' ? '#111113' : '#ffffff'
  const icon = document.querySelector('link[rel="icon"]')
  if (icon) icon.href = resolved === 'dark' ? '/assets/logo-dark.svg' : '/assets/logo-light.svg'
}

darkQuery.addEventListener('change', () => {
  if (themeMode === 'auto') applyTheme()
})

$('themeBtn').addEventListener('click', () => {
  themeMode = THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length]
  localStorage.setItem('yoinks-theme', themeMode)
  applyTheme()
})

applyTheme()

// ------------------------------------------------------------------ tabs

const tabs = $$('.tab')
const panels = $$('.panel')

function setTab(name) {
  const known = tabs.some(tab => tab.dataset.tab === name)
  state.tab = known ? name : 'yoink'
  for (const tab of tabs) tab.classList.toggle('active', tab.dataset.tab === state.tab)
  for (const panel of panels) panel.classList.toggle('active', panel.id === `panel-${state.tab}`)
  const url = new URL(location.href)
  url.searchParams.set('tab', state.tab)
  history.replaceState(null, '', url)
  if (state.tab === 'queue') refreshJobs().catch(() => {})
  if (state.tab === 'library') refreshLibrary().catch(() => {})
  if (state.tab === 'settings') {
    loadSettings().catch(() => {})
    refreshDiagnostics().catch(() => {})
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    // clicking "yoink" while a download screen is open should take you home;
    // the download itself keeps running in the queue
    if (tab.dataset.tab === 'yoink' && document.querySelector('.screen.active')?.id === 'screen-download') {
      leaveDownloadScreen()
      return
    }
    setTab(tab.dataset.tab)
  })
}

// ------------------------------------------------------------------ yoink screens

const screens = $$('#panel-yoink .screen')

function showScreen(id) {
  for (const screen of screens) screen.classList.toggle('active', screen.id === id)
}

const urlForm = $('urlForm')
const urlInput = $('urlInput')

function resetHome() {
  state.probeCancelled = true
  state.probeAbort?.abort()
  closeJobStream()
  state.session = null
  state.playlist = null
  state.currentJobId = null
  setHint(DEFAULT_HINT)
  showScreen('screen-home')
  urlInput.focus()
}

function startNew() {
  setTab('yoink')
  resetHome()
}

$('homeBtn').addEventListener('click', startNew)

urlForm.addEventListener('submit', event => {
  event.preventDefault()
  void startProbe(urlInput.value)
})

urlInput.addEventListener('input', () => {
  const value = urlInput.value.trim()
  if (/[?&]list=|\/playlist|\/@[^/]+\/videos|\/sets\//i.test(value)) $('playlistToggle').checked = true
})

$('pasteBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText()
    if (text && text.trim()) {
      urlInput.value = text.trim()
      setHint('pasted — press enter')
    }
    urlInput.focus()
  } catch {
    setHint('clipboard is blocked — use ctrl+v', true)
    urlInput.focus()
  }
})

let slowTimer = null

async function startProbe(raw) {
  const url = normalizeUrl(raw)
  if (!url) {
    urlForm.classList.add('invalid')
    setHint('paste a valid http(s) link', true)
    urlInput.focus()
    setTimeout(() => urlForm.classList.remove('invalid'), 400)
    return
  }

  urlForm.classList.remove('invalid')
  setHint(DEFAULT_HINT)
  state.session = null
  state.playlist = null
  state.probeCancelled = false
  showScreen('screen-loading')
  $('loadingText').textContent = 'reading the link…'
  clearTimeout(slowTimer)
  slowTimer = setTimeout(() => {
    if ($('screen-loading').classList.contains('active')) {
      $('loadingText').textContent = 'still reading — the first run downloads yt-dlp, this can take a minute…'
    }
  }, 9000)

  state.probeAbort = new AbortController()

  try {
    const data = await api('/api/probe', {
      method: 'POST',
      body: JSON.stringify({url, playlist: $('playlistToggle').checked}),
      signal: state.probeAbort.signal,
    })
    if (data.playlist) {
      state.playlist = data
      renderPlaylist(data)
      showScreen('screen-playlist')
    } else {
      state.session = data
      renderPick(data)
      showScreen('screen-pick')
    }
  } catch (error) {
    if (state.probeCancelled || error.name === 'AbortError') {
      resetHome()
      return
    }
    showError(error.message || 'Could not read that link.')
  } finally {
    clearTimeout(slowTimer)
    state.probeAbort = null
  }
}

$('cancelProbe').addEventListener('click', resetHome)
$('backBtn').addEventListener('click', resetHome)
$('playlistBack').addEventListener('click', resetHome)
$('errorBack').addEventListener('click', resetHome)
$('againBtn').addEventListener('click', resetHome)

// ------------------------------------------------------------------ pick

function renderPick(data) {
  const title = $('videoTitle')
  title.replaceChildren()
  const link = el('a', '', data.title || 'untitled video')
  link.href = data.webpageUrl || data.url || '#'
  link.target = '_blank'
  link.rel = 'noopener'
  title.append(link)

  $('videoUploader').textContent = data.uploader || ''
  $('badgeDuration').textContent = data.duration ? fmtDuration(data.duration) : ''
  $('badgeSite').textContent = prettySite(data.extractor)
  setThumb($('thumb'), $('thumb').closest('.thumb-wrap'), data.thumbnail)

  const note = $('pickNote')
  if (data.hasVideo === false) {
    note.textContent = 'No video stream found — this post only exposes audio (common for TikTok slideshows or restricted videos). Only the audio track can be saved.'
    note.classList.add('warn')
  } else {
    note.textContent = 'H.264 plays everywhere. H.265/AV1/VP9 are converted to H.264 after download (videos up to 1080p).'
    note.classList.remove('warn')
  }

  const list = $('choices')
  list.replaceChildren()
  data.choices.forEach((choice, index) => {
    const button = el('button', 'choice')
    button.type = 'button'
    if (choice.compatible === false) {
      button.classList.add('incompatible')
      button.title = `${choice.codec ?? 'This codec'} may not play in Windows Media Player or QuickTime. It will be converted when possible.`
    }

    const icon = el('span', 'choice-icon', choice.kind === 'audio' ? '♪' : '▶')
    icon.setAttribute('aria-hidden', 'true')
    const label = el('span', 'choice-label', choice.label)
    const go = el('span', 'choice-go', '↓')
    go.setAttribute('aria-hidden', 'true')
    button.append(icon, label, go)
    button.addEventListener('click', () => void startDownload(index))
    list.append(button)
  })
}

function downloadOptions() {
  return {
    subtitles: $('optSubtitles').checked,
    thumbnail: $('optThumbnail').checked,
    metadata: $('optMetadata').checked,
    chapters: $('optChapters').checked,
  }
}

async function startDownload(index) {
  if (!state.session) return
  try {
    const data = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({sessionId: state.session.sessionId, choice: index, options: downloadOptions()}),
    })
    const job = data.job
    state.currentJobId = job.id
    setDownloadHeader(job)
    resetProgress()
    $('downloadEyebrow').textContent = 'queued'
    $('downloadStatus').textContent = 'waiting for a free slot…'
    $('openFolderBtn').classList.add('hidden')
    $('viewLibraryBtn').classList.add('hidden')
    $('againBtn').classList.add('hidden')
    $('cancelJobBtn').classList.remove('hidden')
    $('cancelJobBtn').disabled = false
    showScreen('screen-download')
    openJobStream(job.id)
    refreshJobs().catch(() => {})
  } catch (error) {
    showError(error.message || 'Could not start the download.')
  }
}

function setDownloadHeader(job) {
  $('downloadTitle').textContent = job.title || 'video'
  $('downloadChoice').textContent = job.format || ''
}

// ------------------------------------------------------------------ playlist

function renderPlaylist(data) {
  $('playlistTitle').textContent = data.title || 'playlist'
  const entries = data.entries ?? []
  $('playlistMeta').textContent = `${prettySite(data.extractor) || 'playlist'} · choose what to queue`
  $('playlistCount').textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`
  $('playlistAll').checked = true

  const list = $('playlistEntries')
  list.replaceChildren()
  entries.forEach((entry, index) => {
    const row = el('label', 'playlist-entry')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = Boolean(entry.url)
    checkbox.disabled = !entry.url
    checkbox.dataset.index = String(index)

    const wrap = el('div', 'thumb-wrap')
    if (entry.thumbnail) {
      const image = document.createElement('img')
      image.src = entry.thumbnail
      image.alt = ''
      image.loading = 'lazy'
      image.referrerPolicy = 'no-referrer'
      image.onerror = () => wrap.classList.add('empty')
      wrap.append(image)
    } else {
      wrap.classList.add('empty')
    }

    const title = el('span', 'entry-title', entry.title || `entry ${index + 1}`)
    const duration = el('span', 'entry-duration', entry.duration ? fmtDuration(entry.duration) : '')
    row.append(checkbox, wrap, title, duration)
    list.append(row)
  })

  $('playlistAll').checked = entries.every(entry => Boolean(entry.url))
}

$('playlistAll').addEventListener('change', event => {
  const checked = event.target.checked
  for (const checkbox of $$('#playlistEntries input[type="checkbox"]:not(:disabled)')) checkbox.checked = checked
})

$('playlistQueue').addEventListener('click', async () => {
  if (!state.playlist) return
  const selected = $$('#playlistEntries input[type="checkbox"]:checked')
  const urls = selected
    .map(checkbox => state.playlist.entries[Number(checkbox.dataset.index)])
    .filter(entry => entry && entry.url)
    .map(entry => entry.url)

  if (urls.length === 0) {
    toast('Select at least one entry.', 'error')
    return
  }

  const button = $('playlistQueue')
  button.disabled = true
  try {
    await api('/api/queue', {
      method: 'POST',
      body: JSON.stringify({urls, mode: $('playlistMode').value}),
    })
    toast(`${urls.length} ${urls.length === 1 ? 'entry' : 'entries'} added to queue`)
    setTab('queue')
    refreshJobs().catch(() => {})
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    button.disabled = false
  }
})

// ------------------------------------------------------------------ batch

$('batchAdd').addEventListener('click', async () => {
  const urls = $('batchInput')
    .value.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (urls.length === 0) {
    toast('Paste at least one link.', 'error')
    return
  }
  const button = $('batchAdd')
  button.disabled = true
  try {
    await api('/api/queue', {
      method: 'POST',
      body: JSON.stringify({urls, mode: $('batchMode').value}),
    })
    $('batchInput').value = ''
    toast(`${urls.length} ${urls.length === 1 ? 'link' : 'links'} added to queue`)
    setTab('queue')
    refreshJobs().catch(() => {})
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    button.disabled = false
  }
})

// ------------------------------------------------------------------ download screen

function openJobStream(jobId) {
  closeJobStream()
  const source = new EventSource(`/api/jobs/${jobId}/events`)
  state.jobStream = source
  source.addEventListener('message', event => {
    let job
    try {
      job = JSON.parse(event.data)
    } catch {
      return
    }
    renderDownload(job)
    if (TERMINAL_STATUSES.includes(job.status)) closeJobStream()
  })
  source.addEventListener('error', () => {
    // EventSource reconnects on its own; polling keeps the screen fresh too.
  })
}

function closeJobStream() {
  if (state.jobStream) {
    state.jobStream.close()
    state.jobStream = null
  }
}

function resetProgress() {
  $('progressBar').classList.remove('indeterminate')
  $('progressBar').style.width = '0%'
  $('progressPct').textContent = ''
  $('progressBytes').textContent = ''
  $('progressSpeed').textContent = ''
  $('progressEta').textContent = ''
  $('downloadStatus').className = 'status-line'
}

function showError(message) {
  closeJobStream()
  $('errorText').textContent = message
  showScreen('screen-error')
}

function setProgress(percent, indeterminate = false) {
  const bar = $('progressBar')
  if (indeterminate) {
    bar.classList.add('indeterminate')
    bar.style.width = '35%'
  } else {
    bar.classList.remove('indeterminate')
    bar.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`
  }
}

function renderDownload(job) {
  if (job.id !== state.currentJobId) return
  setDownloadHeader(job)

  if (job.status === 'error') {
    closeJobStream()
    showError(job.error || job.note || 'The download failed.')
    return
  }

  if (job.status === 'cancelled') {
    setProgress(0)
    $('downloadEyebrow').textContent = 'cancelled'
    $('downloadStatus').className = 'status-line'
    $('downloadStatus').textContent = 'cancelled — nothing was saved.'
    $('cancelJobBtn').classList.add('hidden')
    $('againBtn').classList.remove('hidden')
    $('openFolderBtn').classList.add('hidden')
    return
  }

  if (job.status === 'paused') {
    setProgress(0)
    $('downloadEyebrow').textContent = 'paused'
    $('downloadStatus').className = 'status-line'
    $('downloadStatus').textContent = 'paused — resume it from the queue.'
    $('cancelJobBtn').classList.add('hidden')
    $('againBtn').classList.remove('hidden')
    return
  }

  if (job.status === 'done') {
    setProgress(100)
    $('progressPct').textContent = '100%'
    $('progressBytes').textContent = job.filename || ''
    $('progressSpeed').textContent = ''
    $('progressEta').textContent = ''
    $('downloadEyebrow').textContent = 'done'
    $('downloadStatus').className = 'status-line done'
    $('downloadStatus').textContent = `saved to your Downloads · ${job.filename}${job.note ? ` — ${job.note}` : ''}`
    $('cancelJobBtn').classList.add('hidden')
    $('againBtn').classList.remove('hidden')
    $('openFolderBtn').classList.toggle('hidden', !job.libraryId)
    $('viewLibraryBtn').classList.toggle('hidden', !job.libraryId)
    $('openFolderBtn').dataset.libraryId = job.libraryId ?? ''
    return
  }

  if (job.status === 'queued') {
    setProgress(0, true)
    $('downloadEyebrow').textContent = 'queued'
    $('downloadStatus').className = 'status-line'
    $('downloadStatus').textContent = 'waiting for a free slot…'
    $('cancelJobBtn').classList.remove('hidden')
    return
  }

  if (job.status === 'starting') {
    setProgress(0, true)
    $('downloadEyebrow').textContent = 'starting'
    $('downloadStatus').textContent = job.note || 'reading the link…'
    return
  }

  if (job.status === 'processing' && job.stage === 'transcoding') {
    const percent = job.stageProgress ?? 0
    setProgress(percent)
    $('downloadEyebrow').textContent = 'converting'
    $('progressPct').textContent = `${Math.round(percent)}%`
    $('progressBytes').textContent = ''
    $('progressSpeed').textContent = ''
    $('progressEta').textContent = ''
    $('downloadStatus').textContent = `converting to H.264… ${Math.round(percent)}%`
    return
  }

  if (job.status === 'processing') {
    setProgress(100)
    $('progressPct').textContent = '100%'
    $('downloadEyebrow').textContent = 'processing'
    $('downloadStatus').className = 'status-line'
    $('downloadStatus').textContent = job.kind === 'audio' ? 'converting to mp3…' : 'merging video + audio…'
    return
  }

  const progress = job.progress
  const total = progress && progress.totalBytes > 0 ? progress.totalBytes : 0
  const percent = progress && total ? (progress.downloadedBytes / total) * 100 : 0
  setProgress(percent, !total)
  $('downloadEyebrow').textContent = 'yoinking'
  $('progressPct').textContent = total ? `${Math.min(100, Math.round(percent))}%` : ''
  $('progressBytes').textContent = progress ? fmtBytes(progress.downloadedBytes) + (total ? ` / ${fmtBytes(total)}` : '') : ''
  $('progressSpeed').textContent = progress ? fmtSpeed(progress.speed) : ''
  $('progressEta').textContent = progress && progress.eta ? `eta ${fmtDuration(progress.eta)}` : ''
  if (progress) {
    $('downloadStatus').textContent =
      progress.totalParts > 1 ? `downloading part ${Math.min(progress.part + 1, progress.totalParts)} of ${progress.totalParts}` : 'downloading…'
  }
}

function leaveDownloadScreen() {
  const job = state.jobs.find(entry => entry.id === state.currentJobId)
  const stillRunning = job && ['queued', 'starting', 'downloading', 'processing'].includes(job.status)
  setTab('yoink')
  resetHome()
  if (stillRunning) toast('download continues in the queue')
}

$('backToStartBtn').addEventListener('click', leaveDownloadScreen)

$('cancelJobBtn').addEventListener('click', async () => {
  if (!state.currentJobId) return
  const id = state.currentJobId
  $('cancelJobBtn').disabled = true
  $('downloadStatus').textContent = 'cancelling…'
  try {
    await api(`/api/jobs/${id}/cancel`, {method: 'POST'})
    closeJobStream()
    state.currentJobId = null
    setTab('yoink')
    resetHome()
    toast('download cancelled')
    refreshJobs().catch(() => {})
  } catch (error) {
    toast(error.message, 'error')
    $('cancelJobBtn').disabled = false
    refreshJobs().catch(() => {})
  }
})

$('openFolderBtn').addEventListener('click', () => {
  const id = $('openFolderBtn').dataset.libraryId
  if (!id) return
  api(`/api/library/${id}/reveal`, {method: 'POST'})
    .then(() => toast('opened in your file manager'))
    .catch(error => toast(error.message, 'error'))
})

$('viewLibraryBtn').addEventListener('click', () => {
  setTab('library')
  refreshLibrary().catch(() => {})
})

// ------------------------------------------------------------------ queue

const STATUS_LABEL = {
  queued: 'queued',
  starting: 'starting',
  downloading: 'downloading',
  processing: 'processing',
  paused: 'paused',
  done: 'done',
  error: 'error',
  cancelled: 'cancelled',
}

async function refreshJobs() {
  if (state.refreshingJobs) return
  state.refreshingJobs = true
  try {
    const data = await api('/api/jobs')
    const previous = state.lastStatuses
    state.jobs = data.jobs
    notifyFinished(previous, data.jobs)
    state.lastStatuses = new Map(data.jobs.map(job => [job.id, job.status]))

    const active = data.jobs.filter(job => ['queued', 'starting', 'downloading', 'processing'].includes(job.status)).length
    $('queueCount').textContent = String(active)
    $('queueCount').classList.toggle('hidden', active === 0)
    $('queueMeta').textContent = `${active} active · ${data.jobs.length} total`
    document.title = active > 0 ? `(${active}) yoinks` : 'yoinks — paste. yoink. done.'

    renderQueue()

    if (state.currentJobId) {
      const current = data.jobs.find(job => job.id === state.currentJobId)
      if (current) renderDownload(current)
      else if ($('screen-download').classList.contains('active')) closeJobStream()
    }
  } finally {
    state.refreshingJobs = false
  }
}

function notifyFinished(previous, jobs) {
  if (!state.notify || !('Notification' in window) || Notification.permission !== 'granted') return
  for (const job of jobs) {
    const before = previous.get(job.id)
    if (!before || before === job.status) continue
    try {
      if (job.status === 'done') {
        new Notification('yoinks — saved', {body: job.title || job.filename || 'download finished', icon: '/assets/icon-192.png', tag: job.id})
      } else if (job.status === 'error') {
        new Notification('yoinks — failed', {body: `${job.title || 'download'}\n${job.error || ''}`.trim(), icon: '/assets/icon-192.png', tag: job.id})
      }
    } catch {
      // some mobile browsers only support notifications through a service worker
    }
  }
}

function statusPill(job) {
  const label = job.stage === 'transcoding' ? 'converting' : STATUS_LABEL[job.status] ?? job.status
  return el('span', `status-pill status-${job.status}`, label)
}

function progressInfo(job) {
  if (job.stage === 'transcoding') {
    const percent = job.stageProgress ?? 0
    return {percent, indeterminate: false, text: `converting to H.264… ${Math.round(percent)}%`}
  }
  if (job.status === 'queued') return {percent: 0, indeterminate: true, text: 'waiting for a free slot…'}
  if (job.status === 'starting') return {percent: 0, indeterminate: true, text: job.note || 'reading the link…'}
  if (job.status === 'processing') {
    return {percent: 100, indeterminate: false, text: job.kind === 'audio' ? 'converting to mp3…' : 'merging video + audio…'}
  }
  const progress = job.progress
  if (!progress) return null
  const total = progress.totalBytes > 0 ? progress.totalBytes : 0
  const percent = total ? (progress.downloadedBytes / total) * 100 : 0
  const parts = progress.totalParts > 1 ? ` · part ${Math.min(progress.part + 1, progress.totalParts)}/${progress.totalParts}` : ''
  const bytes = fmtBytes(progress.downloadedBytes) + (total ? ` / ${fmtBytes(total)}` : '')
  const speed = fmtSpeed(progress.speed)
  const eta = progress.eta ? `eta ${fmtDuration(progress.eta)}` : ''
  return {
    percent,
    indeterminate: !total,
    text: [bytes, speed, eta].filter(Boolean).join(' · ') + parts,
  }
}

function renderQueue() {
  const list = $('jobList')
  list.replaceChildren()
  const jobs = state.jobs
  $('queueEmpty').classList.toggle('hidden', jobs.length > 0)
  $('clearFinished').classList.toggle('hidden', !jobs.some(job => TERMINAL_STATUSES.includes(job.status)))

  for (const job of jobs) {
    const card = el('article', 'job-card')

    const wrap = el('div', 'thumb-wrap')
    if (job.thumbnail) {
      const image = document.createElement('img')
      image.src = job.thumbnail
      image.alt = ''
      image.loading = 'lazy'
      image.referrerPolicy = 'no-referrer'
      image.onerror = () => wrap.classList.add('empty')
      wrap.append(image)
    } else {
      wrap.classList.add('empty')
    }

    const body = el('div', 'job-body')
    const topline = el('div', 'job-topline')
    const title = el('h3', 'job-title', job.title || job.url)
    topline.append(statusPill(job), title)
    body.append(topline)

    const meta = el('p', 'job-sub', [job.format, job.size ? fmtBytes(job.size) : '', fmtDate(job.createdAt)].filter(Boolean).join(' · '))
    body.append(meta)

    const info = progressInfo(job)
    if (info && ['queued', 'starting', 'downloading', 'processing'].includes(job.status)) {
      const progress = el('div', 'job-progress')
      const shell = el('div', 'progress-shell')
      const bar = el('div', 'progress-bar')
      if (info.indeterminate) bar.classList.add('indeterminate')
      else bar.style.width = `${Math.max(0, Math.min(100, info.percent))}%`
      shell.append(bar)
      const line = el('div', 'progress-meta')
      line.append(el('span', 'pct', info.indeterminate ? '' : `${Math.round(info.percent)}%`), el('span', '', info.text))
      progress.append(shell, line)
      body.append(progress)
    }

    if (job.note) body.append(el('p', `job-note${job.status === 'error' ? ' error' : ''}`, job.note))
    if (job.error && job.status === 'error' && job.error !== job.note) body.append(el('p', 'job-note error', job.error))

    const actions = el('div', 'job-actions')

    const action = (label, handler) => {
      const button = el('button', 'link-btn', label)
      button.type = 'button'
      button.addEventListener('click', handler)
      actions.append(button)
    }

    if (job.status === 'queued' || job.status === 'starting' || job.status === 'downloading') {
      action('pause', () => jobAction(job.id, 'pause'))
      action('cancel', () => jobAction(job.id, 'cancel'))
    } else if (job.status === 'processing') {
      action('cancel', () => jobAction(job.id, 'cancel'))
    } else if (job.status === 'paused') {
      action('resume', () => jobAction(job.id, 'resume'))
      action('cancel', () => jobAction(job.id, 'cancel'))
      action('remove', () => removeJob(job.id))
    } else if (job.status === 'error' || job.status === 'cancelled') {
      action('retry', () => jobAction(job.id, 'retry'))
      action('remove', () => removeJob(job.id))
    } else if (job.status === 'done') {
      if (job.libraryId) action('open folder', () => libraryAction(job.libraryId, 'reveal'))
      action('remove', () => removeJob(job.id))
    }

    card.append(wrap, body, actions)
    list.append(card)
  }
}

async function jobAction(id, action) {
  try {
    await api(`/api/jobs/${id}/${action}`, {method: 'POST'})
    toast(action === 'cancel' ? 'removed from queue' : `job ${action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'queued again'}`)
    if (state.currentJobId === id && action === 'cancel') {
      state.currentJobId = null
      closeJobStream()
      resetHome()
    }
    refreshJobs().catch(() => {})
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function removeJob(id) {
  if (!confirm('Remove this job from the queue? The downloaded file (if any) stays in your library.')) return
  try {
    await api(`/api/jobs/${id}`, {method: 'DELETE'})
    if (state.currentJobId === id) {
      closeJobStream()
      state.currentJobId = null
      showScreen('screen-home')
    }
    toast('job removed')
    refreshJobs().catch(() => {})
  } catch (error) {
    toast(error.message, 'error')
  }
}

$('clearFinished').addEventListener('click', async () => {
  const finished = state.jobs.filter(job => TERMINAL_STATUSES.includes(job.status))
  if (finished.length === 0) return
  if (!confirm(`Remove ${finished.length} finished ${finished.length === 1 ? 'job' : 'jobs'} from the queue? Files stay in your library.`)) return
  try {
    await Promise.all(finished.map(job => api(`/api/jobs/${job.id}`, {method: 'DELETE'})))
    toast('finished jobs cleared')
    refreshJobs().catch(() => {})
  } catch (error) {
    toast(error.message, 'error')
  }
})

$('queueAddBtn').addEventListener('click', startNew)
$('libraryAddBtn').addEventListener('click', startNew)

// ------------------------------------------------------------------ library

async function refreshLibrary() {
  try {
    const data = await api('/api/library')
    state.library = data.items
    if (state.tab === 'library' || $('panel-library').classList.contains('active')) renderLibrary()
  } catch {
    // keep the previous list
  }
}

function renderLibrary() {
  const list = $('libraryList')
  list.replaceChildren()
  const query = state.libraryQuery.trim().toLowerCase()
  const items = state.library.filter(item => {
    if (!query) return true
    return `${item.title} ${item.uploader ?? ''} ${item.format} ${item.filename}`.toLowerCase().includes(query)
  })
  $('libraryEmpty').classList.toggle('hidden', items.length > 0)
  $('libraryEmpty').querySelector('p').textContent = state.library.length === 0 ? 'Nothing saved yet.' : 'Nothing matches that search.'

  for (const item of items) {
    const card = el('article', 'library-card')

    const wrap = el('div', 'thumb-wrap')
    if (item.thumbnail) {
      const image = document.createElement('img')
      image.src = item.thumbnail
      image.alt = ''
      image.loading = 'lazy'
      image.referrerPolicy = 'no-referrer'
      image.onerror = () => wrap.classList.add('empty')
      wrap.append(image)
    } else {
      wrap.classList.add('empty')
    }

    const body = el('div', 'library-body')
    body.append(el('h3', 'library-title', item.title || item.filename))
    const metaParts = [
      item.uploader,
      item.format,
      item.codec,
      item.size ? fmtBytes(item.size) : '',
      item.createdAt ? fmtDate(item.createdAt) : '',
    ].filter(Boolean)
    body.append(el('p', 'library-meta', metaParts.join(' · ')))
    if (item.exists === false) body.append(el('p', 'library-meta library-missing', 'file is missing from disk'))

    const actions = el('div', 'library-actions')
    const add = (label, handler, disabled = false) => {
      const button = el('button', 'link-btn', label)
      button.type = 'button'
      button.disabled = disabled
      button.addEventListener('click', handler)
      actions.append(button)
    }

    add('play', () => openPreview(item), item.exists === false)
    add('open', () => libraryAction(item.id, 'open'), item.exists === false)
    add('reveal', () => libraryAction(item.id, 'reveal'), item.exists === false)
    add('redownload', () => redownloadItem(item))
    add('delete', () => deleteLibraryItem(item))

    card.append(wrap, body, actions)
    list.append(card)
  }
}

async function libraryAction(id, action) {
  try {
    await api(`/api/library/${id}/${action}`, {method: 'POST'})
    if (action === 'reveal') toast('opened in your file manager')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function redownloadItem(item) {
  try {
    await api(`/api/library/${item.id}/redownload`, {method: 'POST'})
    toast('added to queue')
    setTab('queue')
    refreshJobs().catch(() => {})
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function deleteLibraryItem(item) {
  const deleteFile = confirm('Delete the file from disk as well?\n\nOK = remove the file, Cancel = keep it on disk')
  try {
    await api(`/api/library/${item.id}${deleteFile ? '?file=1' : ''}`, {method: 'DELETE'})
    toast(deleteFile ? 'file deleted' : 'removed from library')
    refreshLibrary().catch(() => {})
  } catch (error) {
    toast(error.message, 'error')
  }
}

$('librarySearch').addEventListener('input', event => {
  state.libraryQuery = event.target.value
  renderLibrary()
})

function openPreview(item) {
  $('modalTitle').textContent = item.title || item.filename
  const media = $('modalMedia')
  media.replaceChildren()
  const element = document.createElement(item.kind === 'audio' ? 'audio' : 'video')
  element.controls = true
  element.autoplay = true
  element.playsInline = true
  element.src = `/api/library/${item.id}/media`
  media.append(element)
  $('modal').classList.remove('hidden')
}

function closeModal() {
  const media = $('modalMedia')
  for (const element of media.querySelectorAll('video,audio')) {
    element.pause()
    element.removeAttribute('src')
    element.load()
  }
  media.replaceChildren()
  $('modal').classList.add('hidden')
}

$('modalClose').addEventListener('click', closeModal)
$('modal').addEventListener('click', event => {
  if (event.target.dataset.close) closeModal()
})

// ------------------------------------------------------------------ settings

async function loadSettings() {
  try {
    state.settings = await api('/api/settings')
    fillSettings()
  } catch (error) {
    toast(error.message, 'error')
  }
}

function fillSettings() {
  const settings = state.settings
  if (!settings) return
  $('setOutDir').value = settings.outDir ?? ''
  $('setConcurrency').value = String(settings.concurrency ?? 2)
  $('setCookies').value = settings.cookiesFromBrowser ?? ''
  $('setTranscode').checked = settings.autoTranscode !== false
  $('setWebhook').value = settings.webhookUrl ?? ''
  $('setNotify').checked = state.notify
}

$('settingsForm').addEventListener('submit', async event => {
  event.preventDefault()
  const button = $('settingsForm').querySelector('button[type="submit"]')
  button.disabled = true
  try {
    state.settings = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        outDir: $('setOutDir').value,
        concurrency: Number($('setConcurrency').value),
        cookiesFromBrowser: $('setCookies').value,
        autoTranscode: $('setTranscode').checked,
        webhookUrl: $('setWebhook').value,
      }),
    })
    $('settingsSaved').textContent = 'saved'
    setTimeout(() => ($('settingsSaved').textContent = ''), 2500)
    toast('settings saved')
    refreshDiagnostics().catch(() => {})
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    button.disabled = false
  }
})

$('setNotify').addEventListener('change', async event => {
  const enabled = event.target.checked
  if (enabled && 'Notification' in window && Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      event.target.checked = false
      toast('notifications are blocked by the browser', 'error')
      return
    }
  }
  state.notify = enabled
  localStorage.setItem('yoinks-notify', enabled ? '1' : '0')
})

// ------------------------------------------------------------------ diagnostics

async function refreshDiagnostics() {
  try {
    const data = await api('/api/diagnostics')
    state.diagnostics = data
    renderDiagnostics(data)
  } catch {
    // ignore
  }
}

function renderDiagnostics(data) {
  const grid = $('diagGrid')
  grid.replaceChildren()
  const rows = [
    ['node', data.node],
    ['platform', data.platform],
    ['yt-dlp', `${data.ytdlp.version ?? 'unknown'} · ${data.ytdlp.path ?? '—'}`],
    ['ffmpeg', `${data.ffmpeg.version ?? 'unknown'} · ${data.ffmpeg.path ?? '—'}`],
    ['output', data.outDir],
    ['state', data.stateFile],
    ['jobs', `${data.counts.jobs} (${data.counts.active} active)`],
    ['library', String(data.counts.library)],
  ]
  for (const [key, value] of rows) {
    grid.append(el('span', 'diag-key', key), el('span', 'diag-value', String(value)))
  }

  const lan = $('lanCard')
  lan.replaceChildren()
  const reachableLan = data.host !== '127.0.0.1' && data.host !== 'localhost' && data.lanUrl
  const qr = el('div', 'qr')
  const image = document.createElement('img')
  image.alt = 'QR code for the web interface'
  image.src = `/api/qr?text=${encodeURIComponent(reachableLan ? data.lanUrl : (data.urls[0] ?? data.qrTarget))}`
  qr.append(image)

  const copy = el('div', 'lan-copy')
  if (reachableLan) {
    copy.append(el('p', 'eyebrow', 'open on your phone'))
    const link = el('a', '', data.lanUrl)
    link.href = data.lanUrl
    link.target = '_blank'
    link.rel = 'noopener'
    copy.append(link)
    copy.append(el('p', 'hint', 'Same Wi-Fi required. The queue and library are shared.'))
  } else {
    copy.append(el('p', 'eyebrow', 'open on your phone'))
    copy.append(el('p', 'job-note', `Bound to ${data.host}. Restart with --host 0.0.0.0 to reach it from another device, then this space shows a QR code for the LAN address.`))
    const link = el('a', '', data.urls[0] ?? '')
    link.href = data.urls[0] ?? '#'
    copy.append(link)
  }
  lan.append(qr, copy)
}

$('updateYtdlp').addEventListener('click', async () => {
  const button = $('updateYtdlp')
  button.disabled = true
  button.textContent = 'updating…'
  try {
    const result = await api('/api/diagnostics/update-ytdlp', {method: 'POST'})
    toast(`yt-dlp updated to ${result.version ?? 'the latest version'}`)
    refreshDiagnostics().catch(() => {})
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    button.disabled = false
    button.textContent = 'update yt-dlp'
  }
})

// ------------------------------------------------------------------ PWA

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault()
  state.installPrompt = event
  $('installBtn').classList.remove('hidden')
})

$('installBtn').addEventListener('click', async () => {
  if (!state.installPrompt) return
  state.installPrompt.prompt()
  try {
    await state.installPrompt.userChoice
  } finally {
    state.installPrompt = null
    $('installBtn').classList.add('hidden')
  }
})

// ------------------------------------------------------------------ global events + polling

function connectEvents() {
  const source = new EventSource('/api/events')
  source.addEventListener('message', event => {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (data.type === 'jobs' || data.type === 'hello') refreshJobs().catch(() => {})
    if (data.type === 'library') refreshLibrary().catch(() => {})
    if (data.type === 'settings' && state.tab === 'settings') {
      state.settings = data.settings ?? state.settings
      fillSettings()
    }
    if (data.type === 'diagnostics' && state.tab === 'settings') refreshDiagnostics().catch(() => {})
  })
  source.addEventListener('error', () => {
    // the browser retries automatically
  })
}

// ------------------------------------------------------------------ keyboard

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!$('modal').classList.contains('hidden')) {
      closeModal()
      return
    }
    const active = document.querySelector('.screen.active')?.id
    if (active === 'screen-home') {
      urlInput.value = ''
      setHint(DEFAULT_HINT)
    } else if (active === 'screen-pick' || active === 'screen-playlist' || active === 'screen-error') {
      resetHome()
    }
    return
  }

  if (event.key === '/' && document.querySelector('.screen.active')?.id === 'screen-home' && document.activeElement !== urlInput) {
    event.preventDefault()
    urlInput.focus()
  }
})

// ------------------------------------------------------------------ init

async function init() {
  const params = new URL(location.href).searchParams
  const tab = params.get('tab') ?? 'yoink'
  setTab(tab)
  $('setNotify').checked = state.notify

  const shared = params.get('url') || params.get('text') || ''
  const sharedUrl = shared.match(/https?:\/\/[^\s]+/)
  if (sharedUrl) {
    urlInput.value = sharedUrl[0]
    setHint('shared link ready — press enter')
  }

  if (state.tab === 'yoink') urlInput.focus()
  await loadSettings().catch(() => {})
  await refreshJobs().catch(() => {})
  if (state.tab === 'library') await refreshLibrary().catch(() => {})
  if (state.tab === 'settings') await refreshDiagnostics().catch(() => {})
  connectEvents()
  setInterval(() => refreshJobs().catch(() => {}), 1500)
}

void init()
