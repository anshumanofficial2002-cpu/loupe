import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Marks, Note, NoteKind, Preview, Scene, VideoMeta } from '../types'
import { fmtFrame, fmtRange, fmtSec, fmtTC, parseWhen } from './time'

type $T = EngineInterface

const PANE = 'loupe'

const project = atom({ plugin: 'loupe', key: 'project' } as const, null)
const projects = atom({ plugin: 'loupe', key: 'projects' } as const, [])
const videos = atom({ plugin: 'loupe', key: 'videos' } as const, [])
const video = atom({ plugin: 'loupe', key: 'video' } as const, null)
const meta = atom({ plugin: 'loupe', key: 'meta' } as const, null)
const frame = atom({ plugin: 'loupe', key: 'frame' } as const, 0)
const preview = atom({ plugin: 'loupe', key: 'preview' } as const, null)
const marks = atom({ plugin: 'loupe', key: 'marks' } as const, { in: null, out: null })
const kind = atom({ plugin: 'loupe', key: 'kind' } as const, 'effect')
const scenes = atom({ plugin: 'loupe', key: 'scenes' } as const, [])
const msg = atom({ plugin: 'loupe', key: 'msg' } as const, '')
// Change the tag when a note's fields change: it declines what an earlier version stored.
const notes = atom({ plugin: 'loupe', key: 'notes' } as const, [], { shape: 'notes-1' })

const KINDS: { value: NoteKind; label: string }[] = [
  { value: 'effect', label: 'Effect / motion' },
  { value: 'text', label: 'Text / captions' },
  { value: 'cut', label: 'Cut / timing' },
  { value: 'sound', label: 'Sound effects' },
  { value: 'music', label: 'Music' },
  { value: 'colour', label: 'Colour / grade' },
  { value: 'broll', label: 'B-roll swap' },
  { value: 'other', label: 'Other' },
]
const kindLabel = (k: NoteKind) => KINDS.find(x => x.value === k)?.label ?? k

const join = (a: string, b: string) => `${a.replace(/\/$/, '')}/${b}`
const base = (p: string) => p.split('/').pop() ?? p

// ------------------------------------------------------------------ host helpers
async function bin($: $T, name: string): Promise<string> {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (await $.fs.exists(`${dir}/${name}`)) return `${dir}/${name}`
  }
  return name
}

/** Folders a project keeps its renders in, relative to the project. */
const RENDER_DIRS = ['exports', 'renders', 'out', 'output']
const isVideo = (name: string) => /\.(mp4|mov|m4v|webm)$/i.test(name)

async function renders($: $T, proj: string): Promise<{ rel: string; t: number }[]> {
  const out: { rel: string; t: number }[] = []
  for (const d of RENDER_DIRS) {
    const dir = join(proj, d)
    if (!(await $.fs.exists(dir))) continue
    for (const f of await $.fs.list(dir)) if (f.kind === 'file' && isVideo(f.name)) out.push({ rel: `${d}/${f.name}`, t: f.mtimeMs })
  }
  return out.sort((a, b) => b.t - a.t)
}

async function findProjects($: $T): Promise<string[]> {
  const root = await $.session.root()
  const out: { path: string; t: number }[] = []
  const consider = async (dir: string) => {
    const found = await renders($, dir)
    if (found.length) out.push({ path: dir, t: found[0]!.t })
  }
  await consider(root)
  for (const e of await $.fs.list(root)) {
    if (e.kind === 'dir' && !e.name.startsWith('.')) await consider(join(root, e.name))
  }
  return out.sort((a, b) => b.t - a.t).map(o => o.path)
}

async function findVideos($: $T, proj: string): Promise<string[]> {
  return (await renders($, proj)).map(r => r.rel)
}

