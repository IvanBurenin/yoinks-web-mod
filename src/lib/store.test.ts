import assert from 'node:assert/strict'
import {test} from 'node:test'
import {defaultState, normalizeState, type StoredJob} from './store.js'

function job(overrides: Partial<StoredJob>): StoredJob {
  return {
    id: 'job-1',
    url: 'https://example.com/video',
    title: 'test',
    kind: 'video',
    format: '720p · mp4',
    outDir: 'C:\\Downloads',
    status: 'queued',
    createdAt: 1,
    ...overrides,
  }
}

test('normalizeState pauses jobs that were running during a restart', () => {
  const state = defaultState()
  state.jobs = [
    job({status: 'downloading', progress: {downloadedBytes: 10, part: 0, totalParts: 1}}),
    job({id: 'job-2', status: 'queued'}),
  ]

  const normalized = normalizeState(state)
  assert.equal(normalized.jobs[0]!.status, 'paused')
  assert.match(normalized.jobs[0]!.note ?? '', /restart/i)
  assert.equal(normalized.jobs[0]!.progress, undefined)
  assert.equal(normalized.jobs[1]!.status, 'queued')
})

test('normalizeState clamps concurrency and keeps old library entries usable', () => {
  const state = defaultState()
  state.settings.concurrency = 99
  state.library = [
    {
      id: 'item-1',
      jobId: 'job-1',
      url: 'https://example.com/video',
      title: 'test',
      filename: 'test.mp4',
      filepath: 'C:\\Downloads\\test.mp4',
      size: 10,
      format: '720p · mp4',
      createdAt: 1,
      // old state files may not have `kind`
    } as never,
  ]

  const normalized = normalizeState(state)
  assert.equal(normalized.settings.concurrency, 5)
  assert.equal(normalized.library[0]!.kind, 'video')
})
