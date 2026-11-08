import {spawn, type ChildProcess} from 'node:child_process'
import {createReadStream, statSync} from 'node:fs'
import fs from 'node:fs/promises'
import http, {type IncomingMessage, type ServerResponse} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import QRCode from 'qrcode'
import {
  buildChoices,
  defaultChoice,
  download,
  ensureYtDlp,
  findFfmpeg,
  forceUpdateYtDlp,
  getBinaryVersion,
  inspectMedia,
  probe,
  transcodeToH264,
  type DownloadChoice,
  type DownloadOptions,
  type DownloadProgress,
  type ProbeResult,
} from './lib/ytdlp.js'
import {
  loadState,
  normalizeState,
  saveNow,
  scheduleSave,
  stateFilePath,
  type JobStatus,
  type LibraryItem,
  type Settings,
  type State,
  type StoredJob,
} from './lib/store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB_DIR = path.join(ROOT, 'web')
const ASSETS_DIR = path.join(ROOT, 'assets')

const SESSION_TTL = 30 * 60_000
const JOB_HISTORY = 100

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const port = Number(argValue('--port') ?? process.env.PORT ?? 4321)
const host = argValue('--host') ?? process.env.HOST ?? '127.0.0.1'
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error('[yoinks] --port must be a number between 1 and 65535.')
  process.exit(1)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 2_000_000) throw new HttpError(413, 'Request body is too large.')
  }
  if (!body) return {}
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'Expected a JSON object.')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'Invalid JSON.')
  }
}

function parseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Paste a video link first.')
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new HttpError(400, 'Only http and https links are supported.')
    }
    return url.href
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'That doesn’t look like a valid link.')
  }
}

function argList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function downloadOptionArgs(options: DownloadOptions | undefined): string[] {
  if (!options) return []
  const args: string[] = []
  if (options.subtitles) args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'all', '--embed-subs')
  if (options.thumbnail) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg')
  if (options.metadata) args.push('--embed-metadata')
  if (options.chapters) args.push('--embed-chapters')
  return args
}

function parseOptions(value: unknown): DownloadOptions {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  return {
    subtitles: asBoolean(source.subtitles),
    thumbnail: asBoolean(source.thumbnail),
    metadata: asBoolean(source.metadata),
    chapters: asBoolean(source.chapters),
  }
}

// ---------------------------------------------------------------------------
// state, settings, sessions
// ---------------------------------------------------------------------------

let state: State = loadState()
const outOverride = argValue('--out')
if (outOverride) state.settings.outDir = path.resolve(outOverride)
const concurrencyOverride = Number(argValue('--concurrency'))
if (Number.isFinite(concurrencyOverride)) state.settings.concurrency = Math.min(5, Math.max(1, Math.round(concurrencyOverride)))
state = normalizeState(state)
scheduleSave(state)

type Session = {
  id: string
  url: string
  probe: ProbeResult
  choices: DownloadChoice[]
  createdAt: number
  touchedAt: number
}

const sessions = new Map<string, Session>()

function createSession(url: string, result: ProbeResult): Session {
  const session: Session = {
    id: randomUUID(),
    url,
    probe: result,
    choices: buildChoices(result.info),
    createdAt: Date.now(),
    touchedAt: Date.now(),
  }
  sessions.set(session.id, session)
  return session
}

async function pruneSessions(): Promise<void> {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.touchedAt < SESSION_TTL) continue
    sessions.delete(id)
    const inUse = state.jobs.some(job => job.infoJsonPath === session.probe.infoJsonPath)
    if (!inUse) await fs.rm(session.probe.infoJsonPath, {force: true}).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// yt-dlp / ffmpeg bootstrap
// ---------------------------------------------------------------------------

let ytdlpPromise: Promise<string> | undefined

function getYtDlp(): Promise<string> {
  ytdlpPromise ??= ensureYtDlp(message => console.log(`[yoinks] ${message}`)).catch(error => {
    ytdlpPromise = undefined
    throw error
  })
  return ytdlpPromise
}

async function updateYtDlp(): Promise<string> {
  const resolved = await forceUpdateYtDlp(message => console.log(`[yoinks] ${message}`))
  ytdlpPromise = Promise.resolve(resolved)
  return resolved
}

// ---------------------------------------------------------------------------
// runtime, queue and SSE
// ---------------------------------------------------------------------------

type Runtime = {
  controller: AbortController
  child?: ChildProcess
  pauseRequested: boolean
  cancelRequested: boolean
  promise: Promise<void>
}

const runtimes = new Map<string, Runtime>()
const jobClients = new Map<string, Set<ServerResponse>>()
const eventClients = new Set<ServerResponse>()

