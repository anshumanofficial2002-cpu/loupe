import { fmtFrame, fmtRange, fmtSec, fmtTC, parseWhen } from './time.js'

const KINDS = [
  ['effect', 'Effect / motion'], ['text', 'Text / captions'], ['cut', 'Cut / timing'], ['sound', 'Sound effects'],
  ['music', 'Music'], ['colour', 'Colour / grade'], ['broll', 'B-roll swap'], ['other', 'Other'],
]
const kindLabel = k => (KINDS.find(x => x[0] === k) ?? [k, k])[1]
const $ = id => document.getElementById(id)
const v = $('v'), v2 = $('v2'), overlay = $('overlay'), ctx = overlay.getContext('2d')

const S = {
  project: null, video: null, meta: null, scenes: [], notes: [], mtime: 0,
  frame: 0, marks: { in: null, out: null }, box: null, kind: 'effect', loop: false, filter: 'open', selected: null, editing: null,
  compare: '', videos: [], undo: null,
}
const fps = () => S.meta?.fps ?? 24
const lastFrame = () => (S.meta ? S.meta.frames - 1 : 0)
const sceneAt = f => S.scenes.find(s => f / fps() >= s.t0 - 1e-6 && f / fps() < s.t1 - 1e-6)?.id
const q = obj => new URLSearchParams(obj).toString()
const api = (path, params, body) => fetch(`${path}?${q(params)}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined).then(r => r.json())
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const remember = (k, val) => { try { localStorage.setItem(`loupe:${k}`, val) } catch {} }
const recall = k => { try { return localStorage.getItem(`loupe:${k}`) } catch { return null } }

function toast(text, action) {
  const t = $('toast'); t.textContent = text; t.classList.toggle('action', !!action)
  if (action) {
    const b = document.createElement('button'); b.textContent = action.label
    b.addEventListener('click', () => { t.classList.remove('show'); action.run() }); t.appendChild(b)
  }
  t.classList.add('show')
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show', 'action'), action ? 6000 : 2200)
}
const shortName = vid => vid.replace(/^[^/]+\//, '')
const newId = () => {   // unique even for two notes saved in the same millisecond
  const t = Date.now().toString(36); let id = `n${t}`
  for (let i = 1; S.notes.some(n => n.id === id); i++) id = `n${t}${i}`
  return id
}

// ------------------------------------------------------------------ loading
async function loadProjects() {
  const { projects } = await api('/api/projects', {})
  const sel = $('project'); sel.innerHTML = ''
  for (const p of projects) sel.add(new Option(p.name, p.path))
  if (!projects.length) { $('meta').textContent = 'No folder with renders (in exports/, renders/, out/ or output/) under the root.'; return }
  const want = recall('project')
  sel.value = projects.some(p => p.path === want) ? want : projects[0].path
  await openProject(sel.value)
}

async function openProject(path) {
  S.project = path; remember('project', path)
  const d = await api('/api/project', { project: path })
  S.scenes = d.scenes; S.notes = d.notes; S.videos = d.videos
  const sel = $('video'); sel.innerHTML = ''
  for (const vid of d.videos) sel.add(new Option(shortName(vid), vid))
  if (!d.videos.length) { $('meta').textContent = 'This project has no renders.'; return }
  $('path').textContent = `${path.split('/').pop()}/notes/edit-notes.md`
  const want = recall(`video:${path}`)
  sel.value = d.videos.includes(want) ? want : d.videos[0]
  await openVideo(sel.value)
}

async function openVideo(vid) {
  S.video = vid; remember(`video:${S.project}`, vid)
  const meta = await api('/api/meta', { project: S.project, video: vid })
  if (meta.error || !meta.frames) { $('meta').textContent = `Can't read ${shortName(vid)}: ${meta.error ?? 'no video stream'}`; toast(`Can't read ${shortName(vid)}`); return }
  S.meta = meta
  $('meta').textContent = `${Math.round(fps() * 1000) / 1000} fps · ${S.meta.duration.toFixed(2)} s · ${S.meta.frames} frames · ${S.meta.width}×${S.meta.height}`
  v.src = `/media?${q({ project: S.project, path: vid })}`
  const loaded = await new Promise(res => {
    v.addEventListener('loadedmetadata', () => res(true), { once: true })
    v.addEventListener('error', () => res(false), { once: true })
  })
  if (!loaded) { toast(`The browser can't play ${shortName(vid)} (try an H.264 MP4)`); return }
  v.playbackRate = v.defaultPlaybackRate = Number($('speed').value)   // a new source resets the speed
  fillCompare(); drawTimeline(); renderNotes()
  seek(Math.min(S.frame, lastFrame()))
}

