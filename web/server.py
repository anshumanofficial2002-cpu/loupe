#!/usr/bin/env python3
"""Loupe web — a local review player for renders. Serves the page, streams videos (HTTP Range, so seeking works),
and reads/writes each project's notes/edit-notes.json + .md (the same file the Loupe mod in Claude Code uses),
plus one JPEG snapshot per note in notes/snaps/.

A "project" is any folder under --root (or --root itself) with videos in exports/, renders/, out/ or output/.

Run:  python3 web/server.py --root ~/my-videos --port 5410     then open http://localhost:5410  (--root defaults to the current folder)
Standard library only. Binds 127.0.0.1; every path it serves is checked to stay inside --root.
"""
import argparse, base64, json, mimetypes, os, re, shutil, subprocess, sys, time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
VIDEO_RE = re.compile(r"\.(mp4|mov|m4v|webm)$", re.I)
RENDER_DIRS = ("exports", "renders", "out", "output")   # where a project keeps its renders, as in the mod
KINDS = {"effect": "Effect / motion", "text": "Text / captions", "cut": "Cut / timing", "sound": "Sound effects",
         "music": "Music", "colour": "Colour / grade", "broll": "B-roll swap", "other": "Other"}
ROOT = ""

def inside(path):
    real = os.path.realpath(path)
    return real == ROOT or real.startswith(ROOT + os.sep)

def renders(proj):
    """Every video in the project's render folders, newest first, as (relative path, mtime)."""
    out = []
    for d in RENDER_DIRS:
        ex = os.path.join(proj, d)
        if os.path.isdir(ex):
            out += [(f"{d}/{f}", os.path.getmtime(os.path.join(ex, f))) for f in os.listdir(ex)
                    if VIDEO_RE.search(f) and os.path.isfile(os.path.join(ex, f))]
    return sorted(out, key=lambda r: -r[1])

def projects():
    out = []
    cands = [ROOT] + [os.path.join(ROOT, d) for d in sorted(os.listdir(ROOT))
                      if not d.startswith(".") and os.path.isdir(os.path.join(ROOT, d))]
    for d in cands:
        found = renders(d)
        if found:
            out.append({"path": d, "name": os.path.basename(d) or d, "newest": found[0][1]})
    return sorted(out, key=lambda p: -p["newest"])

def videos(proj):
    return [rel for rel, _ in renders(proj)]

def ffprobe():
    for d in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"):
        if os.path.exists(f"{d}/ffprobe"):
            return f"{d}/ffprobe"
    return shutil.which("ffprobe") or "ffprobe"

