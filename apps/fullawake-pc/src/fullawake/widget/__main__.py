import argparse
import hmac
import math
import secrets
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from starlette.responses import FileResponse

HERE = Path(__file__).resolve().parent


class ClockState:
    def __init__(self):
        self.lock = threading.Lock()
        self.frames = {}
        self.owners = {}

    def claim(self, role, connection):
        with self.lock:
            if role in self.owners:
                return False
            self.owners[role] = connection
            return True

    def publish(self, role, value, now=None):
        now = time.monotonic() if now is None else now
        if not isinstance(value, dict):
            raise ValueError("Expected a clock object")
        with self.lock:
            if role == "player":
                if value.get("mode") == "idle":
                    self.frames.pop("player", None)
                    return
                position = value.get("positionMs")
                mouth = value.get("mouth")
                utterance = value.get("utteranceId")
                if (value.get("mode") != "speaking" or type(position) is not int or position < 0
                        or type(mouth) is not int or mouth not in (0, 1, 2)
                        or not isinstance(utterance, str) or len(utterance) > 80):
                    raise ValueError("Invalid playback clock")
                self.frames["player"] = (now, {
                    "mode": "speaking", "utteranceId": utterance, "positionMs": position, "mouth": mouth,
                })
            elif value.get("intent") in ("nod", "smile", "wave"):
                self.frames["intent"] = (now, value["intent"])
            elif value.get("mode") in ("idle", "listening", "thinking", "resting"):
                energy = value.get("energy")
                if type(energy) not in (int, float) or not 0 <= energy <= 1:
                    raise ValueError("Invalid motion energy")
                self.frames["heart"] = (now, {"mode": value["mode"], "energy": energy})
            else:
                raise ValueError("Invalid motion state")

    def release(self, role, connection):
        with self.lock:
            if self.owners.get(role) is connection:
                self.owners.pop(role)
                self.frames.pop(role, None)
                if role == "heart":
                    self.frames.pop("intent", None)

    def snapshot(self, now=None):
        now = time.monotonic() if now is None else now
        with self.lock:
            frame = {"mode": "idle", "energy": 0.5, "mouth": 0, "positionMs": 0}
            if "heart" in self.frames:
                frame.update(self.frames["heart"][1])
            if "player" in self.frames:
                at, playing = self.frames["player"]
                if now - at < 0.3:
                    frame.update(playing)
            if "intent" in self.frames:
                at, intent = self.frames["intent"]
                if now - at < 1.2:
                    frame["intent"] = intent
            return frame


def make_app(clock, token, port, motion_path):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/")
    async def page():
        return FileResponse(HERE / "player.html")

    @app.get("/player.mjs")
    async def player():
        return FileResponse(HERE / "player.mjs", media_type="text/javascript")

    @app.get("/motion.mjs")
    async def motion():
        return FileResponse(motion_path, media_type="text/javascript")

    @app.websocket("/clock")
    async def publish(socket: WebSocket):
        origin = socket.headers.get("origin")
        supplied = socket.query_params.get("token", "")
        if origin not in (None, f"http://127.0.0.1:{port}") or not hmac.compare_digest(supplied.encode(), token.encode()):
            await socket.close(code=1008)
            return
        role = "heart" if origin is None else "player"
        if not clock.claim(role, socket):
            await socket.close(code=1008)
            return
        try:
            await socket.accept()
            while True:
                clock.publish(role, await socket.receive_json())
        except WebSocketDisconnect:
            pass
        except ValueError:
            await socket.close(code=1007)
        finally:
            clock.release(role, socket)

    return app