// ------------------------------------------------------------------ playback, frames
function seek(f) {
  S.frame = Math.max(0, Math.min(lastFrame(), Math.round(f)))
  v.currentTime = (S.frame + 0.5) / fps()   // the middle of frame f: the decoder lands on f itself
  syncCompare(true)
  updateReadout()
}

// ------------------------------------------------------------------ compare: a second render beside this one, same moment
function fillCompare() {
  const sel = $('compare'), keep = S.compare
  sel.innerHTML = ''; sel.add(new Option('Off', ''))
  for (const vid of S.videos) if (vid !== S.video) sel.add(new Option(shortName(vid), vid))
  S.compare = [...sel.options].some(o => o.value === keep) ? keep : ''
  sel.value = S.compare; showCompare()
}
function showCompare() {
  const on = !!S.compare
  $('stages').classList.toggle('split', on); $('stage2').hidden = !on; $('badge1').hidden = !on
  if (!on) { v2.removeAttribute('src'); v2.load(); return }
  $('badge1').textContent = shortName(S.video); $('badge2').textContent = shortName(S.compare)
  const src = `/media?${q({ project: S.project, path: S.compare })}`
  if (v2.getAttribute('src') !== src) { v2.src = src; v2.addEventListener('loadedmetadata', () => syncCompare(true), { once: true }) }
  else syncCompare(true)
  requestAnimationFrame(drawOverlay)
}
function syncCompare(force) {   // the same time, not the same frame number: the renders may differ in fps or length
  if (!S.compare || !v2.duration) return
  const t = Math.min(v.currentTime, v2.duration - 0.001)
  if (force || Math.abs(v2.currentTime - t) > 1 / fps()) v2.currentTime = Math.max(0, t)
  if (v.paused !== v2.paused) { if (v.paused) v2.pause(); else v2.play().catch(() => {}) }
  v2.playbackRate = v.playbackRate
}
const step = d => { if (!v.paused) v.pause(); seek(S.frame + d) }

function togglePlay() {
  if (v.paused) {
    if (S.loop && S.marks.in !== null && (S.frame < S.marks.in || S.frame >= (S.marks.out ?? lastFrame()))) seek(S.marks.in)
    v.play()
  } else { v.pause(); seek(Math.floor(v.currentTime * fps() + 1e-3)) }
}

function onFrame(_, md) {   // every presented frame while playing: exact frame from the media time
  if (!v.paused) {
    S.frame = Math.min(lastFrame(), Math.floor(md.mediaTime * fps() + 1e-3))
    const out = S.marks.out ?? lastFrame()
    if (S.loop && S.marks.in !== null && S.frame >= out) { v.currentTime = (S.marks.in + 0.5) / fps(); S.frame = S.marks.in; syncCompare(true) }
    else syncCompare(false)
    updateReadout()
  }
  v.requestVideoFrameCallback(onFrame)
}