async function probe($: $T, abs: string): Promise<VideoMeta | null> {
  const r = await $.process.run([await bin($, 'ffprobe'), '-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=r_frame_rate,width,height:format=duration', '-of', 'json', abs])
  if (r.exitCode !== 0) return null
  const j = JSON.parse(r.stdout) as { streams?: { r_frame_rate?: string; width?: number; height?: number }[]; format?: { duration?: string } }
  const s = j.streams?.[0]
  const [num, den] = (s?.r_frame_rate ?? '24/1').split('/').map(Number)
  const fps = (num ?? 24) / (den || 1)
  const duration = Number(j.format?.duration ?? 0)
  return { fps, duration, frames: Math.max(1, Math.floor(duration * fps + 1e-6)), width: s?.width ?? 0, height: s?.height ?? 0 }
}

async function loadScenes($: $T, proj: string): Promise<Scene[]> {
  const p = join(proj, 'work/scenes.json')
  if (!(await $.fs.exists(p))) return []
  try {
    const rows = JSON.parse(await $.fs.read(p)) as { id: string; t0: number; t1: number }[]
    return rows.filter(r => typeof r.id === 'string').map(r => ({ id: r.id, t0: r.t0, t1: r.t1 }))
  } catch {
    return []
  }
}

const sceneAt = (list: Scene[], t: number) => list.find(s => t >= s.t0 - 1e-6 && t < s.t1 - 1e-6)?.id

// ------------------------------------------------------------------ notes: store + files
const extras = (n: Note) => [n.scene ? `beat \`${n.scene}\`` : '', n.box ? `box x${n.box.x.toFixed(2)} y${n.box.y.toFixed(2)} w${n.box.w.toFixed(2)} h${n.box.h.toFixed(2)}` : '',
  n.snap ? `snapshot \`${n.snap}\`` : ''].filter(Boolean)

async function saveNotes($: $T, proj: string, list: Note[]) {
  await $.store.set(`notes:${proj}`, list)
  const sorted = [...list].sort((a, b) => a.f0 - b.f0)
  await $.fs.write(join(proj, 'notes/edit-notes.json'), JSON.stringify(sorted, null, 1) + '\n')
  const lines = [`# Edit notes — ${base(proj)}`, '',
    'Written by Loupe. Frames are inclusive; times are seconds from the start of the render. ' +
    'Boxes are fractions of the frame (x, y, w, h from the top-left).', '']
  for (const [status, title] of [['open', 'Open'], ['done', 'Done']] as const) {
    const rows = sorted.filter(n => n.status === status)
    lines.push(`## ${title} (${rows.length})`, '')
    for (const n of rows) {
      const ex = extras(n)
      lines.push(`- **${fmtRange(n.f0, n.f1, n.fps)}** (${fmtTC(n.f0, n.fps)}${ex.length ? `, ${ex.join(', ')}` : ''}) · ${kindLabel(n.kind)}` +
        `${n.doneIn ? ` · done in ${n.doneIn}` : ''} · id \`${n.id}\` · on \`${n.video}\``)
      lines.push(`  ${n.text.replace(/\n/g, '\n  ')}`)
    }
    lines.push('')
  }
  await $.fs.write(join(proj, 'notes/edit-notes.md'), lines.join('\n'))
}

/** The file is the shared source of truth (other tools may write it too); the store is only a fallback. */
async function loadNotes($: $T, proj: string): Promise<Note[]> {
  const p = join(proj, 'notes/edit-notes.json')
  if (await $.fs.exists(p)) {
    try { return JSON.parse(await $.fs.read(p)) as Note[] } catch { /* fall through */ }
  }
  const v = await $.store.get(`notes:${proj}`)
  return Array.isArray(v) ? (v as Note[]) : []
}

