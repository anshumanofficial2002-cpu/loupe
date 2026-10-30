export type NoteKind = 'effect' | 'text' | 'cut' | 'sound' | 'music' | 'colour' | 'broll' | 'other'

export type Note = {
  id: string
  /** the render the note was made on, relative to the project */
  video: string
  /** first and last frame, inclusive (equal for a single frame) */
  f0: number
  f1: number
  fps: number
  kind: NoteKind
  text: string
  /** the film's beat (work/scenes.json) the note starts in, if any */
  scene?: string
  status: 'open' | 'done'
  /** the render version that has the change, set when Claude ticks it done */
  doneIn?: string
  createdAt: string
  /** where on the frame, as fractions of width/height from the top-left (drawn by a review tool that writes the same notes file) */
  box?: { x: number; y: number; w: number; h: number }
  /** project-relative path of the JPEG snapshot of the note's first frame */
  snap?: string
}

export type VideoMeta = { fps: number; duration: number; frames: number; width: number; height: number }

export type Scene = { id: string; t0: number; t1: number }

export type Preview = { frame: number; video: string; b64: string; w: number; h: number }

export type Marks = { in: number | null; out: number | null }

declare module 'claude-code' {
  interface PluginState {
    'loupe': {
      project: string | null
      projects: string[]
      videos: string[]
      video: string | null
      meta: VideoMeta | null
      frame: number
      preview: Preview | null
      marks: Marks
      kind: NoteKind
      notes: Shaped<Note[]>
      scenes: Scene[]
      msg: string
      filter: 'open' | 'done' | 'all'
      editing: string | null
      undo: Note | null
    }
  }
}