function updateReadout() {
  const f = S.frame
  $('pos').textContent = `${fmtFrame(f)} · ${fmtSec(f, fps())} · ${fmtTC(f, fps())}`
  $('beat').textContent = sceneAt(f) ? `beat ${sceneAt(f)}` : ''
  const { in: a, out: b } = S.marks
  $('range').textContent = a !== null || b !== null
    ? `IN ${a !== null ? fmtFrame(a) : '—'}  OUT ${b !== null ? fmtFrame(b) : '—'}${a !== null && b !== null ? `  (${((b - a + 1) / fps()).toFixed(2)} s)` : ''}` : ''
  $('play').textContent = v.paused ? '▶ Play' : '❚❚ Pause'
  $('loop').classList.toggle('on', S.loop)
  $('pin').textContent = pinText()
  $('boxinfo').textContent = S.box ? 'Box drawn · Esc clears' : 'No box'
  placeHead()
}

function pinText() {
  const { f0, f1 } = noteRange()
  return `pins to ${fmtRange(f0, f1, fps())}`
}
function noteRange() {
  let f0 = S.marks.in ?? S.frame, f1 = S.marks.out ?? (S.marks.in !== null ? Math.max(S.marks.in, S.frame) : S.frame)
  if (f1 < f0) [f0, f1] = [f1, f0]
  return { f0, f1 }
}

// ------------------------------------------------------------------ timeline
const pct = f => `${(100 * f) / Math.max(1, lastFrame())}%`
function drawTimeline() {
  const beats = $('tl-beats'); beats.innerHTML = ''
  for (const s of S.scenes) {
    const d = document.createElement('div'); d.className = 'tl-beat'; d.textContent = s.id; d.title = `${s.id} · ${s.t0.toFixed(2)}–${s.t1.toFixed(2)} s`
    d.style.left = pct(s.t0 * fps()); d.style.width = `${(100 * (s.t1 - s.t0) * fps()) / Math.max(1, lastFrame())}%`
    beats.appendChild(d)
  }
  const ticks = $('tl-ticks'); ticks.innerHTML = ''
  const dur = S.meta?.duration ?? 0, every = dur > 120 ? 15 : dur > 40 ? 10 : 5
  for (let t = 0; t <= dur; t += every) { const s = document.createElement('span'); s.style.left = pct(t * fps()); s.textContent = `${t}s`; ticks.appendChild(s) }
  drawNoteMarks()
}
function drawNoteMarks() {
  const box = $('tl-notes'); box.innerHTML = ''
  for (const n of S.notes.filter(n => n.video === S.video)) {
    const d = document.createElement('div'); d.className = `tl-note ${n.status}`; d.style.left = pct(n.f0)
    d.style.width = `calc(${(100 * (n.f1 - n.f0)) / Math.max(1, lastFrame())}% + 4px)`; d.title = `${fmtRange(n.f0, n.f1, n.fps)} · ${n.text}`
    d.addEventListener('pointerdown', e => { e.stopPropagation(); selectNote(n.id) })
    box.appendChild(d)
  }
}
function placeHead() {
  $('tl-head').style.left = pct(S.frame)
  const r = $('tl-range'), { in: a, out: b } = S.marks
  if (a === null && b === null) { r.style.display = 'none'; return }
  const lo = a ?? S.frame, hi = b ?? Math.max(lo, S.frame)
  r.style.display = 'block'; r.style.left = pct(Math.min(lo, hi)); r.style.width = `${(100 * Math.abs(hi - lo)) / Math.max(1, lastFrame())}%`
}
function scrubTo(ev) {
  const r = $('timeline').getBoundingClientRect()
  const f = Math.round(((ev.clientX - r.left) / r.width) * lastFrame())
  if (!v.paused) v.pause()
  seek(f)
}
$('timeline').addEventListener('pointerdown', ev => {
  $('timeline').setPointerCapture(ev.pointerId); scrubTo(ev)
  const move = e => scrubTo(e)
  const up = () => { $('timeline').removeEventListener('pointermove', move); $('timeline').removeEventListener('pointerup', up) }
  $('timeline').addEventListener('pointermove', move); $('timeline').addEventListener('pointerup', up)
})

