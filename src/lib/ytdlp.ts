import {spawn, type ChildProcess} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {formatBytes} from './format.js'

const YOINKS_DIR = path.join(os.homedir(), '.yoinks', 'bin')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

function ytDlpAssetName(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

// async on purpose: a spawnSync here blocks the event loop, which freezes
// ink mid-frame — the user hits enter and sees nothing until it returns
function commandWorks(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: 'ignore', timeout: 10_000})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

function commandVersion(cmd: string, flag = '--version'): Promise<string | undefined> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, [flag], {stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000})
    } catch {
      resolve(undefined)
      return
    }
    let output = ''
    child.stdout?.on('data', chunk => (output += chunk))
    child.on('error', () => resolve(undefined))
    child.on('close', code => resolve(code === 0 ? (output.trim().split(/\r?\n/)[0] ?? '') : undefined))
  })
}

/** yt-dlp stable versions are date-based (2026.10.26), so they sort as text. */
function versionDate(version: string | undefined): number | undefined {
  const match = version ? /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version.trim()) : null
  if (!match) return undefined
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

// YouTube (and friends) regularly break older extractors. A system install
// that has not been touched in a while is a common source of mysterious
// "HTTP Error 403" download failures, so refresh it ourselves.
const MAX_YTDLP_AGE_DAYS = 45
const DAY_MS = 86_400_000

function isStale(version: string | undefined): boolean {
  const date = versionDate(version)
  return date === undefined || Date.now() - date > MAX_YTDLP_AGE_DAYS * DAY_MS
}

let ytDlpRuntimeArgs: string[] = []

function commandHasOption(cmd: string, option: string): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, ['--help'], {stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000})
    } catch {
      resolve(false)
      return
    }
    let output = ''
    child.stdout?.on('data', chunk => (output += chunk))
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0 ? output.includes(option) : false))
  })
}

/**
 * Recent yt-dlp builds use an external JavaScript runtime to solve YouTube's
 * challenges. Node is already running yoinks, so hand yt-dlp its own path
 * when the installed version supports it.
 */
async function configureYtDlp(cmd: string): Promise<void> {
  ytDlpRuntimeArgs = (await commandHasOption(cmd, '--js-runtimes')) ? ['--js-runtimes', `node:${process.execPath}`] : []
}

async function downloadLatestYtDlp(local: string, signal?: AbortSignal): Promise<void> {
  await fs.mkdir(YOINKS_DIR, {recursive: true})
  const tmp = `${local}.download`
  try {
    const url = `${RELEASE_BASE}/${ytDlpAssetName()}`
    const response = await fetch(url, {signal})
    if (!response.ok || !response.body) {
      throw new Error(`Could not download yt-dlp (${response.status}). Check your connection and try again.`)
    }

    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp), {signal})
    await fs.chmod(tmp, 0o755)
    await fs.rename(tmp, local)
  } catch (error) {
    await fs.rm(tmp, {force: true}).catch(() => {})
    throw error
  }
}

/** Force a fresh standalone download, used by the web UI's "update" button. */
export async function forceUpdateYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  const local = path.join(YOINKS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  onStatus('updating yt-dlp…')
  await downloadLatestYtDlp(local, signal)
  await configureYtDlp(local)
  return local
}

/**
 * Resolve a usable yt-dlp binary. We look at both the system install and a
 * previously downloaded copy, prefer whichever is newer, and refresh from
 * GitHub releases when both are missing or out of date.
 */
export async function ensureYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  const local = path.join(YOINKS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  const [systemVersion, localVersion] = await Promise.all([commandVersion('yt-dlp'), commandVersion(local)])

  const systemWorks = systemVersion !== undefined
  const localWorks = localVersion !== undefined
  const localIsNewer = (versionDate(localVersion) ?? 0) > (versionDate(systemVersion) ?? 0)
  const best = localWorks && (!systemWorks || localIsNewer) ? {path: local, version: localVersion} : systemWorks ? {path: 'yt-dlp', version: systemVersion} : undefined

  if (best && !isStale(best.version)) {
    await configureYtDlp(best.path)
    return best.path
  }

  onStatus(best ? `yt-dlp ${best.version} is out of date — fetching the latest…` : 'first run: fetching yt-dlp…')

  try {
    await downloadLatestYtDlp(local, signal)
    await configureYtDlp(local)
    return local
  } catch (error) {
    if (signal?.aborted) throw error
    // offline (or GitHub is blocked) but we still have a working older copy
    if (best) {
      onStatus(`could not update yt-dlp — using ${best.version}`)
      await configureYtDlp(best.path)
      return best.path
    }
    throw error
  }
}