function findJob(id: string): StoredJob | undefined {
  return state.jobs.find(job => job.id === id)
}

function jobSnapshot(job: StoredJob) {
  return {
    id: job.id,
    url: job.url,
    title: job.title,
    uploader: job.uploader,
    thumbnail: job.thumbnail,
    duration: job.duration,
    extractor: job.extractor,
    kind: job.kind,
    format: job.format,
    codec: job.codec,
    compatible: job.compatible,
    width: job.width,
    height: job.height,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    stageProgress: job.stageProgress,
    note: job.note,
    error: job.error,
    filename: job.filename,
    size: job.size,
    libraryId: job.libraryId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    downloadUrl: job.status === 'done' && job.filepath ? `/api/jobs/${job.id}/file` : undefined,
  }
}

function broadcastJob(job: StoredJob): void {
  const clients = jobClients.get(job.id)
  if (!clients || clients.size === 0) return
  const payload = `data: ${JSON.stringify(jobSnapshot(job))}\n\n`
  for (const client of clients) client.write(payload)
}

function broadcastEvent(type: 'jobs' | 'library' | 'settings' | 'diagnostics', extra: Record<string, unknown> = {}): void {
  if (eventClients.size === 0) return
  const payload = `data: ${JSON.stringify({type, ...extra})}\n\n`
  for (const client of eventClients) client.write(payload)
}

function closeJobStreams(id: string): void {
  const clients = jobClients.get(id)
  if (!clients) return
  for (const client of clients) client.end()
  jobClients.delete(id)
}

function trimHistory(): void {
  const active = state.jobs.filter(job => !['done', 'error', 'cancelled'].includes(job.status))
  const finished = state.jobs.filter(job => ['done', 'error', 'cancelled'].includes(job.status)).slice(0, JOB_HISTORY)
  state.jobs = [...active, ...finished]
}

function addToLibrary(job: StoredJob): void {
  if (!job.filepath || !job.filename) return
  const item: LibraryItem = {
    id: randomUUID(),
    jobId: job.id,
    url: job.url,
    title: job.title,
    uploader: job.uploader,
    thumbnail: job.thumbnail,
    duration: job.duration,
    extractor: job.extractor,
    filename: job.filename,
    filepath: job.filepath,
    size: job.size ?? 0,
    format: job.format,
    codec: job.codec,
    kind: job.kind,
    createdAt: Date.now(),
  }
  state.library = [item, ...state.library.filter(existing => existing.filepath !== item.filepath)].slice(0, 1000)
  job.libraryId = item.id
}

async function fireWebhook(job: StoredJob): Promise<void> {
  const target = state.settings.webhookUrl.trim()
  if (!target) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  timer.unref?.()
  try {
    await fetch(target, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({event: job.status, job: jobSnapshot(job)}),
      signal: controller.signal,
    })
  } catch {
    // webhooks are best effort
  } finally {
    clearTimeout(timer)
  }
}

function pump(): void {
  while (runtimes.size < state.settings.concurrency) {
    const job = state.jobs.find(candidate => candidate.status === 'queued')
    if (!job) break
    job.status = 'starting'
    job.startedAt = Date.now()
    job.error = undefined
    job.note = undefined
    job.stage = undefined
    job.stageProgress = undefined
    job.progress = undefined

    const controller = new AbortController()
    const runtime: Runtime = {controller, pauseRequested: false, cancelRequested: false, promise: Promise.resolve()}
    runtimes.set(job.id, runtime)
    scheduleSave(state)
    broadcastEvent('jobs')
    broadcastJob(job)

    runtime.promise = runJob(job, runtime)
      .catch(error => console.error('[yoinks] job crashed:', error))
      .finally(() => {
        runtimes.delete(job.id)
        trimHistory()
        scheduleSave(state)
        broadcastEvent('jobs')
        broadcastJob(job)
        pump()
      })
  }
}