def probe(abs_path):
    r = subprocess.run([ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=r_frame_rate,width,height:format=duration", "-of", "json", abs_path], capture_output=True, text=True)
    j = json.loads(r.stdout or "{}")
    s = (j.get("streams") or [{}])[0]
    num, den = (s.get("r_frame_rate") or "24/1").split("/")
    fps = float(num) / (float(den) or 1)
    dur = float((j.get("format") or {}).get("duration") or 0)
    return {"fps": fps, "duration": dur, "frames": max(1, int(dur * fps + 1e-6)), "width": s.get("width", 0), "height": s.get("height", 0)}

def scenes(proj):
    p = os.path.join(proj, "work", "scenes.json")
    try:
        return [{"id": r["id"], "t0": r["t0"], "t1": r["t1"]} for r in json.load(open(p))]
    except Exception:
        return []

def notes_path(proj):
    return os.path.join(proj, "notes", "edit-notes.json")

def load_notes(proj):
    try:
        return json.load(open(notes_path(proj)))
    except Exception:
        return []

def fmt_range(n):
    f0, f1, fps = n["f0"], n["f1"], n["fps"]
    if f0 == f1:
        return f"F{f0:04d} · {f0 / fps:.2f} s"
    return f"F{f0:04d}–F{f1:04d} · {f0 / fps:.2f}–{f1 / fps:.2f} s"

def tc(f, fps):
    b = round(fps); s = f // b
    return f"{s // 60:02d}:{s % 60:02d}:{f % b:02d}"

def save_notes(proj, notes):
    notes = sorted(notes, key=lambda n: (n["f0"], n.get("createdAt", "")))
    os.makedirs(os.path.join(proj, "notes"), exist_ok=True)
    tmp = notes_path(proj) + ".tmp"
    json.dump(notes, open(tmp, "w"), indent=1, ensure_ascii=False); open(tmp, "a").write("\n")
    os.replace(tmp, notes_path(proj))
    lines = [f"# Edit notes — {os.path.basename(proj)}", "",
             "Written by Loupe. Frames are inclusive; times are seconds from the start of the render. "
             "Boxes are fractions of the frame (x, y, w, h from the top-left).", ""]
    for status, title in (("open", "Open"), ("done", "Done")):
        rows = [n for n in notes if n.get("status") == status]
        lines += [f"## {title} ({len(rows)})", ""]
        for n in rows:
            extra = []
            if n.get("scene"): extra.append(f"beat `{n['scene']}`")
            if n.get("box"): extra.append("box x{x:.2f} y{y:.2f} w{w:.2f} h{h:.2f}".format(**n["box"]))
            if n.get("snap"): extra.append(f"snapshot `{n['snap']}`")
            lines.append(f"- **{fmt_range(n)}** ({tc(n['f0'], n['fps'])}{', ' + ', '.join(extra) if extra else ''}) · "
                         f"{KINDS.get(n.get('kind'), n.get('kind'))}{' · done in ' + n['doneIn'] if n.get('doneIn') else ''}"
                         f" · id `{n['id']}` · on `{n.get('video', '')}`")
            lines.append("  " + n.get("text", "").replace("\n", "\n  "))
        lines.append("")
    open(os.path.join(proj, "notes", "edit-notes.md"), "w").write("\n".join(lines))
    return notes

class H(BaseHTTPRequestHandler):
    server_version = "Loupe/0.1"

    def log_message(self, fmt, *args):  # quiet, but keep errors
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("%s %s\n" % (self.command, fmt % args))

    def send_json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(b)

    def fail(self, code, msg):
        self.send_json({"error": msg}, code)

    def proj_arg(self, q):   # parse_qs has already percent-decoded every value
        p = os.path.realpath(os.path.expanduser((q.get("project") or [""])[0]))
        if not p or not inside(p) or not os.path.isdir(p):
            raise ValueError("unknown project")
        return p

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        try:
            if u.path in ("/", "/index.html"):
                return self.static("index.html")
            if u.path in ("/app.js", "/app.css", "/time.js"):
                return self.static(u.path[1:])
            if u.path == "/api/projects":
                return self.send_json({"root": ROOT, "projects": projects()})
            if u.path == "/api/project":
                p = self.proj_arg(q)
                return self.send_json({"videos": videos(p), "scenes": scenes(p), "notes": load_notes(p)})
            if u.path == "/api/meta":
                p = self.proj_arg(q); v = q["video"][0]; a = os.path.join(p, v)
                if not inside(a) or not os.path.isfile(a): return self.fail(404, "no such video")
                return self.send_json(probe(a))
            if u.path == "/api/notes":
                p = self.proj_arg(q)
                st = os.stat(notes_path(p)).st_mtime if os.path.exists(notes_path(p)) else 0
                return self.send_json({"notes": load_notes(p), "mtime": st})
            if u.path == "/media":
                p = self.proj_arg(q); rel = q["path"][0]; a = os.path.realpath(os.path.join(p, rel))
                if not inside(a) or not os.path.isfile(a): return self.fail(404, "not found")
                return self.file(a)
            return self.fail(404, "not found")
        except (ValueError, KeyError) as e:
            return self.fail(400, str(e))

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        try:
            p = self.proj_arg(q)
            if u.path == "/api/notes":          # replace the whole list (the page sends what it holds)
                notes = self.body().get("notes")
                if not isinstance(notes, list): return self.fail(400, "notes must be a list")
                return self.send_json({"notes": save_notes(p, notes)})
            if u.path == "/api/snapshot":       # { id, dataUrl } → notes/snaps/<id>.jpg
                b = self.body(); nid = re.sub(r"[^A-Za-z0-9_-]", "", b.get("id", ""))
                data = b.get("dataUrl", "").split(",", 1)[-1]
                if not nid or not data: return self.fail(400, "id and dataUrl needed")
                os.makedirs(os.path.join(p, "notes", "snaps"), exist_ok=True)
                rel = f"notes/snaps/{nid}.jpg"
                open(os.path.join(p, rel), "wb").write(base64.b64decode(data))
                return self.send_json({"snap": rel})
            return self.fail(404, "not found")
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            return self.fail(400, str(e))

    def static(self, name):
        path = os.path.join(HERE, name)
        b = open(path, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", (mimetypes.guess_type(path)[0] or "text/plain") + "; charset=utf-8")
        self.send_header("Content-Length", str(len(b))); self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(b)

    def file(self, path):  # byte ranges, so the <video> can seek
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].split(",")[0].partition("-")
            if a: start = int(a); end = int(b) if b else size - 1
            else: start = size - int(b)
            end = min(end, size - 1)
            if start > end:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE); self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers(); return
            self.send_response(206); self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype); self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1)); self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start); left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk: break
                    self.wfile.write(chunk); left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

def main():
    global ROOT
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.getcwd(), help="folder holding your projects (default: the current folder)")
    ap.add_argument("--port", type=int, default=5410)
    a = ap.parse_args()
    ROOT = os.path.realpath(os.path.expanduser(a.root))
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    print(f"Loupe on http://localhost:{a.port}  (root {ROOT})", flush=True)
    srv.serve_forever()

if __name__ == "__main__":
    main()