/** Used by the diagnostics panel. ffmpeg uses -version, yt-dlp uses --version. */
export function getBinaryVersion(cmd: string, flag = '--version'): Promise<string | undefined> {
  return commandVersion(cmd, flag)
}

/**
 * Find ffmpeg for stream merging / mp3 extraction: system install first,
 * ffmpeg-static as fallback. Returns undefined if neither exists — yt-dlp
 * still works for single-file formats without it.
 */
export async function findFfmpeg(): Promise<string | undefined> {
  if (await commandWorks('ffmpeg', ['-version'])) return undefined // on PATH, yt-dlp finds it itself
  try {
    const mod = await import('ffmpeg-static')
    const ffmpegPath = (mod.default ?? mod) as unknown as string | null
    if (ffmpegPath && (await commandWorks(ffmpegPath, ['-version']))) return ffmpegPath
  } catch {
    // ffmpeg-static not installed or unsupported platform
  }
  return undefined
}

export type PlaylistEntry = {
  id?: string
  title?: string
  url?: string
  webpage_url?: string
  duration?: number
  thumbnail?: string
  uploader?: string
  extractor_key?: string
}

export type VideoInfo = {
  _type?: string
  id?: string
  title: string
  uploader?: string
  duration?: number
  thumbnail?: string
  webpage_url?: string
  extractor_key?: string
  formats?: RawFormat[]
  entries?: PlaylistEntry[]
}

type RawFormat = {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  abr?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

export type ProbeResult = {
  info: VideoInfo
  /** Raw -J output saved to disk so downloads can skip re-extraction via --load-info-json. */
  infoJsonPath: string
}

export type ProbeOptions = {
  signal?: AbortSignal
  /** Return the flat entry list instead of a single video. */
  playlist?: boolean
  cookiesFromBrowser?: string
}

export async function probe(ytdlp: string, url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const args = ['-J', '--no-warnings', '--encoding', 'utf-8', ...ytDlpRuntimeArgs]
  if (options.cookiesFromBrowser) args.push('--cookies-from-browser', options.cookiesFromBrowser)
  if (options.playlist) args.push('--yes-playlist', '--flat-playlist')
  else args.push('--no-playlist')
  args.push(url)

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(ytdlp, args, {signal: options.signal})
    let out = ''
    let stderr = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`))
      } else {
        resolve(out)
      }
    })
  })

  let info: VideoInfo
  try {
    info = JSON.parse(stdout) as VideoInfo
  } catch {
    throw new Error('Could not parse video info from yt-dlp.')
  }

  const infoJsonPath = path.join(os.tmpdir(), `yoinks-info-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(infoJsonPath, stdout)
  return {info, infoJsonPath}
}

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  args: string[]
  /** Set when the video codec is not H.264. */
  codec?: string
  /** False when older players (Windows Media Player, QuickTime) may choke. */
  compatible?: boolean
  /** Video dimensions, used to decide whether a compatibility pass is cheap enough. */
  width?: number
  height?: number
}

const MAX_VIDEO_CHOICES = 8

type Codec = 'H.264' | 'H.265' | 'AV1' | 'VP9'

/** Sites name codecs differently: YouTube says avc1/av01, TikTok says h264/h265. */
function codecFamily(vcodec: string | undefined): Codec | undefined {
  if (!vcodec) return undefined
  const codec = vcodec.toLowerCase()
  if (codec.startsWith('avc') || codec.startsWith('h264')) return 'H.264'
  if (codec.startsWith('hev') || codec.startsWith('hvc') || codec.startsWith('h265') || codec.startsWith('bytevc1')) return 'H.265'
  if (codec.startsWith('av01') || codec.startsWith('av1')) return 'AV1'
  if (codec.startsWith('vp9') || codec.startsWith('vp09')) return 'VP9'
  return undefined
}

const CODEC_FILTER: Record<Codec, string> = {
  'H.264': '^(avc1|h264)',
  'H.265': '^(hvc1|hev1|hevc|h265|bytevc1)',
  AV1: '^(av01|av1)',
  VP9: '^(vp9|vp09)',
}