// ------------------------------------------------------------------ box drawing over the picture
function contentRect() {   // where the video picture sits inside the stage (object-fit: contain)
  const r = overlay.getBoundingClientRect(), vw = v.videoWidth || 16, vh = v.videoHeight || 9
  const s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s
  return { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h, cw: r.width, ch: r.height }
}
function drawOverlay() {
  const dpr = window.devicePixelRatio || 1, c = contentRect()
  overlay.width = Math.round(c.cw * dpr); overlay.height = Math.round(c.ch * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, c.cw, c.ch)
  const sel = S.notes.find(n => n.id === S.selected)
  const b = S.box ?? (sel && sel.box && S.frame >= sel.f0 && S.frame <= sel.f1 ? sel.box : null)
  if (!b) return
  ctx.strokeStyle = '#ffcc33'; ctx.lineWidth = 3; ctx.setLineDash(S.box ? [] : [8, 6])
  ctx.fillStyle = 'rgba(255,204,51,.10)'
  const x = c.x + b.x * c.w, y = c.y + b.y * c.h, w = b.w * c.w, h = b.h * c.h
  ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h)
}
let drag = null
overlay.addEventListener('pointerdown', ev => {
  if (!v.paused) v.pause()
  const c = contentRect(), r = overlay.getBoundingClientRect()
  const p = { x: (ev.clientX - r.left - c.x) / c.w, y: (ev.clientY - r.top - c.y) / c.h }
  drag = { x0: Math.max(0, Math.min(1, p.x)), y0: Math.max(0, Math.min(1, p.y)) }
  overlay.setPointerCapture(ev.pointerId); $('stage-hint').style.opacity = 0
})
overlay.addEventListener('pointermove', ev => {
  if (!drag) return
  const c = contentRect(), r = overlay.getBoundingClientRect()
  const x = Math.max(0, Math.min(1, (ev.clientX - r.left - c.x) / c.w)), y = Math.max(0, Math.min(1, (ev.clientY - r.top - c.y) / c.h))
  S.box = { x: Math.min(drag.x0, x), y: Math.min(drag.y0, y), w: Math.abs(x - drag.x0), h: Math.abs(y - drag.y0) }
  drawOverlay()
})
overlay.addEventListener('pointerup', () => {
  if (S.box && (S.box.w < 0.01 || S.box.h < 0.01)) S.box = null   // a click, not a box
  drag = null; drawOverlay(); updateReadout()
})
new ResizeObserver(drawOverlay).observe($('stage'))

// ------------------------------------------------------------------ notes
async function mutate(fn) {   // read the file fresh, change it, write it: never overwrites what Claude or the mod wrote meanwhile
  const { notes } = await api('/api/notes', { project: S.project })
  const r = await api('/api/notes', { project: S.project }, { notes: fn(notes) })
  S.notes = r.notes; S.mtime = Date.now(); renderNotes(); drawNoteMarks(); drawOverlay()
}

async function snapshot(id) {
  const vw = v.videoWidth, vh = v.videoHeight, w = Math.min(960, vw), h = Math.round((vh * w) / vw)
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const g = c.getContext('2d'); g.drawImage(v, 0, 0, w, h)
  if (S.box) { g.strokeStyle = '#ffcc33'; g.lineWidth = 4; g.strokeRect(S.box.x * w, S.box.y * h, S.box.w * w, S.box.h * h) }
  const r = await api('/api/snapshot', { project: S.project }, { id, dataUrl: c.toDataURL('image/jpeg', 0.85) })
  return r.snap
}