async function runJob(job: StoredJob, runtime: Runtime): Promise<void> {
  let stage: 'download' | 'transcode' = 'download'
  let outputPath: string | undefined
  const stillWanted = () =>
    state.jobs.includes(job) &&
    !runtime.cancelRequested &&
    !runtime.pauseRequested &&
    !runtime.controller.signal.aborted &&
    !['done', 'error', 'cancelled', 'paused'].includes(job.status)
  try {
    const [ytdlp, ffmpeg] = await Promise.all([getYtDlp(), findFfmpeg()])
    if (runtime.controller.signal.aborted) throw new Error('Download cancelled.')
    await fs.mkdir(job.outDir, {recursive: true})

    let choice: DownloadChoice
    if (job.choiceArgs) {
      choice = {
        label: job.format,
        kind: job.kind,
        args: job.choiceArgs,
        codec: job.codec,
        compatible: job.compatible,
        width: job.width,
        height: job.height,
      }
    } else {
      job.note = 'reading the link…'
      broadcastJob(job)
      const result = await probe(ytdlp, job.url, {
        signal: runtime.controller.signal,
        cookiesFromBrowser: state.settings.cookiesFromBrowser,
      })
      const info = result.info
      if (info._type === 'playlist') {
        throw new Error('This link is a playlist. Open it as a playlist and queue its entries separately.')
      }
      const choices = buildChoices(info)
      const picked = defaultChoice(choices, job.autoMode ?? job.kind)
      if (!picked) throw new Error('No downloadable formats were found.')
      choice = picked
      job.title = info.title || job.title
      job.uploader = info.uploader ?? job.uploader
      job.thumbnail = info.thumbnail ?? job.thumbnail
      job.duration = info.duration ?? job.duration
      job.extractor = info.extractor_key ?? job.extractor
      job.kind = picked.kind
      job.format = picked.label
      job.codec = picked.codec
      job.compatible = picked.compatible
      job.width = picked.width
      job.height = picked.height
      job.choiceArgs = picked.args
      job.infoJsonPath = result.infoJsonPath
      job.note = undefined
      broadcastJob(job)
      broadcastEvent('jobs')
      scheduleSave(state)
    }

    stage = 'download'
    const filepath = await download(
      {
        ytdlp,
        ffmpegLocation: ffmpeg,
        url: job.url,
        infoJsonPath: job.infoJsonPath,
        choice,
        outDir: job.outDir,
        extraArgs: downloadOptionArgs(job.options),
        keepPartials: () => runtime.pauseRequested,
        cancelled: () => runtime.cancelRequested,
        cookiesFromBrowser: state.settings.cookiesFromBrowser,
      },
      {
        onProgress: progress => {
          // the child process can flush a few progress lines after an abort;
          // never let those resurrect a cancelled/paused/removed job
          if (!stillWanted()) return
          if (job.status !== 'downloading') broadcastEvent('jobs')
          job.status = 'downloading'
          job.progress = progress
          broadcastJob(job)
        },
        onProcessing: () => {
          if (!stillWanted()) return
          job.status = 'processing'
          job.progress = job.progress ?? {downloadedBytes: 0, part: 0, totalParts: 1}
          broadcastJob(job)
          broadcastEvent('jobs')
        },
        onChild: child => {
          runtime.child = child
        },
      },
      runtime.controller.signal,
    )

    let finalPath = filepath
    outputPath = finalPath

    if (runtime.cancelRequested || runtime.controller.signal.aborted) throw new Error('Download cancelled.')

    const media = choice.kind === 'video' ? await inspectMedia(ffmpeg ?? 'ffmpeg', finalPath) : undefined
    let needsCompat = choice.kind === 'video' && choice.compatible === false
    if (media?.recognized) {
      if (!media.video) {
        job.note = 'No video track was found — only the audio track was available for this post.'
        needsCompat = false
      } else if (media.video === 'h264' || media.video === 'avc1') {
        needsCompat = false
      } else {
        needsCompat = true
      }
    }

    const pixels = (choice.width ?? 0) * (choice.height ?? 0)
    const smallEnough = pixels > 0 ? pixels <= 1920 * 1080 * 1.5 : (choice.height ?? 0) <= 1080
    const withinTime = job.duration === undefined || job.duration <= 15 * 60

    if (needsCompat && state.settings.autoTranscode && smallEnough && withinTime) {
      stage = 'transcode'
      job.status = 'processing'
      job.stage = 'transcoding'
      job.stageProgress = 0
      broadcastJob(job)
      broadcastEvent('jobs')
      try {
        finalPath = await transcodeToH264(ffmpeg ?? 'ffmpeg', finalPath, {
          duration: job.duration,
          signal: runtime.controller.signal,
          onProgress: percent => {
            if (!stillWanted()) return
            job.stageProgress = percent
            broadcastJob(job)
          },
        })
        outputPath = finalPath
      } catch (error) {
        if (runtime.controller.signal.aborted) throw error
        job.note = `Kept the original ${media?.video ?? choice.codec ?? 'non-H.264'} file — converting to H.264 failed: ${errorMessage(error)}`
      } finally {
        job.stage = undefined
        job.stageProgress = undefined
      }
    } else if (needsCompat && !state.settings.autoTranscode) {
      job.note = `This file is ${media?.video ?? choice.codec ?? 'not H.264'} — conversion is disabled in settings.`
    } else if (needsCompat) {
      job.note = `This file is ${media?.video ?? choice.codec ?? 'not H.264'} — use VLC or install a codec pack if it does not play.`
    }

    const size = await fileSize(finalPath)
    job.status = 'done'
    job.filepath = finalPath
    job.filename = path.basename(finalPath)
    job.size = size
    job.finishedAt = Date.now()
    job.progress = undefined
    job.error = undefined
    addToLibrary(job)
    scheduleSave(state)
    broadcastJob(job)
    broadcastEvent('library')
    broadcastEvent('jobs')
    void fireWebhook(job)
  } catch (error) {
    if (runtime.pauseRequested) {
      job.status = 'paused'
      job.note = 'Paused — press resume to continue.'
    } else if (runtime.cancelRequested || runtime.controller.signal.aborted) {
      job.status = 'cancelled'
      job.note = 'Download cancelled.'
      // a cancel removes the job from the queue, so also remove a fully
      // downloaded file that was waiting for conversion
      if (outputPath) await fs.rm(outputPath, {force: true}).catch(() => {})
    } else {
      job.status = 'error'
      job.error = errorMessage(error)
      job.note = stage === 'transcode' ? 'The file was downloaded, but converting it failed.' : undefined
    }
    job.progress = undefined
    job.stage = undefined
    job.stageProgress = undefined
    job.finishedAt = Date.now()
    scheduleSave(state)
    broadcastJob(job)
    broadcastEvent('jobs')
    if (job.status === 'error') void fireWebhook(job)
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// job actions
// ---------------------------------------------------------------------------

function killRuntime(runtime: Runtime): void {
  const child = runtime.child
  if (!child?.pid) {
    runtime.controller.abort()
    return
  }
  if (process.platform === 'win32') {
    // The standalone yt-dlp.exe is a PyInstaller bootloader: it spawns the
    // real worker as a child, so killing only the bootloader orphans the
    // download. taskkill /T kills the whole tree before Node aborts.
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true})
      killer.on('error', () => {})
    } catch {
      // fall through to the abort below
    }
    setTimeout(() => runtime.controller.abort(), 750).unref?.()
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
  runtime.controller.abort()
}