const AUDIO_FILTER = '^(mp4a|aac)'

function pickAudio(formats: RawFormat[], preferAac: boolean): RawFormat | undefined {
  return [...formats].sort((a, b) => {
    const aacA = preferAac && a.acodec?.startsWith('mp4a') ? 1 : 0
    const aacB = preferAac && b.acodec?.startsWith('mp4a') ? 1 : 0
    if (aacA !== aacB) return aacB - aacA
    return (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0)
  })[0]
}

export function buildChoices(info: VideoInfo): DownloadChoice[] {
  const formats = info.formats ?? []
  const choices: DownloadChoice[] = []

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  // prefer AAC for muxing: mp4 + AAC is what every player understands
  const muxAudio = pickAudio(audioOnly, true)
  const audioSize = muxAudio?.filesize ?? muxAudio?.filesize_approx

  // bytevc2 is a proprietary TikTok codec that no player supports
  const videoFormats = formats.filter(f => f.vcodec && f.vcodec !== 'none' && !f.vcodec.toLowerCase().startsWith('bytevc2'))
  const videos = videoFormats.filter(f => f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    // H.264 in mp4 is the combination that plays literally everywhere, so it
    // wins whenever it exists. Otherwise prefer H.265 > AV1 > VP9 and say
    // which codec the choice will contain.
    const family = (['H.264', 'H.265', 'AV1', 'VP9'] as const).find(codec =>
      candidates.some(format => codecFamily(format.vcodec) === codec),
    )
    const pool = family ? candidates.filter(format => codecFamily(format.vcodec) === family) : candidates
    const best = [...pool].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const codec = family
    const muxed = Boolean(best.acodec && best.acodec !== 'none')
    // Some sites list a higher-bitrate variant without a URL or size (YouTube
    // "premium" formats). Estimate from the largest variant that does have one.
    const knownSize = pool
      .map(format => format.filesize ?? format.filesize_approx)
      .filter((size): size is number => typeof size === 'number' && size > 0)
      .sort((a, b) => b - a)[0]
    const videoSize = best.filesize ?? best.filesize_approx ?? knownSize
    // only estimate when we actually know the video size — otherwise the
    // label would misleadingly show just the audio track's size
    const size = videoSize ? videoSize + (muxed ? 0 : audioSize ?? 0) : 0
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''

    const codecFilter = codec ? CODEC_FILTER[codec] : undefined
    const selector = [
      // a muxed file is the safest option when the site offers one
      codecFilter ? `b[height=${height}][vcodec~='${codecFilter}']` : undefined,
      codecFilter ? `bv*[height=${height}][vcodec~='${codecFilter}']+ba[acodec~='${AUDIO_FILTER}']` : undefined,
      codecFilter ? `bv*[height=${height}][vcodec~='${codecFilter}']+ba` : undefined,
      `b[height=${height}][ext=mp4]`,
      `bv*[height=${height}]+ba/b[height=${height}]`,
      `bv*[height<=${height}]+ba/b`,
    ]
      .filter(Boolean)
      .join('/')

    choices.push({
      kind: 'video',
      label: `${height}p · mp4${codec && codec !== 'H.264' ? ` · ${codec}` : ''}${sizeLabel}`,
      codec: codec === 'H.264' ? undefined : codec,
      compatible: !codec || codec === 'H.264',
      width: best.width,
      height,
      args: ['-f', selector, '--merge-output-format', 'mp4'],
    })
  }

  // Only invent a "best available" video choice when the post actually has a
  // video track. TikTok slideshows are audio-only; pretending they are mp4
  // videos produced audio files with a .mp4 extension.
  if (choices.length === 0 && videoFormats.length > 0) {
    choices.push({
      kind: 'video',
      label: 'best available · mp4',
      compatible: true,
      args: [
        '-f',
        [
          `b[vcodec~='${CODEC_FILTER['H.264']}']`,
          `bv*[vcodec~='${CODEC_FILTER['H.264']}']+ba[acodec~='${AUDIO_FILTER}']`,
          `bv*[vcodec~='${CODEC_FILTER['H.264']}']+ba`,
          'b[ext=mp4]',
          'bv*+ba/b',
        ].join('/'),
        '--merge-output-format',
        'mp4',
      ],
    })
  }

  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  choices.push({
    kind: 'audio',
    label: `audio only · mp3${audioSizeLabel}`,
    compatible: true,
    args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  })

  return choices
}