async function saveNote() {
  const text = $('note').value.trim()
  if (!text) { $('note').focus(); toast('Write what should change first.'); return }
  if (!S.meta) return
  if (!v.paused) { v.pause(); seek(Math.floor(v.currentTime * fps() + 1e-3)) }
  const { f0, f1 } = noteRange()
  const id = newId()
  // snapshot the first frame of the range
  if (S.frame !== f0) { seek(f0); await new Promise(r => v.addEventListener('seeked', r, { once: true })) }
  let snap
  if ($('snap').checked) { try { snap = await snapshot(id) } catch { toast('Saved without a snapshot: the frame could not be captured') } }
  const note = { id, video: S.video, f0, f1, fps: fps(), kind: S.kind, text, scene: sceneAt(f0), status: 'open', createdAt: new Date().toISOString() }
  if (S.box) note.box = { x: +S.box.x.toFixed(4), y: +S.box.y.toFixed(4), w: +S.box.w.toFixed(4), h: +S.box.h.toFixed(4) }
  if (snap) note.snap = snap
  await mutate(list => [...list, note])
  $('note').value = ''; S.box = null; S.marks = { in: null, out: null }; S.selected = id
  updateReadout(); drawOverlay(); toast(`Saved ${fmtRange(f0, f1, fps())}`)
}

async function selectNote(id) {
  const n = S.notes.find(x => x.id === id); if (!n) return
  S.selected = id; S.box = null
  if (!v.paused) v.pause()
  if (n.video !== S.video && [...$('video').options].some(o => o.value === n.video)) { $('video').value = n.video; await openVideo(n.video) }
  S.marks = n.f0 === n.f1 ? { in: null, out: null } : { in: n.f0, out: n.f1 }
  seek(n.f0); renderNotes(); drawOverlay()
  if (S.frame !== n.f0 || v.seeking) await new Promise(r => v.addEventListener('seeked', r, { once: true }))
}

function jumpNote(d) {   // the open note before (-1) or after (1) the playhead, on this render
  const open = S.notes.filter(n => n.status === 'open' && n.video === S.video).sort((a, b) => a.f0 - b.f0)
  const n = d === 1 ? open.find(x => x.f0 > S.frame) : [...open].reverse().find(x => x.f0 < S.frame)
  if (!n) { toast(`No open note ${d === 1 ? 'after' : 'before'} ${fmtFrame(S.frame)} on this render`); return }
  selectNote(n.id)
}

async function deleteNote(id) {
  const gone = S.notes.find(x => x.id === id); if (!gone) return
  await mutate(l => l.filter(x => x.id !== id))
  S.undo = gone
  toast(`Deleted the note at ${fmtRange(gone.f0, gone.f1, gone.fps)}`, { label: 'Undo', run: undoDelete })
}
async function undoDelete() {
  const n = S.undo; if (!n) return
  S.undo = null
  await mutate(l => (l.some(x => x.id === n.id) ? l : [...l, n]))
  toast(`Restored the note at ${fmtRange(n.f0, n.f1, n.fps)}`)
}

