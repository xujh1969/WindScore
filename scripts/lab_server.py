"""Loopback-only GAME bridge. Run through `npm run lab:serve`."""
import csv
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import wave

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.lab-runtime'
GAME = RUNTIME / 'GAME-1.0.3'
MODEL = RUNTIME / 'model' / 'model.pt'
TOKEN = secrets.token_urlsafe(32)
MAX_BYTES = 160 * 1024 * 1024
ORIGINS = {'http://localhost:5173', 'http://127.0.0.1:5173',
           'http://localhost:4173', 'http://127.0.0.1:4173',
           'tauri://localhost', 'https://tauri.localhost', 'http://tauri.localhost'}
LOCK = threading.Lock()
JOBS = {}


def readiness():
    missing = []
    if not (GAME / 'infer.py').is_file():
        missing.append('GAME source')
    if not MODEL.is_file() or not all((MODEL.parent / name).is_file() for name in ('config.yaml', 'lang_map.json')):
        missing.append('GAME model/config')
    for module in ('torch', 'lightning', 'librosa', 'pydantic', 'mido'):
        if importlib.util.find_spec(module) is None:
            missing.append(module)
    return {'ready': not missing, 'engine': 'GAME', 'missing': missing}


def parse_notes(path):
    notes = []
    with path.open(encoding='utf-8-sig', newline='') as f:
        for row in csv.DictReader(f):
            start, end, pitch = (float(row[k]) for k in ('onset', 'offset', 'pitch'))
            if not all(math.isfinite(v) for v in (start, end, pitch)):
                raise ValueError('模型返回了无效的音符')
            if 0 <= start < end and 0 <= pitch <= 127:
                notes.append({'start': start, 'end': end, 'midi': pitch, 'amp': 1})
    return notes


def update(job, **fields):
    with LOCK:
        job.update(fields)


def stop_process(proc):
    if proc.poll() is not None:
        return
    # Windows venv python.exe launches a child interpreter; cancel the whole tree.
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
    else:
        proc.kill()


def transcribe_job(job, audio, language):
    try:
        with tempfile.TemporaryDirectory(prefix='windscore-game-') as tmp:
            tmp = Path(tmp)
            wav = tmp / 'vocal.wav'
            wav.write_bytes(audio)
            command = [sys.executable, str(GAME / 'infer.py'), 'extract', str(wav),
                       '-m', str(MODEL), '--language', language, '--batch-size', '1',
                       '--num-workers', '0', '--output-formats', 'csv', '--pitch-format', 'number']
            # Arguments are fixed/validated; no shell or client-supplied paths.
            with (tmp / 'inference.log').open('w+', encoding='utf-8') as log:
                with LOCK:
                    if job['status'] == 'cancelled':
                        return
                    proc = subprocess.Popen(command, cwd=GAME, stdout=log, stderr=log,
                                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                                            env={**os.environ, 'PYTHONUTF8': '1', 'MPLBACKEND': 'Agg'})
                    job.update(status='running', process=proc, message='正在识别歌唱音符，CPU 模式可能需要较长时间')
                try:
                    code = proc.wait(timeout=3600)
                except subprocess.TimeoutExpired:
                    stop_process(proc)
                    proc.wait()
                    raise RuntimeError('识别超过一小时，建议截取较短片段重试')
                with LOCK:
                    if job['status'] == 'cancelled':
                        return
                if code != 0:
                    log.seek(0)
                    detail = log.read()[-3000:]
                    print(detail, file=sys.stderr)
                    raise RuntimeError('GAME 识别失败，请查看本机服务日志中的模型或依赖错误')
                notes = parse_notes(wav.with_suffix('.csv'))
                update(job, status='done', notes=notes, message='识别完成')
    except Exception as error:
        with LOCK:
            if job['status'] != 'cancelled':
                job.update(status='error', message=str(error))
    finally:
        update(job, process=None, finished=time.time())


class Handler(BaseHTTPRequestHandler):
    def permitted(self):
        if self.headers.get('Host') not in ('127.0.0.1:8766', 'localhost:8766'):
            self.respond(403, {'message': 'Invalid host'})
            return False
        origin = self.headers.get('Origin')
        if origin and origin not in ORIGINS:
            self.respond(403, {'message': 'Origin not allowed'})
            return False
        return True

    def respond(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-WindScore-Token')
        if self.headers.get('Access-Control-Request-Private-Network') == 'true':
            self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        if not self.permitted():
            return False
        if not secrets.compare_digest(self.headers.get('X-WindScore-Token', ''), TOKEN):
            self.respond(403, {'message': '请重新连接本机服务'})
            return False
        return True

    def do_OPTIONS(self):
        if self.permitted():
            self.respond(200, {})

    def do_GET(self):
        if not self.permitted():
            return
        if self.path == '/health':
            self.respond(200, {**readiness(), 'token': TOKEN})
            return
        if not self.authorized():
            return
        with LOCK:
            job = JOBS.get(self.path.removeprefix('/jobs/')) if self.path.startswith('/jobs/') else None
            data = {k: v for k, v in job.items() if k != 'process'} if job else None
        self.respond(200 if data else 404, data or {'message': '任务不存在'})

    def do_POST(self):
        if not self.authorized():
            return
        url = urlparse(self.path)
        if url.path != '/jobs':
            self.respond(404, {'message': 'Unknown endpoint'})
            return
        if not readiness()['ready']:
            self.respond(503, {'message': '请先运行 npm run lab:setup 安装识别模型'})
            return
        language = parse_qs(url.query).get('language', ['zh'])[0]
        if language not in ('zh', 'yue', 'en', 'ja'):
            self.respond(400, {'message': '不支持的歌唱语言'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 44 < length <= MAX_BYTES:
                raise ValueError('音频文件为空或超过 160MB')
            audio = self.rfile.read(length)
            with wave.open(io.BytesIO(audio)) as wav:
                if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getcomptype() != 'NONE':
                    raise ValueError('需要单声道 PCM WAV')
                if wav.getframerate() != 22050 or wav.getnframes() / 22050 > 1200:
                    raise ValueError('音频须为 22050Hz 且不超过 20 分钟')
                if len(wav.readframes(wav.getnframes())) != wav.getnframes() * 2:
                    raise ValueError('音频数据不完整')
        except (ValueError, wave.Error, EOFError) as error:
            self.respond(400, {'message': str(error)})
            return
        with LOCK:
            # Keep only the latest result. Never allow concurrent model processes.
            if any(j['process'] is not None or j['status'] in ('queued', 'running') for j in JOBS.values()):
                self.respond(409, {'message': '已有识别任务，请等待完成或取消后重试'})
                return
            JOBS.clear()
            jid = secrets.token_hex(12)
            job = {'id': jid, 'status': 'queued', 'message': '正在加载人声识别模型', 'process': None}
            JOBS[jid] = job
        threading.Thread(target=transcribe_job, args=(job, audio, language), daemon=True).start()
        self.respond(202, {'id': jid})

    def do_DELETE(self):
        if not self.authorized():
            return
        with LOCK:
            job = JOBS.get(self.path.removeprefix('/jobs/'))
            if job:
                if job['process'] is not None:
                    stop_process(job['process'])
                job.update(status='cancelled', message='识别已取消')
        self.respond(200 if job else 404, {'message': '识别已取消' if job else '任务不存在'})


if __name__ == '__main__':
    print('WindScore GAME service: http://127.0.0.1:8766', flush=True)
    print(json.dumps(readiness(), ensure_ascii=False), flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8766), Handler).serve_forever()