/** Pick the best option without user input (used by the queue/auto mode). */
export function defaultChoice(choices: DownloadChoice[], mode: 'video' | 'audio'): DownloadChoice | undefined {
  if (mode === 'audio') return choices.find(choice => choice.kind === 'audio') ?? choices[0]
  return (
    choices.find(choice => choice.kind === 'video' && choice.compatible !== false) ??
    choices.find(choice => choice.kind === 'video') ??
    choices.find(choice => choice.kind === 'audio') ??
    choices[0]
  )
}

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  // prefer a format whose size we actually know when quality ties
  score += (f.filesize ?? f.filesize_approx ?? 0) / 1e9
  return score
}

export type DownloadOptions = {
  subtitles?: boolean
  thumbnail?: boolean
  metadata?: boolean
  chapters?: boolean
}

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  /** How many files this download resolves to (video+audio merges are 2). */
  totalParts: number
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
  /** Lets the caller force-kill the child on Windows, where abort alone is not always enough. */
  onChild?: (child: ChildProcess) => void
}

const PROGRESS_PREFIX = 'YOINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

const activeChildren = new Set<ChildProcess>()
process.on('exit', () => {
  for (const child of activeChildren) child.kill('SIGTERM')
})

export function download(
  opts: {
    ytdlp: string
    ffmpegLocation?: string
    url: string
    /** When set, reuse the probe's metadata instead of re-extracting — starts much faster. */
    infoJsonPath?: string
    choice: DownloadChoice
    outDir: string
    /** Extra yt-dlp flags (subtitles, thumbnail, metadata, chapters…). */
    extraArgs?: string[]
    /** Keep .part files when the job is paused so it can resume. */
    keepPartials?: boolean | (() => boolean)
    /** Lets the owner mark a run as cancelled even if the process was killed by the OS. */
    cancelled?: () => boolean
    cookiesFromBrowser?: string
  },
  handlers: DownloadHandlers,
  signal?: AbortSignal,
): Promise<string> {
  const args = [
    ...(opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : [opts.url]),
    ...opts.choice.args,
    ...(opts.extraArgs ?? []),
    ...ytDlpRuntimeArgs,
    ...(opts.cookiesFromBrowser ? ['--cookies-from-browser', opts.cookiesFromBrowser] : []),
    '--no-playlist',
    '--no-warnings',
    // Windows consoles default to cp1251/cp866; without this the printed
    // output path is undecodable and the saved file cannot be found again.
    '--encoding',
    'utf-8',
    '--newline',
    // --print implies --quiet, which suppresses progress bars and the
    // [Merger]/[ExtractAudio] lines we detect the processing phase from
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TEMPLATE}`,
    '--print',
    'after_move:filepath',
    '--no-simulate',
    '-o',
    path.join(opts.outDir, '%(title).60s.%(ext)s'),
  ]
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)

  return new Promise((resolve, reject) => {
    const child = spawn(opts.ytdlp, args, {signal})
    activeChildren.add(child)
    handlers.onChild?.(child)

    let stderr = ''
    let filepath = ''
    let part = 0
    let totalParts = 1
    let lastDownloaded = 0
    let buffer = ''
    // every file yt-dlp writes this run, so a cancel can clean up after itself
    const destinations: string[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith(PROGRESS_PREFIX)) {
          const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
          const downloadedBytes = toNumber(downloaded) ?? 0
          if (downloadedBytes < lastDownloaded) part++
          lastDownloaded = downloadedBytes
          handlers.onProgress({
            downloadedBytes,
            totalBytes: toNumber(total) ?? toNumber(totalEstimate),
            speed: toNumber(speed),
            eta: toNumber(eta),
            part,
            totalParts,
          })
        } else if (line.includes('Downloading 1 format(s):')) {
          // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
          totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
        } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
          const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
          const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
          const target = merging ?? extracting
          if (target) destinations.push(target)
          handlers.onProcessing()
        } else if (line.startsWith('[download] Destination: ')) {
          destinations.push(line.slice('[download] Destination: '.length))
        } else if (path.isAbsolute(line)) {
          filepath = line
        }
      }
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', error => {
      activeChildren.delete(child)
      reject(error)
    })
    child.on('close', code => {
      activeChildren.delete(child)
      const cancelled = signal?.aborted || opts.cancelled?.()
      if (cancelled) {
        // cancelled on purpose — paused jobs keep their .part files so they
        // can resume; a real cancel cleans up after itself
        const keep = typeof opts.keepPartials === 'function' ? opts.keepPartials() : opts.keepPartials
        if (!keep) void removePartials(destinations)
        reject(new Error('Download cancelled.'))
        return
      }
      if (code === 0 && filepath) {
        resolve(filepath)
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
      }
    })
  })
}

export type MediaStreamInfo = {
  video?: string
  audio?: string
  /** False when ffmpeg produced no stream list (not a media file / ffmpeg missing). */
  recognized: boolean
}

/** Read codecs from the finished file so a mislabelled stream cannot slip through. */
export function inspectMedia(ffmpeg: string, input: string): Promise<MediaStreamInfo> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(ffmpeg, ['-hide_banner', '-i', input], {stdio: ['ignore', 'ignore', 'pipe'], timeout: 20_000})
    } catch {
      resolve({recognized: false})
      return
    }
    let stderr = ''
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', () => resolve({recognized: false}))
    child.on('close', () => {
      const recognized = /Stream #\d+:\d+/.test(stderr)
      resolve({
        video: /:\s*Video:\s*([A-Za-z0-9_]+)/.exec(stderr)?.[1]?.toLowerCase(),
        audio: /:\s*Audio:\s*([A-Za-z0-9_]+)/.exec(stderr)?.[1]?.toLowerCase(),
        recognized,
      })
    })
  })
}

export type TranscodeOptions = {
  /** Source duration in seconds, used for progress. */
  duration?: number
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

/**
 * Re-encode a downloaded video to H.264/AAC. Some sites only expose H.265,
 * AV1, or VP9 at the requested resolution; those files fail to play in
 * Windows Media Player and many TVs even though the container is mp4.
 */
export async function transcodeToH264(ffmpeg: string, input: string, options: TranscodeOptions = {}): Promise<string> {
  const dir = path.dirname(input)
  const base = path.basename(input, path.extname(input))
  const output = path.join(dir, `${base}.compat.tmp.mp4`)
  const args = [
    '-y',
    '-hide_banner',
    '-nostats',
    '-progress',
    'pipe:1',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    output,
  ]

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpeg, args, {signal: options.signal, stdio: ['ignore', 'pipe', 'pipe']})
      let stderr = ''
      let buffer = ''
      let lastPercent = -1

      child.stdout.on('data', chunk => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const [key, value] = line.split('=')
          if (key !== 'out_time_us' && key !== 'out_time_ms') continue
          const seconds = Number(value) / 1_000_000
          if (!Number.isFinite(seconds) || !options.duration || options.duration <= 0) continue
          const percent = Math.max(0, Math.min(99, Math.round((seconds / options.duration) * 100)))
          if (percent !== lastPercent) {
            lastPercent = percent
            options.onProgress?.(percent)
          }
        }
      })

      child.stderr.on('data', chunk => {
        stderr += chunk
        if (stderr.length > 50_000) stderr = stderr.slice(-50_000)
      })
      child.on('error', reject)
      child.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(cleanFfmpegError(stderr) || `ffmpeg exited with code ${code}.`))
      })
    })
  } catch (error) {
    await fs.rm(output, {force: true}).catch(() => {})
    throw error
  }

  const finalPath = path.join(dir, `${base}.mp4`)
  await fs.rm(input, {force: true})
  await fs.rename(output, finalPath)
  return finalPath
}

function cleanFfmpegError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (/error|invalid|failed|unable|no such/i.test(line)) return line
  }
  return lines.at(-1) ?? ''
}

async function removePartials(destinations: string[]): Promise<void> {
  const files = destinations.flatMap(dest => [dest, `${dest}.part`, `${dest}.ytdl`, `${dest}.temp`])
  // Windows sometimes keeps a killed child's file handle for a moment, so a
  // single rm can fail even though the process has exited.
  for (let attempt = 0; attempt < 5; attempt++) {
    const results = await Promise.allSettled(files.map(file => fs.rm(file, {force: true})))
    if (!results.some(result => result.status === 'rejected')) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  if (!last) return ''
  const message = last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '')
  if (/HTTP Error 403/i.test(message)) {
    return `${message} — the site refused the download. This can happen when a video is region-locked, age-restricted, or your network is being blocked.`
  }
  return message
}
