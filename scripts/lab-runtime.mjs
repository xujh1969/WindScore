import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, '.lab-runtime');
const py = path.join(runtime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const source = path.join(runtime, 'GAME-1.0.3');
function run(command, args) {
  const r = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, UV_HTTP_TIMEOUT: '60', UV_CONCURRENT_DOWNLOADS: '4' } });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} failed (${r.status})`);
}
function download(url, target) {
  if (existsSync(target)) return;
  // Windows revocation servers may be unreachable; keep TLS certificate validation enabled.
  run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
    ...(process.platform === 'win32' ? ['--ssl-no-revoke'] : []),
    '--fail', '--location', '--retry', '2', '--max-time', '600', '--continue-at', '-', '--output', `${target}.part`, url,
  ]);
  renameSync(`${target}.part`, target);
}
function extract(zip, destination) {
  run('python', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, destination]);
}
function findModel(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findModel(p);
      if (found) return found;
    } else if (entry.name.endsWith('.pt') || entry.name.endsWith('.ckpt')) return p;
  }
}

try {
  if (process.argv[2] === 'setup') {
    mkdirSync(runtime, { recursive: true });
    const archive = path.join(runtime, 'GAME-v1.0.3.zip');
    download('https://codeload.github.com/openvpi/GAME/zip/refs/tags/v1.0.3', archive);
    if (!existsSync(source)) extract(archive, runtime);
    if (!existsSync(py)) run('uv', ['venv', '--python', '3.11', path.join(runtime, 'venv')]);
    run('uv', ['pip', 'install', '--python', py, 'torch==2.8.0', 'torchaudio==2.8.0', '--index-url', 'https://download.pytorch.org/whl/cpu']);
    run('uv', ['pip', 'install', '--python', py, '-r', path.join(source, 'requirements.txt')]);
    const archiveModel = path.join(runtime, 'GAME-1.0-medium.zip');
    download('https://github.com/openvpi/GAME/releases/download/v1.0.0/GAME-1.0-medium.zip', archiveModel);
    const hash = createHash('sha256').update(readFileSync(archiveModel)).digest('hex');
    if (hash !== '8c5b3e531e2905b935e664e2f533921cd637243770fab5282413bdb5051ca60c') {
      throw new Error('GAME model checksum mismatch; remove the incomplete .lab-runtime/GAME-1.0-medium.zip and retry.');
    }
    const unpacked = path.join(runtime, 'weights');
    extract(archiveModel, unpacked);
    const checkpoint = findModel(unpacked);
    if (!checkpoint) throw new Error('No checkpoint found in the official model archive');
    const model = path.join(runtime, 'model');
    mkdirSync(model, { recursive: true });
    copyFileSync(checkpoint, path.join(model, 'model.pt'));
    for (const name of ['config.yaml', 'lang_map.json']) {
      copyFileSync(path.join(path.dirname(checkpoint), name), path.join(model, name));
    }
    writeFileSync(path.join(runtime, 'NOTICE.txt'), 'GAME code: MIT. Official pretrained weights: CC BY-NC-SA 4.0. https://github.com/openvpi/GAME/releases/tag/v1.0.0\n');
    run(py, [path.join(source, 'infer.py'), 'extract', '--help']);
    console.log('Installed. Start with: npm run lab:serve');
  } else {
    const child = spawn(existsSync(py) ? py : 'python', [path.join(root, 'scripts/lab_server.py')], {
      cwd: root, stdio: 'inherit', windowsHide: true,
    });
    child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
    child.on('exit', (code) => { process.exitCode = code ?? 1; });
    const stop = () => {
      if (child.exitCode !== null || !child.pid) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else child.kill();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
} catch (e) {
  console.error(`GAME setup failed: ${e.message}`);
  process.exitCode = 1;
}