function pauseJob(job: StoredJob): void {
  const runtime = runtimes.get(job.id)
  if (runtime) {
    runtime.pauseRequested = true
    killRuntime(runtime)
    return
  }
  if (job.status === 'queued') {
    job.status = 'paused'
    job.note = 'Paused.'
    broadcastJob(job)
    broadcastEvent('jobs')
    scheduleSave(state)
  }
}

function resumeJob(job: StoredJob): void {
  if (runtimes.has(job.id)) return
  if (job.status !== 'paused' && job.status !== 'error' && job.status !== 'cancelled') return
  job.status = 'queued'
  job.error = undefined
  job.note = undefined
  job.progress = undefined
  job.stage = undefined
  job.stageProgress = undefined
  job.finishedAt = undefined
  broadcastJob(job)
  broadcastEvent('jobs')
  scheduleSave(state)
  pump()
}

function cancelJob(job: StoredJob): void {
  // Cancelling means "I don't want this anymore": abort the process and drop
  // the record from the queue immediately. Completed files stay in the library.
  deleteJob(job)
}

function deleteJob(job: StoredJob): void {
  const runtime = runtimes.get(job.id)
  if (runtime) {
    runtime.cancelRequested = true
    killRuntime(runtime)
  }
  state.jobs = state.jobs.filter(existing => existing.id !== job.id)
  closeJobStreams(job.id)
  if (job.infoJsonPath) void fs.rm(job.infoJsonPath, {force: true}).catch(() => {})
  broadcastEvent('jobs')
  scheduleSave(state)
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 2000\n\n')
}

