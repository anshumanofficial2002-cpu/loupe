// Time and frame helpers: what the "Go to" field accepts and how a frame is written back.

export type Range = { f0: number; f1: number }

/** One moment: `f300` / `300f` / `#300` (frame), `12.5` / `12.5s` (seconds), `0:12.5` (m:ss), `0:12:05` (mm:ss:ff), `0:00:12:05` (hh:mm:ss:ff). */
export function parseMoment(raw: string, fps: number): number | null {
  const s = raw.trim().toLowerCase()
  if (s === '') return null
  const frame = s.match(/^(?:f|#)\s*(\d+)$/) ?? s.match(/^(\d+)\s*f$/)
  if (frame) return Number(frame[1])
  const secs = s.match(/^(\d+(?:\.\d+)?)\s*s?$/)
  if (secs) return Math.round(Number(secs[1]) * fps)
  const parts = s.split(':')
  if (parts.some(p => !/^\d+(?:\.\d+)?$/.test(p))) return null
  const n = parts.map(Number)
  if (n.length === 2) return Math.round(((n[0] ?? 0) * 60 + (n[1] ?? 0)) * fps)
  if (n.length === 3) return Math.round(((n[0] ?? 0) * 60 + (n[1] ?? 0)) * fps + (n[2] ?? 0))
  if (n.length === 4) return Math.round(((n[0] ?? 0) * 3600 + (n[1] ?? 0) * 60 + (n[2] ?? 0)) * fps + (n[3] ?? 0))
  return null
}

/** A moment or a range: `12.5-14`, `f300 to f336`, `0:12:00 – 0:14:00`, `12.5 → 14`. */
export function parseWhen(raw: string, fps: number): Range | { error: string } {
  const pieces = raw.split(/\s*(?:\bto\b|–|—|→|(?<=[\d.sf])\s*-\s*(?=[\d#f]))\s*/i).filter(p => p.trim() !== '')
  if (pieces.length === 0 || pieces.length > 2) return { error: 'Type a time, a frame or a range, e.g. 12.5, f300, 0:12:05 or 12.5-14.' }
  const f0 = parseMoment(pieces[0] ?? '', fps)
  const f1 = pieces.length === 2 ? parseMoment(pieces[1] ?? '', fps) : f0
  if (f0 === null || f1 === null) return { error: `Can't read "${raw.trim()}". Try 12.5, f300, 0:12:05 or 12.5-14.` }
  if (f1 < f0) return { error: 'The range ends before it starts.' }
  return { f0, f1 }
}

export const pad = (n: number, w: number) => String(n).padStart(w, '0')

/** F0300 */
export const fmtFrame = (f: number) => `F${pad(f, 4)}`

/** 12.50 s */
export const fmtSec = (f: number, fps: number) => `${(f / fps).toFixed(2)} s`

/** 00:12:12 — minutes:seconds:frames, the editor's timecode */
export function fmtTC(f: number, fps: number): string {
  const base = Math.round(fps)
  const total = Math.floor(f / base)
  return `${pad(Math.floor(total / 60), 2)}:${pad(total % 60, 2)}:${pad(f % base, 2)}`
}

/** "F0300–F0336 · 12.50–14.00 s" or "F0300 · 12.50 s" */
export function fmtRange(f0: number, f1: number, fps: number): string {
  if (f0 === f1) return `${fmtFrame(f0)} · ${fmtSec(f0, fps)}`
  return `${fmtFrame(f0)}–${fmtFrame(f1)} · ${(f0 / fps).toFixed(2)}–${(f1 / fps).toFixed(2)} s`
}
