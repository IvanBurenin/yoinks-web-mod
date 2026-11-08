import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {DownloadProgress, DownloadOptions} from './ytdlp.js'

export const STATE_DIR = path.join(os.homedir(), '.yoinks')
const STATE_FILE = path.join(STATE_DIR, 'web-state.json')

export type Settings = {
  outDir: string
  /** How many downloads may run at the same time. */
  concurrency: number
  /** '' or a yt-dlp browser name (chrome, edge, firefox, brave…). */
  cookiesFromBrowser: string
  autoTranscode: boolean
  /** POST JSON here when a job finishes or fails. */
  webhookUrl: string
}

export type JobStatus = 'queued' | 'starting' | 'downloading' | 'processing' | 'paused' | 'done' | 'error' | 'cancelled'

export type StoredJob = {
  id: string
  url: string
  title: string
  uploader?: string
  thumbnail?: string
  duration?: number
  extractor?: string
  kind: 'video' | 'audio'
  format: string
  codec?: string
  compatible?: boolean
  width?: number
  height?: number
  /** Present when the user picked a format from the probe screen. */
  choiceArgs?: string[]
  infoJsonPath?: string
  /** Present for queue/auto jobs: probe first, then pick this kind. */
  autoMode?: 'video' | 'audio'
  options?: DownloadOptions
  outDir: string
  status: JobStatus
  progress?: DownloadProgress
  stage?: 'transcoding'
  stageProgress?: number
  note?: string
  error?: string
  filepath?: string
  filename?: string
  size?: number
  libraryId?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export type LibraryItem = {
  id: string
  jobId: string
  url: string
  title: string
  uploader?: string
  thumbnail?: string
  duration?: number
  extractor?: string
  filename: string
  filepath: string
  size: number
  format: string
  codec?: string
  kind: 'video' | 'audio'
  createdAt: number
}

export type State = {
  version: 1
  settings: Settings
  jobs: StoredJob[]
  library: LibraryItem[]
}

export function defaultSettings(): Settings {
  return {
    outDir: path.join(os.homedir(), 'Downloads'),
    concurrency: 2,
    cookiesFromBrowser: '',
    autoTranscode: true,
    webhookUrl: '',
  }
}

export function defaultState(): State {
  return {version: 1, settings: defaultSettings(), jobs: [], library: []}
}

const MAX_JOBS = 300
const MAX_LIBRARY = 1000

const ACTIVE: JobStatus[] = ['starting', 'downloading', 'processing']

export function normalizeState(input: State): State {
  const base = defaultSettings()
  const settings: Settings = {
    outDir: typeof input.settings?.outDir === 'string' && input.settings.outDir ? path.resolve(input.settings.outDir) : base.outDir,
    concurrency: Math.min(5, Math.max(1, Math.round(Number(input.settings?.concurrency) || base.concurrency))),
    cookiesFromBrowser: typeof input.settings?.cookiesFromBrowser === 'string' ? input.settings.cookiesFromBrowser : '',
    autoTranscode: input.settings?.autoTranscode !== false,
    webhookUrl: typeof input.settings?.webhookUrl === 'string' ? input.settings.webhookUrl : '',
  }

  const jobs = (Array.isArray(input.jobs) ? input.jobs : []).slice(0, MAX_JOBS).map(job => {
    const baseJob = {...job, outDir: typeof job.outDir === 'string' && job.outDir ? job.outDir : settings.outDir}
    if (!ACTIVE.includes(baseJob.status)) return baseJob
    // The server died while this job was running. Keep the record, but do not
    // pretend it is still downloading.
    return {
      ...baseJob,
      status: 'paused' as const,
      note: 'Interrupted by a server restart — press resume to continue.',
      progress: undefined,
      stage: undefined,
      stageProgress: undefined,
    }
  })

  const library = (Array.isArray(input.library) ? input.library : []).slice(0, MAX_LIBRARY).map(item => ({
    ...item,
    kind: item.kind === 'audio' ? ('audio' as const) : ('video' as const),
  }))

  return {version: 1, settings, jobs, library}
}

export function loadState(): State {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<State>
    return normalizeState({...defaultState(), ...parsed, settings: {...defaultSettings(), ...parsed.settings}} as State)
  } catch {
    return defaultState()
  }
}

let timer: NodeJS.Timeout | undefined
let writeChain: Promise<void> = Promise.resolve()

async function writeState(state: State): Promise<void> {
  const tmp = `${STATE_FILE}.tmp`
  try {
    await fsp.mkdir(STATE_DIR, {recursive: true})
    await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
    await fsp.rename(tmp, STATE_FILE)
  } catch {
    // the download still works if persistence is unavailable
  }
}

export function scheduleSave(state: State): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    const snapshot = JSON.parse(JSON.stringify(state)) as State
    writeChain = writeChain.then(() => writeState(snapshot)).catch(() => {})
  }, 200)
  timer.unref?.()
}

/** Synchronous best-effort write for process shutdown. */
export function saveNow(state: State): void {
  try {
    fs.mkdirSync(STATE_DIR, {recursive: true})
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
  } catch {
    // ignore
  }
}

export function stateFilePath(): string {
  return STATE_FILE
}