function openJobStream(req: IncomingMessage, res: ServerResponse, job: StoredJob): void {
  sseHeaders(res)
  res.write(`data: ${JSON.stringify(jobSnapshot(job))}\n\n`)
  let clients = jobClients.get(job.id)
  if (!clients) {
    clients = new Set()
    jobClients.set(job.id, clients)
  }
  clients.add(res)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
  heartbeat.unref()
  const cleanup = () => {
    clearInterval(heartbeat)
    clients?.delete(res)
    if (clients && clients.size === 0) jobClients.delete(job.id)
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

function openEventStream(req: IncomingMessage, res: ServerResponse): void {
  sseHeaders(res)
  res.write(`data: ${JSON.stringify({type: 'hello', settings: state.settings})}\n\n`)
  eventClients.add(res)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000)
  heartbeat.unref()
  const cleanup = () => {
    clearInterval(heartbeat)
    eventClients.delete(res)
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

function serveFile(req: IncomingMessage, res: ServerResponse, filePath: string, filename: string, inline: boolean): void {
  let stat
  try {
    stat = statSync(filePath)
  } catch {
    throw new HttpError(404, 'That file is no longer on disk.')
  }

  const mime = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_')
  const disposition = `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  const range = req.headers.range

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match) {
      const start = match[1] ? Number(match[1]) : 0
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1
      if (Number.isFinite(start) && start <= end && start < stat.size) {
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': disposition,
          'Cache-Control': 'no-store',
        })
        createReadStream(filePath, {start, end}).pipe(res)
        return
      }
    }
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': disposition,
    'Cache-Control': 'no-store',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}

function isInsideAllowed(target: string): boolean {
  const resolved = path.resolve(target)
  const dirs = [state.settings.outDir, ...state.jobs.map(job => job.outDir), ...state.library.map(item => path.dirname(item.filepath))]
  return dirs.some(dir => resolved === dir || resolved.startsWith(dir + path.sep))
}

function openNative(target: string, reveal: boolean): void {
  if (!isInsideAllowed(target)) throw new HttpError(403, 'That path is outside the download folders.')
  let command: string
  let args: string[]
  if (process.platform === 'win32') {
    // `/select,<path>` is unreliable with quoted paths (Explorer falls back to
    // Documents). Opening the containing folder always works.
    command = 'explorer.exe'
    args = [reveal ? path.dirname(target) : target]
  } else if (process.platform === 'darwin') {
    command = 'open'
    args = reveal ? ['-R', target] : [target]
  } else {
    command = 'xdg-open'
    args = [reveal ? path.dirname(target) : target]
  }
  try {
    spawn(command, args, {detached: true, stdio: 'ignore'}).unref()
  } catch {
    throw new HttpError(500, 'Could not open that path.')
  }
}

// ---------------------------------------------------------------------------
// settings and diagnostics
// ---------------------------------------------------------------------------

const BROWSERS = new Set(['', 'brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale'])

function readSettings(body: Record<string, unknown>): Settings {
  const next: Settings = {...state.settings}
  if (typeof body.outDir === 'string') {
    let value = body.outDir.trim()
    if (!value) throw new HttpError(400, 'The output folder cannot be empty.')
    if (value === '~') value = os.homedir()
    else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2))
    next.outDir = path.resolve(value)
  }
  if (body.concurrency !== undefined) {
    const value = Math.round(Number(body.concurrency))
    if (!Number.isFinite(value) || value < 1 || value > 5) throw new HttpError(400, 'Concurrency must be between 1 and 5.')
    next.concurrency = value
  }
  if (typeof body.cookiesFromBrowser === 'string') {
    const value = body.cookiesFromBrowser.trim().toLowerCase()
    if (!BROWSERS.has(value)) throw new HttpError(400, 'Unknown browser for cookies.')
    next.cookiesFromBrowser = value
  }
  if (typeof body.autoTranscode === 'boolean') next.autoTranscode = body.autoTranscode
  if (typeof body.webhookUrl === 'string') {
    const value = body.webhookUrl.trim()
    if (value) {
      try {
        const parsed = new URL(value)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
      } catch {
        throw new HttpError(400, 'The webhook must be an http(s) URL.')
      }
    }
    next.webhookUrl = value
  }
  return next
}

function lanUrls(): string[] {
  const addresses: Array<{ip: string; url: string}> = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const address of entries ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        addresses.push({ip: address.address, url: `http://${address.address}:${port}`})
      }
    }
  }
  // Prefer a normal home LAN address over VPN/virtual adapters.
  const rank = (ip: string) => {
    if (ip.startsWith('192.168.')) return 0
    if (ip.startsWith('10.')) return 1
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
    return 3
  }
  return addresses.sort((a, b) => rank(a.ip) - rank(b.ip)).map(entry => entry.url)
}

async function diagnostics() {
  const ytdlp = await getYtDlp().catch(() => undefined)
  const ytdlpVersion = ytdlp ? await getBinaryVersion(ytdlp) : undefined
  const ffmpeg = await findFfmpeg()
  const ffmpegVersion = await getBinaryVersion(ffmpeg ?? 'ffmpeg', '-version')
  const networkUrls = lanUrls()
  const localUrl = `http://127.0.0.1:${port}`
  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    ytdlp: {path: ytdlp, version: ytdlpVersion},
    ffmpeg: {path: ffmpeg ?? 'ffmpeg (PATH)', version: ffmpegVersion},
    outDir: state.settings.outDir,
    stateFile: stateFilePath(),
    host,
    port,
    urls: [localUrl, ...networkUrls],
    lanUrl: networkUrls[0],
    qrTarget: host === '127.0.0.1' ? localUrl : (networkUrls[0] ?? localUrl),
    counts: {jobs: state.jobs.length, library: state.library.length, active: runtimes.size},
    uptime: Math.round(process.uptime()),
  }
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