def show_window(clock, name, portrait=None):
    import tkinter as tk

    root = tk.Tk()
    root.title(f"LucidHeart · {name}")
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    key = "#ff00ff"
    root.wm_attributes("-transparentcolor", key)
    root.geometry(f"220x258+{max(0, root.winfo_screenwidth() - 256)}+80")
    canvas = tk.Canvas(root, width=220, height=258, bg=key, highlightthickness=0)
    canvas.pack()
    image = tk.PhotoImage(file=portrait) if portrait else None
    if image:
        scale = max(1, math.ceil(max(image.width() / 196, image.height() / 195)))
        image = image.subsample(scale)
    drag = [0, 0]

    def start_drag(event):
        drag[:] = [event.x_root - root.winfo_x(), event.y_root - root.winfo_y()]

    canvas.bind("<ButtonPress-1>", start_drag)
    canvas.bind("<B1-Motion>", lambda event: root.geometry(f"+{max(0, event.x_root - drag[0])}+{max(0, event.y_root - drag[1])}"))
    canvas.bind("<Button-3>", lambda _event: root.destroy())
    root.bind("<Escape>", lambda _event: root.destroy())
    start = time.monotonic()
    labels = {"idle": "在这里", "listening": "在听", "thinking": "想一想", "speaking": "说话中", "resting": "休息中"}

    def draw():
        now = time.monotonic()
        frame = clock.snapshot(now)
        elapsed = now - start
        dy = round(math.sin(elapsed * 2) * (2 + frame["energy"] * 2))
        if frame.get("intent") == "nod":
            dy += round(abs(math.sin(elapsed * 8)) * 7)
        canvas.delete("all")
        if image:
            canvas.create_image(110, 109 + dy, image=image)
        else:
            canvas.create_oval(30, 139 + dy, 190, 213 + dy, fill="#8e84c7", outline="")
            canvas.create_oval(42, 21 + dy, 178, 166 + dy, fill="#403659", outline="")
            canvas.create_oval(54, 46 + dy, 166, 169 + dy, fill="#ffe0cf", outline="")
            canvas.create_arc(48, 31 + dy, 169, 115 + dy, start=6, extent=176, fill="#403659", outline="")
            blink = elapsed % 5.1 < 0.13 or frame["mode"] == "resting"
            for x in (83, 137):
                canvas.create_oval(x - 5, 107 + dy, x + 5, 107 + dy + (2 if blink else 13), fill="#392e50", outline="")
            mouth = (2, 8, 16)[frame["mouth"]]
            if frame.get("intent") == "smile" and frame["mode"] != "speaking":
                canvas.create_arc(98, 133 + dy, 122, 148 + dy, start=180, extent=180, style=tk.ARC, outline="#a65c73", width=2)
            else:
                canvas.create_oval(102, 140 + dy, 118, 140 + dy + mouth, fill="#a65c73", outline="")
        canvas.create_rectangle(24, 218, 196, 250, fill="#2c2341", outline="")
        if frame.get("intent") == "wave":
            canvas.create_text(186, 110 + dy, text="✦", font=("Segoe UI", 21), fill="#ffd38e")
        text = f"{name} · {labels[frame['mode']]}"
        if frame["mode"] == "speaking":
            text += f" {frame['positionMs'] / 1000:.1f}s"
        canvas.create_text(110, 234, text=text, font=("Microsoft YaHei UI", 10), fill="#faf3ff")
        root.after(33, draw)

    draw()
    root.mainloop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--name", default="小满")
    parser.add_argument("--portrait", help="Local PNG or GIF to use as the sprite")
    parser.add_argument("--watch", action="store_true", help="Connect to the FullAwake watch gateway")
    parser.add_argument("--gateway-port", type=int, default=8765)
    parser.add_argument("--token", default=None)
    parser.add_argument("--motion", type=Path, default=HERE.parents[4] / "packages/heart/lib/motion.js")
    args = parser.parse_args()
    if args.watch:
        from .watch_pet import run_pet
        run_pet(args.gateway_port, args.name, args.portrait)
        return
    if not args.motion.is_file():
        parser.error("Supply the Heart motion.js source with --motion")
    token = args.token or secrets.token_urlsafe(24)
    if not all(c.isalnum() or c in "-_" for c in token) or len(token) < 16:
        parser.error("Use a URL-safe token of at least 16 characters")
    clock = ClockState()
    server = uvicorn.Server(uvicorn.Config(
        make_app(clock, token, args.port, args.motion), host="127.0.0.1", port=args.port,
        ws="wsproto", access_log=False,
    ))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    print(f"Playback monitor: http://127.0.0.1:{args.port}/#{token}", flush=True)
    try:
        show_window(clock, args.name, args.portrait)
    finally:
        server.should_exit = True
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