function renderNotes() {
  const box = $('notes'); box.innerHTML = ''
  const open = S.notes.filter(n => n.status === 'open'), done = S.notes.filter(n => n.status === 'done')
  $('n-open').textContent = open.length || ''; $('n-done').textContent = done.length || ''
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.filter === S.filter))
  const list = (S.filter === 'open' ? open : S.filter === 'done' ? done : S.notes).slice().sort((a, b) => a.f0 - b.f0)
  if (!list.length) { box.innerHTML = `<div class="empty">${S.filter === 'done' ? 'Nothing ticked done yet.' : 'No notes yet. Pick a moment, write what should change, press Enter.'}</div>`; return }
  for (const n of list) {
    const el = document.createElement('div'); el.className = `note ${n.status}${n.id === S.selected ? ' sel' : ''}`
    const img = n.snap ? `<img src="/media?${q({ project: S.project, path: n.snap })}" alt="">` : '<div class="noimg"></div>'
    el.innerHTML = `${img}<div>
      <div class="meta">${fmtRange(n.f0, n.f1, n.fps)}${n.scene ? ` · ${esc(n.scene)}` : ''}${n.box ? ' · box' : ''}</div>
      <div class="meta">${kindLabel(n.kind)}${n.status === 'done' ? ` · done${n.doneIn ? ` in ${esc(n.doneIn)}` : ''}` : ''}${n.video !== S.video ? ` · on ${esc(n.video.replace(/^[^/]+\//, ''))}` : ''}</div>
      <div class="text"></div>
      <div class="acts"></div></div>`
    const textEl = el.querySelector('.text')
    if (S.editing === n.id) {
      const ta = document.createElement('textarea'); ta.value = n.text; ta.rows = 3; textEl.replaceWith(ta)
      ta.addEventListener('click', e => e.stopPropagation())
      ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); S.editing = null; mutate(l => l.map(x => x.id === n.id ? { ...x, text: ta.value.trim() || x.text } : x)) } if (e.key === 'Escape') { S.editing = null; renderNotes() } })
      setTimeout(() => ta.focus())
    } else textEl.textContent = n.text
    const acts = el.querySelector('.acts')
    const btn = (label, fn, cls = '') => { const b = document.createElement('button'); b.textContent = label; b.className = cls; b.addEventListener('click', e => { e.stopPropagation(); fn() }); acts.appendChild(b) }
    btn('▶ Play', async () => { await selectNote(n.id); S.loop = n.f1 > n.f0; await v.play().catch(() => {}); updateReadout() })
    // ticked done while a different render is open: record which render has the fix
    const doneIn = S.video && S.video !== n.video ? shortName(S.video).replace(/\.[^.]+$/, '') : undefined
    if (n.status === 'open') btn('Done', () => mutate(l => l.map(x => x.id === n.id ? { ...x, status: 'done', doneIn: doneIn ?? x.doneIn } : x)))
    else btn('Reopen', () => mutate(l => l.map(x => x.id === n.id ? { ...x, status: 'open', doneIn: undefined } : x)))
    btn('Edit', () => { S.editing = n.id; renderNotes() })
    btn('Delete', () => deleteNote(n.id), 'del')
    el.addEventListener('click', () => selectNote(n.id))
    box.appendChild(el)
  }
}

function notesAsText() {
  const open = S.notes.filter(n => n.status === 'open').sort((a, b) => a.f0 - b.f0)
  return [`Edit notes for ${S.project.split('/').pop()} (made on ${S.video}, ${fps()} fps). Full list: ${S.project}/notes/edit-notes.md`, '',
    ...open.map((n, i) => `${i + 1}. [${n.id}] ${fmtRange(n.f0, n.f1, n.fps)} (${fmtTC(n.f0, n.fps)}${n.scene ? `, beat ${n.scene}` : ''}${n.box ? ', box drawn' : ''}${n.snap ? `, snapshot ${n.snap}` : ''}) · ${kindLabel(n.kind)}: ${n.text}`)].join('\n')
}

// pick up ticks Claude (or the mod) writes into the file
setInterval(async () => {
  if (!S.project || document.hidden || S.editing) return
  const d = await api('/api/notes', { project: S.project })
  if (JSON.stringify(d.notes) !== JSON.stringify(S.notes)) { S.notes = d.notes; renderNotes(); drawNoteMarks() }
}, 2500)

// ------------------------------------------------------------------ controls
const ACT = {
  start: () => { v.pause(); seek(0) }, end: () => { v.pause(); seek(lastFrame()) },
  '-1s': () => step(-Math.round(fps())), '+1s': () => step(Math.round(fps())), '-1f': () => step(-1), '+1f': () => step(1),
  play: togglePlay,
  in: () => { S.marks.in = S.frame; if (S.marks.out !== null && S.marks.out < S.frame) S.marks.out = null; updateReadout() },
  out: () => { S.marks.out = S.frame; if (S.marks.in !== null && S.marks.in > S.frame) S.marks.in = null; updateReadout() },
  clear: () => { S.marks = { in: null, out: null }; S.box = null; S.loop = false; updateReadout(); drawOverlay() },
  loop: () => { S.loop = !S.loop; updateReadout() },
  'prev-note': () => jumpNote(-1), 'next-note': () => jumpNote(1),
}
document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => ACT[b.dataset.act]()))
document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { S.filter = b.dataset.filter; renderNotes() }))

const kinds = $('kinds')
KINDS.forEach(([k, label], i) => {
  const b = document.createElement('button'); b.innerHTML = `<span class="k">${i + 1}</span>${label}`; b.dataset.kind = k
  b.addEventListener('click', () => { S.kind = k; paintKinds() }); kinds.appendChild(b)
})
const paintKinds = () => kinds.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.kind === S.kind))
paintKinds()

$('save').addEventListener('click', saveNote)
$('note').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote() }
  if (e.key === 'Escape') $('note').blur()
})
$('goto').addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('goto').blur(); return }
  if (e.key !== 'Enter') return
  const r = parseWhen($('goto').value, fps())
  if ('error' in r) { toast(r.error); return }
  const f0 = Math.min(r.f0, lastFrame()), f1 = Math.min(r.f1, lastFrame())   // a range past the end stops at the last frame
  v.pause(); S.marks = f0 === f1 ? { in: null, out: null } : { in: f0, out: f1 }
  seek(f0); $('goto').value = ''; $('goto').blur()
})
$('project').addEventListener('change', e => openProject(e.target.value))
$('video').addEventListener('change', e => openVideo(e.target.value))
$('speed').addEventListener('change', e => { v.playbackRate = v.defaultPlaybackRate = Number(e.target.value); syncCompare(false) })
$('compare').addEventListener('change', e => { S.compare = e.target.value; showCompare() })
$('mute').addEventListener('change', e => { v.muted = e.target.checked })
$('copy').addEventListener('click', async () => {
  const text = notesAsText()
  try { await navigator.clipboard.writeText(text); toast('Open notes copied, paste them to Claude') }
  catch { $('copy-text').value = text; $('copy-dlg').showModal(); $('copy-text').select() }   // no clipboard access: copy by hand
})
$('help-btn').addEventListener('click', () => $('help').showModal())

document.addEventListener('keydown', e => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key
  const beatJump = d => {
    const i = S.scenes.findIndex(s => s.id === sceneAt(S.frame)), s = S.scenes[Math.max(0, Math.min(S.scenes.length - 1, i + d))]
    if (s) { v.pause(); seek(Math.round(s.t0 * fps())) }
  }
  const map = {
    ' ': togglePlay, k: togglePlay, K: togglePlay,
    ArrowLeft: () => step(e.shiftKey ? -Math.round(fps()) : -1), ArrowRight: () => step(e.shiftKey ? Math.round(fps()) : 1),
    j: () => step(-Math.round(fps())), l: () => step(Math.round(fps())), Home: ACT.start, End: ACT.end,
    ArrowUp: () => beatJump(-1), ArrowDown: () => beatJump(1),
    i: ACT.in, o: ACT.out, x: ACT.clear, p: ACT.loop, n: () => $('note').focus(), g: () => $('goto').focus(),
    Escape: () => { S.box = null; drawOverlay(); updateReadout() }, '?': () => $('help').showModal(),
    '[': () => jumpNote(-1), ']': () => jumpNote(1), u: undoDelete,
    c: () => { const o = [...$('compare').options]; S.compare = S.compare ? '' : (o[1]?.value ?? ''); $('compare').value = S.compare; showCompare() },
  }
  if (/^[1-8]$/.test(k)) { S.kind = KINDS[Number(k) - 1][0]; paintKinds(); e.preventDefault(); return }
  const fn = map[k] ?? map[k.toLowerCase?.()]
  if (fn) { e.preventDefault(); fn() }
})

v.addEventListener('pause', () => { syncCompare(true); updateReadout() }); v.addEventListener('play', () => { syncCompare(false); updateReadout() })
v.addEventListener('seeked', drawOverlay)
v.requestVideoFrameCallback(onFrame)
loadProjects()