function safeJoin(base: string, relative: string): string | undefined {
  const target = path.resolve(base, `.${path.sep}${relative}`)
  return target === base || target.startsWith(base + path.sep) ? target : undefined
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  let base = WEB_DIR
  let relative = pathname === '/' ? 'index.html' : pathname.slice(1)

  if (relative.startsWith('assets/')) {
    base = ASSETS_DIR
    relative = relative.slice('assets/'.length)
  }

  const filePath = safeJoin(base, relative)
  if (!filePath) throw new HttpError(404, 'Not found.')

  let info
  try {
    info = await fs.stat(filePath)
  } catch {
    throw new HttpError(404, 'Not found.')
  }
  if (!info.isFile()) throw new HttpError(404, 'Not found.')

  const headers: Record<string, string> = {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(info.size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (path.basename(filePath) === 'sw.js') headers['Service-Worker-Allowed'] = '/'
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)
  const method = req.method ?? 'GET'

  if (method === 'GET' || method === 'HEAD') {
    if (pathname === '/api/health') {
      sendJson(res, 200, {ok: true, outDir: state.settings.outDir, jobs: state.jobs.length, active: runtimes.size})
      return
    }

    if (pathname === '/api/settings') {
      sendJson(res, 200, state.settings)
      return
    }

    if (pathname === '/api/diagnostics') {
      sendJson(res, 200, await diagnostics())
      return
    }

    if (pathname === '/api/qr') {
      const text = url.searchParams.get('text') ?? ''
      if (!/^https?:\/\//.test(text) || text.length > 500) throw new HttpError(400, 'Invalid QR text.')
      const svg = await QRCode.toString(text, {type: 'svg', margin: 1, width: 240, color: {dark: '#18181b', light: '#ffffff'}})
      res.writeHead(200, {'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store'})
      res.end(svg)
      return
    }

    if (pathname === '/api/jobs') {
      sendJson(res, 200, {jobs: state.jobs.slice(0, JOB_HISTORY + 50).map(jobSnapshot)})
      return
    }

    if (pathname === '/api/library') {
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const items = state.library
        .filter(item => !query || `${item.title} ${item.uploader ?? ''} ${item.format}`.toLowerCase().includes(query))
        .slice(0, 1000)
      const withExistence = await Promise.all(
        items.map(async item => ({
          ...item,
          exists: await fs
            .stat(item.filepath)
            .then(stat => stat.isFile())
            .catch(() => false),
        })),
      )
      sendJson(res, 200, {items: withExistence})
      return
    }

    if (pathname === '/api/events') {
      openEventStream(req, res)
      return
    }

    const jobEvents = /^\/api\/jobs\/([^/]+)\/events$/.exec(pathname)
    if (jobEvents) {
      const job = findJob(jobEvents[1] as string)
      if (!job) throw new HttpError(404, 'Unknown download.')
      openJobStream(req, res, job)
      return
    }

    const jobFile = /^\/api\/jobs\/([^/]+)\/file$/.exec(pathname)
    if (jobFile) {
      const job = findJob(jobFile[1] as string)
      if (!job || job.status !== 'done' || !job.filepath) throw new HttpError(404, 'File not ready.')
      serveFile(req, res, job.filepath, job.filename ?? path.basename(job.filepath), false)
      return
    }

    const libraryMedia = /^\/api\/library\/([^/]+)\/media$/.exec(pathname)
    if (libraryMedia) {
      const item = state.library.find(candidate => candidate.id === libraryMedia[1])
      if (!item) throw new HttpError(404, 'Unknown file.')
      serveFile(req, res, item.filepath, item.filename, true)
      return
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.')
    await serveStatic(req, res, pathname)
    return
  }

  if (method === 'POST') {
    if (pathname === '/api/probe') {
      const body = await readJson(req)
      const target = parseUrl(body.url)
      const controller = new AbortController()
      const abortOnDisconnect = () => {
        if (!res.writableEnded) controller.abort()
      }
      res.on('close', abortOnDisconnect)
      try {
        const ytdlp = await getYtDlp()
        const asPlaylist = asBoolean(body.playlist)
        const result = await probe(ytdlp, target, {
          signal: controller.signal,
          playlist: asPlaylist,
          cookiesFromBrowser: state.settings.cookiesFromBrowser,
        })
        const info = result.info
        if (asPlaylist && info._type === 'playlist') {
          void fs.rm(result.infoJsonPath, {force: true}).catch(() => {})
          sendJson(res, 200, {
            playlist: true,
            title: info.title,
            extractor: info.extractor_key,
            entries: (info.entries ?? []).slice(0, 500).map((entry, index) => ({
              index,
              id: entry.id,
              title: entry.title ?? entry.id ?? `entry ${index + 1}`,
              url: entry.webpage_url ?? entry.url,
              duration: entry.duration,
              thumbnail: entry.thumbnail,
              uploader: entry.uploader,
            })),
          })
          return
        }
        const session = createSession(target, result)
        const hasVideo = (info.formats ?? []).some(
          format => format.vcodec && format.vcodec !== 'none' && !format.vcodec.toLowerCase().startsWith('bytevc2'),
        )
        sendJson(res, 200, {
          sessionId: session.id,
          url: target,
          title: info.title,
          uploader: info.uploader,
          duration: info.duration,
          thumbnail: info.thumbnail,
          webpageUrl: info.webpage_url ?? target,
          extractor: info.extractor_key,
          hasVideo,
          playlist: info._type === 'playlist',
          choices: session.choices.map(choice => ({
            label: choice.label,
            kind: choice.kind,
            codec: choice.codec,
            compatible: choice.compatible,
            height: choice.height,
            width: choice.width,
          })),
        })
      } catch (error) {
        if (controller.signal.aborted) return
        throw error
      } finally {
        res.off('close', abortOnDisconnect)
      }
      return
    }

    if (pathname === '/api/download') {
      const body = await readJson(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const session = sessions.get(sessionId)
      if (!session) throw new HttpError(404, 'Link expired. Paste it again.')
      session.touchedAt = Date.now()
      const index = Number(body.choice)
      const choice = session.choices[index]
      if (!Number.isInteger(index) || !choice) throw new HttpError(400, 'Pick a format first.')

      const job: StoredJob = {
        id: randomUUID(),
        url: session.url,
        title: session.probe.info.title,
        uploader: session.probe.info.uploader,
        thumbnail: session.probe.info.thumbnail,
        duration: session.probe.info.duration,
        extractor: session.probe.info.extractor_key,
        kind: choice.kind,
        format: choice.label,
        codec: choice.codec,
        compatible: choice.compatible,
        width: choice.width,
        height: choice.height,
        choiceArgs: choice.args,
        infoJsonPath: session.probe.infoJsonPath,
        options: parseOptions(body.options),
        outDir: state.settings.outDir,
        status: 'queued',
        createdAt: Date.now(),
      }
      if (!choice.compatible && choice.kind === 'video' && state.settings.autoTranscode) {
        job.note = 'Will be converted to H.264 after download.'
      }
      state.jobs.unshift(job)
      trimHistory()
      scheduleSave(state)
      broadcastEvent('jobs')
      sendJson(res, 202, {jobId: job.id, job: jobSnapshot(job)})
      pump()
      return
    }

    if (pathname === '/api/queue') {
      const body = await readJson(req)
      const urls = argList(body.urls).map(value => parseUrl(value))
      if (urls.length === 0) throw new HttpError(400, 'Add at least one link.')
      const mode = body.mode === 'audio' ? 'audio' : 'video'
      const options = parseOptions(body.options)
      const jobs: StoredJob[] = urls.map(url => ({
        id: randomUUID(),
        url,
        title: url,
        kind: mode,
        format: mode === 'audio' ? 'audio only · mp3' : 'best available · mp4',
        autoMode: mode,
        options,
        outDir: state.settings.outDir,
        status: 'queued',
        createdAt: Date.now(),
      }))
      state.jobs.unshift(...jobs)
      trimHistory()
      scheduleSave(state)
      broadcastEvent('jobs')
      sendJson(res, 202, {jobs: jobs.map(jobSnapshot)})
      pump()
      return
    }

    if (pathname === '/api/settings') {
      const body = await readJson(req)
      const next = readSettings(body)
      try {
        await fs.mkdir(next.outDir, {recursive: true})
      } catch {
        throw new HttpError(400, 'Could not create that output folder.')
      }
      state.settings = next
      scheduleSave(state)
      broadcastEvent('settings', {settings: state.settings})
      pump()
      sendJson(res, 200, state.settings)
      return
    }

    if (pathname === '/api/diagnostics/update-ytdlp') {
      if (runtimes.size > 0) {
        throw new HttpError(409, 'Wait for active downloads to finish before updating yt-dlp.')
      }
      const resolved = await updateYtDlp()
      const version = await getBinaryVersion(resolved)
      broadcastEvent('diagnostics')
      sendJson(res, 200, {path: resolved, version})
      return
    }

    const action = /^\/api\/jobs\/([^/]+)\/(pause|resume|cancel|retry)$/.exec(pathname)
    if (action) {
      const job = findJob(action[1] as string)
      if (!job) throw new HttpError(404, 'Unknown download.')
      switch (action[2]) {
        case 'pause':
          pauseJob(job)
          break
        case 'resume':
          resumeJob(job)
          break
        case 'cancel':
          cancelJob(job)
          break
        case 'retry':
          resumeJob(job)
          break
      }
      sendJson(res, 200, {job: jobSnapshot(job)})
      return
    }

    const libraryAction = /^\/api\/library\/([^/]+)\/(open|reveal|redownload)$/.exec(pathname)
    if (libraryAction) {
      const item = state.library.find(candidate => candidate.id === libraryAction[1])
      if (!item) throw new HttpError(404, 'Unknown file.')
      if (libraryAction[2] === 'open') {
        openNative(item.filepath, false)
        sendJson(res, 200, {ok: true})
        return
      }
      if (libraryAction[2] === 'reveal') {
        openNative(item.filepath, true)
        sendJson(res, 200, {ok: true})
        return
      }
      const job: StoredJob = {
        id: randomUUID(),
        url: item.url,
        title: item.title,
        uploader: item.uploader,
        thumbnail: item.thumbnail,
        duration: item.duration,
        extractor: item.extractor,
        kind: item.kind === 'audio' ? 'audio' : 'video',
        format: item.format,
        autoMode: item.kind === 'audio' ? 'audio' : 'video',
        outDir: state.settings.outDir,
        status: 'queued',
        createdAt: Date.now(),
      }
      state.jobs.unshift(job)
      trimHistory()
      scheduleSave(state)
      broadcastEvent('jobs')
      sendJson(res, 202, {job: jobSnapshot(job)})
      pump()
      return
    }

    throw new HttpError(404, 'Not found.')
  }

  if (method === 'DELETE') {
    const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(pathname)
    if (jobMatch) {
      const job = findJob(jobMatch[1] as string)
      if (!job) throw new HttpError(404, 'Unknown download.')
      deleteJob(job)
      sendJson(res, 200, {ok: true})
      return
    }

    const libraryMatch = /^\/api\/library\/([^/]+)$/.exec(pathname)
    if (libraryMatch) {
      const item = state.library.find(candidate => candidate.id === libraryMatch[1])
      if (!item) throw new HttpError(404, 'Unknown file.')
      const deleteFile = url.searchParams.get('file') === '1'
      state.library = state.library.filter(candidate => candidate.id !== item.id)
      for (const job of state.jobs) {
        if (job.libraryId === item.id) job.libraryId = undefined
      }
      if (deleteFile && isInsideAllowed(item.filepath)) {
        await fs.rm(item.filepath, {force: true}).catch(() => {})
      }
      scheduleSave(state)
      broadcastEvent('library')
      broadcastEvent('jobs')
      sendJson(res, 200, {ok: true})
      return
    }

    throw new HttpError(404, 'Not found.')
  }

  throw new HttpError(405, 'Method not allowed.')
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const started = Date.now()
  res.on('finish', () => {
    if (process.env.YOINKS_DEBUG) console.log(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - started}ms)`)
  })

  void route(req, res).catch(error => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    const status = error instanceof HttpError ? error.status : 500
    if (status >= 500) console.error('[yoinks]', error)
    sendJson(res, status, {error: errorMessage(error)})
  })
})

const sweeper = setInterval(() => {
  void pruneSessions()
}, 5 * 60_000)
sweeper.unref()

server.listen(port, host, () => {
  const url = `http://${host}:${port}`
  console.log('')
  console.log(`  yoinks web  →  ${url}`)
  console.log(`  saving to   →  ${state.settings.outDir}`)
  console.log(`  queue       →  ${state.settings.concurrency} at a time`)
  for (const lan of lanUrls()) console.log(`  on your lan →  ${lan}`)
  console.log('')
  if (state.settings.outDir) void fs.mkdir(state.settings.outDir, {recursive: true}).catch(() => {})
  if (process.argv.includes('--open')) openBrowser(url)
  pump()
})

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    spawn(command[0] as string, command[1] as string[], {detached: true, stdio: 'ignore'}).unref()
  } catch {
    // the printed url is enough
  }
}

server.on('error', error => {
  console.error(`[yoinks] could not start the web server: ${errorMessage(error)}`)
  process.exitCode = 1
})

function shutdown(): void {
  for (const runtime of runtimes.values()) {
    runtime.cancelRequested = true
    killRuntime(runtime)
  }
  saveNow(state)
  server.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