// ------------------------------------------------------------------ the frame viewer
async function showFrame($: $T, f: number) {
  const proj = await read($, project)
  const vid = await read($, video)
  const m = await read($, meta)
  if (!proj || !vid || !m) return
  const fr = Math.max(0, Math.min(m.frames - 1, Math.round(f)))
  await update($, frame, () => fr)
  const cache = join(proj, `notes/.frames/${base(vid).replace(/\.[^.]+$/, '')}`)
  const out = `${cache}/f${String(fr).padStart(5, '0')}.jpg`
  const ff = await bin($, 'ffmpeg')
  if (!(await $.fs.exists(out))) {
    await $.process.run(['mkdir', '-p', cache])
    // input seek returns the first frame whose time is at or after -ss: half a frame early lands on fr itself
    const t = Math.max(0, (fr - 0.5) / m.fps).toFixed(4)
    const r = await $.process.run([ff, '-v', 'error', '-y', '-ss', t, '-i', join(proj, vid), '-frames:v', '1',
      '-vf', 'scale=768:-2', '-q:v', '6', out], { timeoutMs: 20000 })
    if (r.exitCode !== 0) {
      await update($, msg, () => `ffmpeg could not read ${fmtFrame(fr)}: ${r.stderr.slice(0, 160)}`)
      return
    }
  }
  let { base64 } = (await $.fs.read(out, { as: 'bytes' })) as { base64: string }
  if (base64.length > 120000) {   // the drawing takes ~128 kB of markup: re-encode smaller
    const small = out.replace(/\.jpg$/, '_s.jpg')
    await $.process.run([ff, '-v', 'error', '-y', '-i', out, '-vf', 'scale=640:-2', '-q:v', '11', small])
    base64 = ((await $.fs.read(small, { as: 'bytes' })) as { base64: string }).base64
  }
  if ((await read($, frame)) !== fr) return   // a later step already moved on
  const h = m.width ? Math.round((768 * m.height) / m.width) : 432
  await update($, preview, (): Preview => ({ frame: fr, video: vid, b64: base64, w: 768, h }))
}

async function selectVideo($: $T, vid: string) {
  const proj = await read($, project)
  if (!proj) return
  const m = await probe($, join(proj, vid))
  if (!m) {
    await update($, msg, () => `Couldn't read ${vid} with ffprobe.`)
    return
  }
  await update($, video, () => vid)
  await update($, meta, () => m)
  await update($, preview, () => null)
  await update($, msg, () => '')
  await showFrame($, Math.min(await read($, frame), m.frames - 1))
}

async function selectProject($: $T, proj: string) {
  await update($, project, () => proj)
  const list = await loadNotes($, proj)
  await update($, notes, () => list)
  const sc = await loadScenes($, proj)
  await update($, scenes, () => sc)
  const vids = await findVideos($, proj)
  await update($, videos, () => vids)
  await update($, marks, () => ({ in: null, out: null }))
  await $.store.set('lastProject', proj)
  if (vids[0]) await selectVideo($, vids[0])
  else {
    await update($, video, () => null)
    await update($, meta, () => null)
    await update($, msg, () => `No renders in ${base(proj)} yet (looked in ${RENDER_DIRS.join('/, ')}/).`)
  }
}

async function step($: $T, d: number) {
  await showFrame($, (await read($, frame)) + d)
}

async function addNote($: $T, text: string) {
  const t = text.trim()
  if (!t) return
  const proj = await read($, project)
  const vid = await read($, video)
  const m = await read($, meta)
  if (!proj || !vid || !m) {
    await update($, msg, () => 'Pick a project and a render first.')
    return
  }
  const mk = await read($, marks)
  const cur = await read($, frame)
  let f0 = mk.in ?? cur
  let f1 = mk.out ?? (mk.in !== null ? Math.max(mk.in, cur) : cur)
  if (f1 < f0) [f0, f1] = [f1, f0]
  const now = new Date(await $.clock.now())
  const note: Note = {
    id: `n${now.getTime().toString(36)}`, video: vid, f0, f1, fps: m.fps, kind: await read($, kind), text: t,
    scene: sceneAt(await read($, scenes), f0 / m.fps), status: 'open', createdAt: now.toISOString(),
  }
  const list = [...(await loadNotes($, proj)), note]
  await update($, notes, () => list)
  await update($, marks, () => ({ in: null, out: null }))
  await update($, msg, () => `Saved ${fmtRange(f0, f1, m.fps)} → ${base(proj)}/notes/edit-notes.md`)
  await saveNotes($, proj, list)
}

