import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Nothing sits beneath the plugin in a test, so these hooks stand for the engine:
// a small in-memory disk with one project, and ffprobe / ffmpeg answered by hand.

const ROOT = '/work'
const PROJ = '/work/film'
const FRAME_B64 = 'AAAA'

type Disk = Map<string, { text: string; mtimeMs: number }>

function fakeEngine(on: Parameters<TestBody>[1], disk: Disk, sent: string[]) {
  const store = new Map<string, unknown>()
  const isDir = (p: string) => [...disk.keys()].some(k => k.startsWith(`${p.replace(/\/$/, '')}/`))
  on('command.register', () => ({ value: { command: 'loupe' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__loupe__edit_notes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('clock.now', () => ({ value: 1_793_300_000_000 }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('prompt.submit', (_, e) => { sent.push(e.text); return { text: e.text } })
  on('fs.exists', (_, e) => ({ value: disk.has(e.path) || isDir(e.path) }))
  on('fs.read', (_, e) => {
    const f = disk.get(e.path)
    if (!f) throw new Error(`ENOENT ${e.path}`)
    return { value: e.as === 'bytes' ? { base64: FRAME_B64 } : f.text }
  })
  on('fs.write', (_, e) => { disk.set(e.path, { text: e.text, mtimeMs: 9 }); return { value: undefined } })
  on('fs.list', (_, e) => {
    const dir = e.path.replace(/\/$/, '')
    const names = new Map<string, { kind: 'file' | 'dir'; mtimeMs: number }>()
    for (const [k, f] of disk) {
      if (!k.startsWith(`${dir}/`)) continue
      const rest = k.slice(dir.length + 1)
      const [head, ...tail] = rest.split('/')
      names.set(head!, tail.length ? { kind: 'dir', mtimeMs: 0 } : { kind: 'file', mtimeMs: f.mtimeMs })
    }
    return { value: [...names].map(([name, v]) => ({ name, kind: v.kind, size: 1, mtimeMs: v.mtimeMs, isLink: false })) }
  })
  on('process.run', (_, e) => {
    const [cmd] = e.argv
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd!.endsWith('ffprobe')) {
      return ok(JSON.stringify({ streams: [{ r_frame_rate: '24/1', width: 1920, height: 1080 }], format: { duration: '10' } }))
    }
    if (cmd!.endsWith('ffmpeg')) { disk.set(e.argv[e.argv.length - 1]!, { text: 'jpg', mtimeMs: 9 }); return ok() }
    return ok()   // mkdir -p
  })
}

const PANE = {
  plugin: 'loupe',
  component: 'Pane',
  requestId: 'loupe',
  props: { title: 'Loupe', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

function newDisk(): Disk {
  return new Map([
    [`${PROJ}/exports/cut_v1.mp4`, { text: '', mtimeMs: 1 }],
    [`${PROJ}/renders/cut_v2.mp4`, { text: '', mtimeMs: 2 }],
    [`${ROOT}/notes-only/readme.md`, { text: '', mtimeMs: 3 }],
  ])
}

const notesOnDisk = (disk: Disk) => JSON.parse(disk.get(`${PROJ}/notes/edit-notes.json`)?.text ?? '[]') as
  { id: string; f0: number; f1: number; kind: string; text: string; status: string; doneIn?: string; video: string }[]

test('a note goes from the pane to the notes file, to Claude, and back done', async ($, on) => {
  const disk = newDisk()
  const sent: string[] = []
  fakeEngine(on, disk, sent)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the project is found by its renders folder, newest render first (renders/ beats exports/ here)
  expect((await ui.find({ key: 'video' }))?.props.value).toBe('renders/cut_v2.mp4')
  expect((await ui.find({ type: 'Text', text: /24 fps · 10\.00 s · 240 frames/ }))).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^F0000 · 0\.00 s/ })).toBeDefined()

  await ui.press({ key: 'f+1s' })
  await ui.press({ key: 'mark-in' })
  await ui.press({ key: 'f+1s' })
  await ui.press({ key: 'f+1s' })
  await ui.press({ key: 'mark-out' })
  expect(await ui.find({ type: 'Text', text: /IN F0024 {2}OUT F0072 {2}\(2\.04 s\)/ })).toBeDefined()

  await ui.select({ key: 'kind', value: 'sound' })
  await ui.input({ key: 'note', text: 'soft pop when the card lands' })
  const [note] = notesOnDisk(disk)
  expect(note).toMatchObject({ f0: 24, f1: 72, kind: 'sound', status: 'open', video: 'renders/cut_v2.mp4', text: 'soft pop when the card lands' })
  expect(disk.get(`${PROJ}/notes/edit-notes.md`)?.text).toContain('soft pop when the card lands')

  await ui.press({ key: 'send' })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('F0024–F0072 · 1.00–3.00 s')
  expect(sent[0]).toContain('Sound effects: soft pop when the card lands')

  const r = await $.tool.call({ tool: 'mcp__loupe__edit_notes', action: 'done', ids: [note!.id], version: 'v3' })
  expect(JSON.stringify(r)).toContain('Ticked done')
  expect(notesOnDisk(disk)[0]).toMatchObject({ status: 'done', doneIn: 'v3' })
  expect(await ui.find({ type: 'Text', text: /Sound effects · done in v3/ })).toBeDefined()
  await ui.unmount()
})

test('Go to stays inside the render, and bad input says why', async ($, on) => {
  const disk = newDisk()
  fakeEngine(on, disk, [])
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.input({ key: 'goto', text: '99' })
  expect(await ui.find({ type: 'Text', text: /^F0239 · / })).toBeDefined()

  await ui.input({ key: 'goto', text: 'soon' })
  expect(await ui.find({ type: 'Text', text: /Can't read "soon"/ })).toBeDefined()

  // a range that runs past the end is cut to the last frame
  await ui.input({ key: 'goto', text: '9-20' })
  expect(await ui.find({ type: 'Text', text: /IN F0216 {2}OUT F0239/ })).toBeDefined()
  await ui.unmount()
})

test('the terminal gets times and notes without the picture', async ($, on) => {
  fakeEngine(on, newDisk(), [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const hint = await ui.find({ type: 'Text', text: /frame picture shows in the desktop app/ })
    if (surface === 'terminal') expect(hint).toBeDefined()
    else expect(hint).toBeUndefined()
    expect(await ui.find({ key: 'mark-in' })).toBeDefined()
    await ui.unmount()
  }
})
