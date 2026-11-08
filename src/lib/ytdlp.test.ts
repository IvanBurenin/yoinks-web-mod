import assert from 'node:assert/strict'
import {test} from 'node:test'
import {buildChoices, defaultChoice, type VideoInfo} from './ytdlp.js'

function info(formats: NonNullable<VideoInfo['formats']>): VideoInfo {
  return {title: 'test', formats}
}

test('prefers H.264 + AAC for video choices', () => {
  const choices = buildChoices(
    info([
      {format_id: '399', ext: 'mp4', vcodec: 'av01.0.08M.08', acodec: 'none', height: 1080, filesize: 30_000_000},
      {format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, filesize: 25_000_000},
      {format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 160, filesize: 3_000_000},
      {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 2_000_000},
    ]),
  )

  const video = choices.find(choice => choice.kind === 'video')
  assert.ok(video)
  assert.match(video.label, /1080p · mp4/)
  assert.doesNotMatch(video.label, /AV1/)
  assert.equal(video.compatible, true)
  assert.equal(video.codec, undefined)
  assert.match(video.args[1]!, /vcodec~='\^\(avc1\|h264\)'/)
  assert.match(video.args[1]!, /acodec~='\^\(mp4a\|aac\)'/)

  const audio = choices.find(choice => choice.kind === 'audio')
  assert.ok(audio)
  assert.equal(audio.compatible, true)
})

test('labels AV1-only resolutions and marks them incompatible', () => {
  const choices = buildChoices(
    info([
      {format_id: '401', ext: 'mp4', vcodec: 'av01.0.12M.08', acodec: 'none', height: 2160},
      {format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 160},
    ]),
  )

  const video = choices.find(choice => choice.kind === 'video')
  assert.ok(video)
  assert.match(video.label, /2160p · mp4 · AV1/)
  assert.equal(video.compatible, false)
  assert.equal(video.codec, 'AV1')
})

test('understands TikTok-style h264/h265 names and prefers H.264', () => {
  const choices = buildChoices(
    info([
      {format_id: 'play_addr', ext: 'mp4', vcodec: 'h264', acodec: 'aac', height: 1024, filesize: 1_000_000},
      {format_id: 'play_addr_bytevc1', ext: 'mp4', vcodec: 'h265', acodec: 'none', height: 1024, filesize: 900_000},
      {format_id: 'audio', ext: 'm4a', vcodec: 'none', acodec: 'aac', filesize: 100_000},
    ]),
  )

  const video = choices.find(choice => choice.kind === 'video')
  assert.ok(video)
  assert.match(video.label, /1024p · mp4/)
  assert.doesNotMatch(video.label, /H\.265/)
  assert.equal(video.compatible, true)
  assert.match(video.args[1]!, /h264/)
})

test('labels H.265-only choices as incompatible', () => {
  const choices = buildChoices(
    info([
      {format_id: 'play_addr_bytevc1', ext: 'mp4', vcodec: 'h265', acodec: 'none', height: 1024},
      {format_id: 'audio', ext: 'm4a', vcodec: 'none', acodec: 'aac'},
    ]),
  )

  const video = choices.find(choice => choice.kind === 'video')
  assert.ok(video)
  assert.match(video.label, /1024p · mp4 · H\.265/)
  assert.equal(video.compatible, false)
  assert.equal(video.codec, 'H.265')
})

test('does not invent an mp4 choice for audio-only slideshows', () => {
  const choices = buildChoices(
    info([{format_id: 'audio', ext: 'm4a', vcodec: 'none', acodec: 'aac', filesize: 200_000}]),
  )

  assert.equal(choices.filter(choice => choice.kind === 'video').length, 0)
  assert.equal(choices.length, 1)
  assert.equal(choices[0]!.kind, 'audio')
})

test('defaultChoice prefers a compatible video and falls back to audio mode', () => {
  const choices = buildChoices(
    info([
      {format_id: 'h265', ext: 'mp4', vcodec: 'h265', acodec: 'none', height: 2160, filesize: 9_000_000},
      {format_id: 'h264', ext: 'mp4', vcodec: 'h264', acodec: 'aac', height: 1080, filesize: 4_000_000},
      {format_id: 'audio', ext: 'm4a', vcodec: 'none', acodec: 'aac'},
    ]),
  )

  assert.match(defaultChoice(choices, 'video')!.label, /1080p/)
  assert.equal(defaultChoice(choices, 'audio')!.kind, 'audio')
})

test('falls back to muxed mp4 when there are no separate streams', () => {
  const choices = buildChoices(
    info([{format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, filesize: 5_000_000}]),
  )

  const video = choices.find(choice => choice.kind === 'video')
  assert.ok(video)
  assert.match(video.label, /360p · mp4/)
  assert.equal(video.compatible, true)
})