async function editNotes($: $T, fn: (list: Note[]) => Note[]) {
  const proj = await read($, project)
  if (!proj) return
  const list = fn(await loadNotes($, proj))   // fresh from the file: another tool or Claude may have written it
  await update($, notes, () => list)
  await saveNotes($, proj, list)
}

function noteLine(n: Note, i: number): string {
  const ex = extras(n).map(x => x.replace(/`/g, ''))
  return `${i + 1}. [${n.id}] ${fmtRange(n.f0, n.f1, n.fps)} (${fmtTC(n.f0, n.fps)}${ex.length ? `, ${ex.join(', ')}` : ''}) · ${kindLabel(n.kind)}: ${n.text}`
}

async function sendToClaude($: $T) {
  const proj = await read($, project)
  const open = (await read($, notes)).filter(n => n.status === 'open').sort((a, b) => a.f0 - b.f0)
  if (!proj || open.length === 0) {
    await update($, msg, () => 'No open notes to send.')
    return
  }
  const vid = await read($, video)
  const text = [`Edit notes for ${base(proj)} (made on ${vid}, ${open[0]?.fps ?? 24} fps). Apply these, re-render, ` +
    `then tick each one done with the edit_notes tool and the new version:`, '', ...open.map(noteLine), '',
    `Full list: ${join(proj, 'notes/edit-notes.md')}`].join('\n')
  await update($, msg, () => `Sent ${open.length} open note${open.length === 1 ? '' : 's'} to Claude.`)
  $.prompt.submit({ text }).catch(err =>
    update($, msg, () => `Couldn't send the notes to Claude: ${String(err).slice(0, 120)}`))
}

// ------------------------------------------------------------------ hooks
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'loupe', description: 'Open the frame viewer and pin edit notes to frames or ranges' })
    await $.tool.register({
      name: 'edit_notes',
      description: 'The person\'s frame-accurate edit notes from the Loupe pane (frames inclusive, times in seconds). ' +
        'action "list" returns them for a project; "done" ticks notes done with the render version that has the change; "reopen" reopens them.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'done', 'reopen'] },
          project: { type: 'string', description: 'Absolute project folder; defaults to the one open in the pane' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Note ids, for done / reopen' },
          version: { type: 'string', description: 'For done: the render that has the change, e.g. v6' },
        },
        required: ['action'],
      },
    })
    void (async () => {
      const found = await findProjects($)
      await update($, projects, () => found)
      if ((await read($, project)) === null) {
        const last = (await $.store.get('lastProject')) as string | undefined
        const pick = last && found.includes(last) ? last : found[0]
        if (pick) await selectProject($, pick)
      }
    })()
    return started
  })

  on('command.run', { command: 'loupe' }, async $ => {
    const proj = await read($, project)
    if (proj) { const fresh = await loadNotes($, proj); await update($, notes, () => fresh) }
    await $.ui.open({ id: PANE, title: 'Loupe', focus: true })
    return { text: 'Loupe opened.' }
  })

  on('tool.call', { tool: /^mcp__loupe__edit_notes$/ }, async ($, e) => {
    const input = e as unknown as { action?: string; project?: string; ids?: string[]; version?: string }
    const proj = input.project ?? (await read($, project))
    if (!proj) return { result: 'No project is open in the Loupe pane.' }
    const isOpenHere = proj === (await read($, project))
    const list = await loadNotes($, proj)
    const ids = new Set(input.ids ?? [])
    if (input.action === 'done' || input.action === 'reopen') {
      const next = list.map(n => ids.has(n.id)
        ? (input.action === 'done' ? { ...n, status: 'done' as const, doneIn: input.version } : { ...n, status: 'open' as const, doneIn: undefined })
        : n)
      if (isOpenHere) await update($, notes, () => next)
      await saveNotes($, proj, next)
      return { result: `${input.action === 'done' ? 'Ticked done' : 'Reopened'}: ${[...ids].join(', ') || '(none)'}.` }
    }
    const sorted = [...list].sort((a, b) => a.f0 - b.f0)
    const open = sorted.filter(n => n.status === 'open')
    const done = sorted.filter(n => n.status === 'done')
    return {
      result: [`Project ${proj}: ${open.length} open, ${done.length} done.`, '', 'Open:', ...open.map(noteLine), '', 'Done:',
        ...done.map((n, i) => `${noteLine(n, i)}${n.doneIn ? ` (in ${n.doneIn})` : ''}`)].join('\n'),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const isRich = e.surface === 'desktop' || e.surface === 'vscode'
    const proj = await read($, project)
    const projList = await read($, projects)
    const vidList = await read($, videos)
    const vid = await read($, video)
    const m = await read($, meta)
    const fr = await read($, frame)
    const pv = await read($, preview)
    const mk = await read($, marks)
    const k = await read($, kind)
    const list = [...(await read($, notes))].sort((a, b) => a.f0 - b.f0)
    const sc = await read($, scenes)
    const note = await read($, msg)
    const fps = m?.fps ?? 24
    const Select = 'Select' in t ? t.Select : undefined
    const Input = 'Input' in t ? t.Input : undefined
    const Svg = 'Svg' in t ? t.Svg : undefined
    const inOut = mk.in !== null || mk.out !== null
      ? `IN ${mk.in !== null ? fmtFrame(mk.in) : '—'}  OUT ${mk.out !== null ? fmtFrame(mk.out) : '—'}` +
        (mk.in !== null && mk.out !== null ? `  (${((Math.abs(mk.out - mk.in) + 1) / fps).toFixed(2)} s)` : '')
      : 'No range marked: a note pins to the current frame'

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
          {Select && projList.length > 0 && (
            <Select key="project" label="Project" value={proj ?? undefined}
              options={projList.map(p => ({ value: p, label: base(p) }))}
              onSelect={v => void selectProject($, v)} />
          )}
          {Select && vidList.length > 0 && (
            <Select key="video" label="Render" value={vid ?? undefined}
              options={vidList.map(v => ({ value: v, label: base(v) }))}
              onSelect={v => void selectVideo($, v)} />
          )}
          {m && <Text dimColor>{Math.round(fps * 1000) / 1000} fps · {m.duration.toFixed(2)} s · {m.frames} frames</Text>}
        </Box>

        {!proj && <Text dimColor>No project with renders (in exports/, renders/, out/ or output/) under this session's folder.</Text>}

        {m && isRich && Svg && (pv && pv.video === vid
          ? <Svg alt={`${vid} at ${fmtFrame(pv.frame)}`} width={pv.w} height={pv.h}
              source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pv.w} ${pv.h}" width="${pv.w}" height="${pv.h}"><image href="data:image/jpeg;base64,${pv.b64}" width="${pv.w}" height="${pv.h}"/></svg>`} />
          : <Text dimColor>Loading frame…</Text>)}
        {m && !isRich && <Text dimColor>The frame picture shows in the desktop app; times and notes work here.</Text>}

        {m && (
          <Box flexDirection="column">
            <Text bold>{fmtFrame(fr)} · {fmtSec(fr, fps)} · {fmtTC(fr, fps)}{sceneAt(sc, fr / fps) ? ` · beat ${sceneAt(sc, fr / fps)}` : ''}</Text>
            <Text dimColor>{inOut}</Text>
          </Box>
        )}

        {m && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="b-1s" label="−1 s" hotkey="z" onPress={() => void step($, -Math.round(fps))} />
            <Button key="b-5f" label="−5 f" hotkey="q" onPress={() => void step($, -5)} />
            <Button key="b-1f" label="◀ 1 f" hotkey="a" onPress={() => void step($, -1)} />
            <Button key="f+1f" label="1 f ▶" hotkey="d" onPress={() => void step($, 1)} />
            <Button key="f+5f" label="+5 f" hotkey="e" onPress={() => void step($, 5)} />
            <Button key="f+1s" label="+1 s" hotkey="c" onPress={() => void step($, Math.round(fps))} />
            <Button key="mark-in" label="Mark in" hotkey="i" onPress={() => void update($, marks, v => ({ ...v, in: fr }))} />
            <Button key="mark-out" label="Mark out" hotkey="o" onPress={() => void update($, marks, v => ({ ...v, out: fr }))} />
            <Button key="clear" label="Clear range" hotkey="x" onPress={() => void update($, marks, () => ({ in: null, out: null }))} />
          </Box>
        )}

        {m && Input && (
          <Input key="goto" label="Go to" placeholder="12.5 · 0:12:05 · f300 · 12.5-14 (a range marks in/out)" submitLabel="go"
            onSubmit={async v => {
              const r = parseWhen(v, fps)
              if ('error' in r) { await update($, msg, () => r.error); return }
              const last = m.frames - 1   // a range that runs past the end is cut to the last frame
              const f0 = Math.min(r.f0, last)
              const f1 = Math.min(r.f1, last)
              await update($, marks, () => (f0 === f1 ? { in: null, out: null } : { in: f0, out: f1 }))
              await update($, msg, () => '')
              await showFrame($, f0)
            }} />
        )}

        {m && sc.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Beats: click one to jump there and mark its whole range</Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {sc.map(s => (
                <Button key={`beat-${s.id}`} label={s.id} onPress={async () => {
                  const a = Math.round(s.t0 * fps)
                  const b = Math.max(a, Math.round(s.t1 * fps) - 1)
                  await update($, marks, () => ({ in: a, out: b }))
                  await showFrame($, a)
                }} />
              ))}
            </Box>
          </Box>
        )}

        {m && (
          <Box flexDirection="column" gap={1}>
            {Select && (
              <Select key="kind" label="Type" value={k} options={KINDS} onSelect={v => void update($, kind, () => v as NoteKind)} />
            )}
            {Input && (
              <Input key="note" label="Note" rows={2} submitLabel="save note"
                placeholder="What should change here? e.g. hold this word 6 frames longer, add a soft pop when the card lands"
                onSubmit={v => void addNote($, v)} />
            )}
          </Box>
        )}

        {note !== '' && <Text color="yellow">{note}</Text>}

        <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
          <Button key="send" label={`Send open notes to Claude (${list.filter(n => n.status === 'open').length})`} onPress={() => void sendToClaude($)} />
          {proj && <Text dimColor>Saved to {base(proj)}/notes/edit-notes.md</Text>}
        </Box>

        <Box flexDirection="column">
          {list.length === 0 && <Text dimColor>No notes yet.</Text>}
          {list.map(n => (
            <Box key={`row-${n.id}`} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                <Button key={`go-${n.id}`} label={`${fmtRange(n.f0, n.f1, n.fps)}${n.scene ? ` · ${n.scene}` : ''}`} onPress={async () => {
                  await update($, marks, () => (n.f0 === n.f1 ? { in: null, out: null } : { in: n.f0, out: n.f1 }))
                  if (n.video !== vid && vidList.includes(n.video)) await selectVideo($, n.video)
                  await showFrame($, n.f0)
                }} />
                <Text dimColor={n.status === 'done'}>{kindLabel(n.kind)}{n.status === 'done' ? ` · done${n.doneIn ? ` in ${n.doneIn}` : ''}` : ''}</Text>
                {n.status === 'open'
                  ? <Button key={`done-${n.id}`} label="Done" onPress={() => void editNotes($, l => l.map(x => x.id === n.id ? { ...x, status: 'done' } : x))} />
                  : <Button key={`reopen-${n.id}`} label="Reopen" onPress={() => void editNotes($, l => l.map(x => x.id === n.id ? { ...x, status: 'open', doneIn: undefined } : x))} />}
                <Button key={`del-${n.id}`} label="Delete" onPress={() => void editNotes($, l => l.filter(x => x.id !== n.id))} />
              </Box>
              <Text dimColor={n.status === 'done'}>{n.text}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
