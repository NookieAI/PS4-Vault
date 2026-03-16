const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const http   = require('http');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

// ── File logger ───────────────────────────────────────────────────────────────
// Log file: %APPDATA%\PS4Vault\ps4vault.log  (rotates at 500 KB)
const LOG_DIR  = path.join(os.homedir(), 'AppData', 'Roaming', 'PS4Vault');
const LOG_FILE = path.join(LOG_DIR, 'ps4vault.log');
let   _logStream = null;
function initLog() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    try { const s = fs.statSync(LOG_FILE); if (s.size > 500*1024) fs.renameSync(LOG_FILE, LOG_FILE+'.bak'); } catch (_) {}
    _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const ts = new Date().toISOString();
    _logStream.write(`\n${'─'.repeat(60)}\nPS4 Vault v${VERSION || '?'}  ${ts}\n${'─'.repeat(60)}\n`);
  } catch (_) {}
}
const _ts = () => new Date().toISOString().slice(11, 23);
const _origLog  = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr  = console.error.bind(console);
console.log   = (...a) => { _origLog(...a);  if (_logStream) _logStream.write(`${_ts()} LOG   ${a.join(' ')}\n`); };
console.warn  = (...a) => { _origWarn(...a); if (_logStream) _logStream.write(`${_ts()} WARN  ${a.join(' ')}\n`); };
console.error = (...a) => { _origErr(...a);  if (_logStream) _logStream.write(`${_ts()} ERROR ${a.join(' ')}\n`); };

const VERSION        = '1.0.2';
initLog();
const SCAN_CONCURR   = 16;
const MAX_SCAN_DEPTH = 10;
const ICON_MAX_BYTES = 800 * 1024;
// 512 KB: captures the PKG header, full entry table, AND the SFO + icon0 for
// the vast majority of PS4/PS5 PKGs in a single pread() call.
// Eliminates the 2 extra fd.read() seeks per PKG that were the main bottleneck.
const READ_BUF_SIZE  = 2 * 1024 * 1024; // 2 MB — captures icons/SFO for virtually all PKGs in one read

const activeCancelFlags = new Map();

// ── Process-level error guards ─────────────────────────────────────────────────
process.on('uncaughtException',  e => console.error('[main] Uncaught:', e));
process.on('unhandledRejection', e => console.error('[main] Unhandled rejection:', e));

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;

// ── Window state persistence ──────────────────────────────────────────────────
const WIN_STATE_FILE = path.join(os.homedir(), 'AppData', 'Roaming', 'PS4Vault', 'window-state.json');
function loadWinState() {
  try { return JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf8')); } catch { return null; }
}
function saveWinState(win) {
  if (!win || win.isMinimized()) return;
  const s = { maximized: win.isMaximized(), ...( !win.isMaximized() ? win.getBounds() : {} ) };
  try { fs.writeFileSync(WIN_STATE_FILE, JSON.stringify(s)); } catch {}
}

function createWindow() {
  Menu.setApplicationMenu(null);
  const ws = loadWinState();

  mainWindow = new BrowserWindow({
    title:  `PS4 Vault v${VERSION}`,
    width:  ws?.width  || 1380,
    height: ws?.height || 860,
    x: ws?.x, y: ws?.y,
    show:   false,
    resizable: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      nodeIntegration:  false,
      contextIsolation: true,
      devTools:         false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!ws || ws.maximized !== false) mainWindow.maximize();
    mainWindow.show();
  });

  // Save state on close/move/resize
  ['resize','move','close'].forEach(ev => mainWindow.on(ev, () => saveWinState(mainWindow)));

  // Belt-and-suspenders: close DevTools if somehow opened
  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.closeDevTools();
  });

  // Block all DevTools / reload keyboard shortcuts
  mainWindow.webContents.on('before-input-event', (_evt, input) => {
    const ctrl = input.control || input.meta;
    const blocked =
      input.key === 'F12' ||
      (ctrl && input.shift && ['i','I','j','J','c','C'].includes(input.key)) ||
      (ctrl && ['r','R','u','U'].includes(input.key)) ||
      input.key === 'F5';
    if (blocked) _evt.preventDefault();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.on('did-finish-load', () =>
    console.log(`[main] PS4 Vault v${VERSION}`));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Renderer crash → recreate window rather than leaving a white screen
app.on('render-process-gone', (event, wc, details) => {
  console.error('[main] Renderer crash:', details.reason);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.reload();
    console.log('[main] Reloaded renderer after crash');
  }
});
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU') {
    console.warn('[main] GPU process gone:', details.reason);
  }
});

// ── Auto-updater (electron-updater + GitHub Releases) ────────────────────────
// Checks for updates on startup and notifies the renderer.
// Only active in packaged builds — skipped in dev (npm start).
function initAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[updater] Dev mode — auto-update skipped');
    return;
  }
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger            = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
    autoUpdater.autoDownload      = false; // ask user before downloading
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      console.log('[updater] Checking for updates…');
      mainWindow?.webContents.send('update-status', { type: 'checking' });
    });
    autoUpdater.on('update-available', info => {
      console.log('[updater] Update available:', info.version);
      mainWindow?.webContents.send('update-status', {
        type: 'available', version: info.version, releaseNotes: info.releaseNotes
      });
    });
    autoUpdater.on('update-not-available', () => {
      console.log('[updater] Up to date');
      mainWindow?.webContents.send('update-status', { type: 'not-available' });
    });
    autoUpdater.on('download-progress', p => {
      mainWindow?.webContents.send('update-status', {
        type: 'downloading', percent: Math.round(p.percent),
        speed: p.bytesPerSecond, transferred: p.transferred, total: p.total
      });
    });
    autoUpdater.on('update-downloaded', info => {
      console.log('[updater] Update downloaded:', info.version);
      mainWindow?.webContents.send('update-status', {
        type: 'downloaded', version: info.version
      });
    });
    autoUpdater.on('error', e => {
      console.error('[updater] Error:', e.message);
      mainWindow?.webContents.send('update-status', { type: 'error', message: e.message });
    });

    // Check after window is ready — 3s delay to not block startup
    app.whenReady().then(() => setTimeout(() => autoUpdater.checkForUpdates(), 3000));

    // IPC handlers
    ipcMain.handle('update-check',    () => autoUpdater.checkForUpdates());
    ipcMain.handle('update-download', () => autoUpdater.downloadUpdate());
    ipcMain.handle('update-install',  () => autoUpdater.quitAndInstall());
  } catch (e) {
    console.warn('[updater] electron-updater not available:', e.message);
  }
}
initAutoUpdater();
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.{2,}/g, '.').trim();
}

function formatBytes(n) {
  if (!n || n < 0) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + ' TB';
  if (n >= 1e9)  return (n / 1e9).toFixed(2)  + ' GB';
  if (n >= 1e6)  return (n / 1e6).toFixed(1)  + ' MB';
  if (n >= 1e3)  return (n / 1e3).toFixed(0)  + ' KB';
  return n + ' B';
}

async function getAllDrives() {
  if (process.platform !== 'win32') return ['/'];

  const { execSync } = require('child_process');
  const found = new Set();

  // ── Strategy 1: PowerShell Get-PSDrive ────────────────────────────────────
  // Most reliable — returns ALL filesystem drives including mapped network shares.
  // Works on Windows 10/11 where wmic is deprecated.
  try {
    const ps = execSync(
      'powershell -NoProfile -NonInteractive -Command "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root"',
      { timeout: 8000, windowsHide: true }
    ).toString();
    ps.split(/\r?\n/).forEach(l => {
      const m = l.trim().match(/^([A-Za-z]):[\\\/]?$/);
      if (m) found.add(m[1].toUpperCase() + ':');
    });
  } catch { /* fall through to next strategy */ }

  // ── Strategy 2: PowerShell Get-WmiObject (wmic deprecated on Win11) ─────────
  if (found.size === 0) {
    try {
      const out = execSync(
        'powershell -NoProfile -NonInteractive -Command "Get-WmiObject Win32_LogicalDisk | Select-Object -ExpandProperty DeviceID"',
        { timeout: 6000, windowsHide: true }
      ).toString();
      out.split(/\r?\n/).forEach(l => {
        const m = l.trim().match(/^([A-Za-z]):$/);
        if (m) found.add(m[1].toUpperCase() + ':');
      });
    } catch {}
  }

  // ── Strategy 3: net use — catches mapped network drives WMIC might miss ───
  try {
    const net = execSync('net use', { timeout: 5000, windowsHide: true }).toString();
    net.split(/\r?\n/).forEach(l => {
      const m = l.match(/\b([A-Za-z]):\s/);
      if (m) found.add(m[1].toUpperCase() + ':');
    });
  } catch {}

  // ── Strategy 4: brute-force probe every letter A-Z ────────────────────────
  // Catches any drive that slipped past the above (USB inserted after login, etc.)
  // Uses a fast fs.access check rather than spawning a process per letter.
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  await Promise.all(
    letters.split('').map(async letter => {
      const root = letter + ':\\';
      try {
        await fs.promises.access(root, fs.constants.R_OK);
        found.add(letter + ':');
      } catch { /* not accessible */ }
    })
  );

  // Return sorted; always put C: first if present
  const drives = Array.from(found).sort((a, b) => {
    if (a === 'C:') return -1;
    if (b === 'C:') return  1;
    return a.localeCompare(b);
  });

  return drives.length > 0 ? drives : ['C:'];
}

// ── SFO parser ────────────────────────────────────────────────────────────────
const SFO_MAGIC = 0x46535000; // \x00PSF as LE uint32

function parseSfo(buf) {
  if (buf.length < 20) return {};
  const magic = buf.readUInt32LE(0);
  if (magic !== SFO_MAGIC) return {};

  const keyTableOff  = buf.readUInt32LE(8);
  const dataTableOff = buf.readUInt32LE(12);
  const numEntries   = buf.readUInt32LE(16);
  const result = {};

  for (let i = 0; i < numEntries; i++) {
    const eo = 20 + i * 16;
    if (eo + 16 > buf.length) break;
    const keyOff  = buf.readUInt16LE(eo);
    const fmt     = buf.readUInt16LE(eo + 2);
    const len     = buf.readUInt32LE(eo + 4);
    const dataOff = buf.readUInt32LE(eo + 12);

    const ks  = keyTableOff + keyOff;
    const ke  = buf.indexOf(0, ks);
    const key = buf.slice(ks, ke >= 0 ? ke : ks + 64).toString('ascii');
    const vs  = dataTableOff + dataOff;

    if (fmt === 0x0404) {
      // Integer (PSFEntryFmt::Integer = 0x0404, stored BE → reads 0x0404 via LE)
      result[key] = vs + 4 <= buf.length ? buf.readUInt32LE(vs) : 0;
    } else {
      // UTF-8 string (PSFEntryFmt::Text = 0x0204 stored BE → reads 0x0402 via LE)
      // or Binary (0x0004 stored BE → 0x0400 LE) — both treated as string
      const ve = buf.indexOf(0, vs);
      result[key] = buf.slice(vs, ve >= 0 ? ve : vs + len).toString('utf8').trim();
    }
  }
  return result;
}

// Convert SYSTEM_VER uint32 → "9.03" style string
function fwFromInt(n) {
  if (!n) return '';
  const major = (n >> 24) & 0xFF;
  const minor = ((n >> 16) & 0xFF).toString().padStart(2, '0');
  return `${major}.${minor}`;
}

// ── Title extraction from filename ────────────────────────────────────────────
// Handles scene-release naming conventions:
//   "Fallout.4_CUSA02962_v1.00_[5.05]_OPOISSO893.pkg"  → "Fallout 4"
//   "ELDEN.RING.NIGHTREIGN_CUSA50617_v1.00_..."         → "Elden Ring Nightreign"
//   "The.Last.of.Us_CUSA00552_v1.00_..."                → "The Last of Us"
//   "EP3678-CUSA11095_00-PP100..."                      → null (raw content-ID prefix)
function titleFromFilename(filePath) {
  const base = path.basename(filePath, '.pkg');
  // Stop before the first CUSA/PUSA/PLAS/BLES block
  const m = base.match(/^(.+?)[-_](?:[A-Z]{2}\d{4}-)?(?:CUSA|PUSA|PLAS|BLES|NPEB|NPUB|BCUS|BCES)\d+/i);
  if (!m) return null;
  const raw = m[1].trim();
  // Reject: pure region prefix like "EP3678", "UP1234", single word that IS a CUSA-like code
  if (/^[A-Z]{2}\d{4}$/i.test(raw)) return null;
  if (/^[A-Z]{4}\d{5}$/i.test(raw)) return null;
  // Convert dots/underscores to spaces, trim
  const pretty = raw.replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // Require at least 2 characters and at least one letter
  if (pretty.length < 2 || !/[a-zA-Z]/.test(pretty)) return null;
  return pretty;
}

// ── SFO magic-byte scanner ────────────────────────────────────────────────────
// Direct scan for \x00PSF in a buffer — completely bypasses entry-table parsing.
// PS4 SFOs always start with 0x00 0x50 0x53 0x46 followed by valid header.
const SFO_SIG = Buffer.from([0x00, 0x50, 0x53, 0x46]);
function scanBufferForSfo(buf) {
  let off = 0;
  while (off < buf.length - 20) {
    const idx = buf.indexOf(SFO_SIG, off);
    if (idx === -1) break;
    // Quick-validate: numEntries at +16 should be 1..100
    const num = buf.readUInt32LE(idx + 16);
    if (num > 0 && num <= 100) {
      const slice = buf.slice(idx, Math.min(idx + 65536, buf.length));
      const sfo   = parseSfo(slice);
      if (sfo.CATEGORY || sfo.TITLE || sfo.APP_VER || sfo.TITLE_ID) return sfo;
    }
    off = idx + 1;
  }
  return null;
}

// ── PNG/JPEG icon scanner ─────────────────────────────────────────────────────
function scanBufferForIcon(buf) {
  const PNG_SIG  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const JPEG_SIG = Buffer.from([0xFF, 0xD8, 0xFF]);

  // Find best PNG: scan all matches and pick the largest within a reasonable window
  // (avoids picking tiny embedded PNG thumbnails over the actual game icon)
  let bestPng = null, bestPngSize = 0;
  let off = 0;
  while (off < buf.length - 8) {
    const idx = buf.indexOf(PNG_SIG, off);
    if (idx === -1) break;
    // Try to find IEND chunk to determine actual size
    const IEND = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
    const iendIdx = buf.indexOf(IEND, idx + 8);
    const pngEnd = (iendIdx !== -1 && iendIdx - idx < ICON_MAX_BYTES)
      ? iendIdx + 8
      : Math.min(idx + ICON_MAX_BYTES, buf.length);
    const size = pngEnd - idx;
    if (size > bestPngSize) { bestPngSize = size; bestPng = buf.slice(idx, pngEnd); }
    off = idx + 1;
    if (off > buf.length - 100000) break; // don't over-scan
  }
  if (bestPng) return `data:image/png;base64,${bestPng.toString('base64')}`;

  // JPEG fallback — find first valid JPEG
  const jpgIdx = buf.indexOf(JPEG_SIG);
  if (jpgIdx !== -1) {
    // Find JPEG end marker FFD9
    let jpgEnd = buf.length;
    for (let i = jpgIdx + 2; i < buf.length - 1; i++) {
      if (buf[i] === 0xFF && buf[i+1] === 0xD9) { jpgEnd = i + 2; break; }
    }
    const slice = buf.slice(jpgIdx, Math.min(jpgEnd, jpgIdx + ICON_MAX_BYTES));
    return `data:image/jpeg;base64,${slice.toString('base64')}`;
  }
  return null;
}

// ── PS4 PKG header layout (psdevwiki.com/ps4/Package_Files) ──────────────────
// 0x00  uint32BE  magic = 0x7F434E54
// 0x04  uint16BE  pkg_revision
// 0x06  uint16BE  pkg_type
// 0x08  uint32BE  pkg_0x8
// 0x0C  uint32BE  pkg_file_count       ← total entries in item-entry table
// 0x10  uint32BE  pkg_entry_count      ← main entry count (sometimes differs)
// 0x14  uint16BE  pkg_sc_entry_count
// 0x16  uint16BE  pkg_entry_count_2
// 0x18  uint32BE  pkg_table_offset     ← WHERE THE ITEM ENTRY TABLE IS
// 0x1C  uint32BE  pkg_entry_data_size  ← size of entry data, NOT an offset
// 0x20  uint64BE  pkg_body_offset      ← start of body; entry data_offsets are relative to this
// 0x28  uint64BE  pkg_body_size
// 0x40  char[36]  content_id
//
// Item entry table (each entry 32 bytes, at pkg_table_offset):
//   +0x00 uint32  id          (0x0010 = param.sfo, 0x0012 = icon0.png, 0x0011 = icon alt)
//   +0x04 uint32  name_reloff
//   +0x08 uint32  flags1
//   +0x0C uint32  flags2
//   +0x10 uint32  data_offset  ← relative to pkg_body_offset
//   +0x14 uint32  data_size
//   +0x18 uint64  padding
const PKG_MAGIC = 0x7F434E54;

async function parsePkgFile(filePath) {
  const stat     = await fs.promises.stat(filePath);
  const fileSize = stat.size;

  // Read enough for header + entry table (entry table is always in the first ~32 KB)
  const hdrSize = Math.min(READ_BUF_SIZE, fileSize);
  const hdrBuf  = Buffer.alloc(hdrSize);
  const fd      = await fs.promises.open(filePath, 'r');
  try {
    const { bytesRead } = await fd.read(hdrBuf, 0, hdrSize, 0);
    if (bytesRead < 0x100) throw new Error('file too small');

    if (hdrBuf.readUInt32BE(0x00) !== PKG_MAGIC) throw new Error('bad magic');

    const pkgType = hdrBuf.readUInt16BE(0x06);

    // ── Content ID at 0x40 ────────────────────────────────────────────────────
    const cidBuf    = hdrBuf.slice(0x40, 0x64);
    const cidNull   = cidBuf.indexOf(0);
    const contentId = cidBuf.slice(0, cidNull >= 0 ? cidNull : 36).toString('ascii').trim();
    let titleId = '', region = '';
    const cmatch = contentId.match(/^([A-Z]{2})\d{4}-([A-Z]{4}\d{5})/);
    if (cmatch) { region = cmatch[1]; titleId = cmatch[2]; }

    // ── Entry table: offsets at 0x18 (table location), 0x10 (entry count) ────
    // IMPORTANT: pkg_table_entry_count is at 0x10, NOT pkg_file_count at 0x0C.
    // All reference implementations (ShadPKG, PkgToolBox, PS4-PKG-Tool) use 0x10.
    // entry.offset values are ABSOLUTE file offsets — use them directly.
    const tableOff   = hdrBuf.readUInt32BE(0x18); // pkg_table_entry_offset
    const entryCount = hdrBuf.readUInt32BE(0x10);  // pkg_table_entry_count (NOT 0x0C!)

    // ── Walk entry table to find SFO and icon ─────────────────────────────────
    // Correct entry IDs from ShadPKG pkg_type.cpp / PkgToolBox pkg_entry.py:
    //   0x1000 = param.sfo           (was WRONGLY 0x0010 = entry_keys)
    //   0x1200 = icon0.png           (was WRONGLY 0x0012 = image_key)
    //   0x1201–0x121F = icon0 variants (was WRONGLY 0x0011)
    //   0x1006 = pic1.png (background banner — bonus)
    let sfoOff = 0, sfoSz = 0, iconOff = 0, iconSz = 0;

    if (tableOff > 0 && tableOff < fileSize && entryCount > 0 && entryCount < 4096) {
      const tableBytes = entryCount * 32;
      let tblBuf, tblBase;

      if (tableOff + tableBytes <= bytesRead) {
        tblBuf  = hdrBuf; tblBase = tableOff;        // table fits in initial read
      } else {
        const readSz = Math.min(tableBytes, fileSize - tableOff);
        tblBuf  = Buffer.alloc(readSz);
        await fd.read(tblBuf, 0, readSz, tableOff);  // seek to table explicitly
        tblBase = 0;
      }

      for (let i = 0; i < entryCount; i++) {
        const eo     = tblBase + i * 32;
        if (eo + 32 > tblBuf.length) break;
        const id      = tblBuf.readUInt32BE(eo +  0);
        const dataOff = tblBuf.readUInt32BE(eo + 16); // absolute file offset
        const dataSz  = tblBuf.readUInt32BE(eo + 20);
        if (!dataSz || dataOff >= fileSize) continue;

        // param.sfo = 0x1000, icon0.png = 0x1200, icon0 variants = 0x1201-0x121F
        // pic1.png (background banner) = 0x1006
        if (id === 0x1000 && dataSz > 16 && dataSz < 1024 * 1024 && !sfoOff)  { sfoOff = dataOff; sfoSz = dataSz; }
        if ((id === 0x1200 || (id >= 0x1201 && id <= 0x121F)) && dataSz > 256 && !iconOff) { iconOff = dataOff; iconSz = dataSz; }
      }
    }

    // ── Read SFO ──────────────────────────────────────────────────────────────
    // CONFIRMED by ShadPKG pkg.cpp, PkgToolBox package_ps4.py, PS4-PKG-Tool:
    // entry.offset IS an absolute file offset. All three implementations do:
    //   file.Seek(entry.offset) → read entry.size bytes
    // No body_offset addition. Try absolute FIRST; body-relative only as fallback
    // for the small number of re-packed PKGs that use a different layout.
    const bodyOff64 = Number(hdrBuf.readBigUInt64BE(0x20)); // pkg_body_offset (kept for fallback)

    let sfoData = {};
    if (sfoOff > 0 && sfoSz > 0) {
      const sfoTryOffsets = [];
      if (sfoOff < fileSize) sfoTryOffsets.push(sfoOff);
      if (bodyOff64 > 0 && bodyOff64 + sfoOff < fileSize) sfoTryOffsets.push(bodyOff64 + sfoOff);

      for (const tryOff of sfoTryOffsets) {
        if (tryOff + sfoSz > fileSize) continue;
        let sfoBuf;
        if (tryOff + sfoSz <= bytesRead) {
          // ✓ Fast path: SFO is already in the initial read buffer — zero extra I/O
          sfoBuf = hdrBuf.slice(tryOff, tryOff + sfoSz);
        } else {
          sfoBuf = Buffer.alloc(sfoSz);
          const { bytesRead: sfoRead } = await fd.read(sfoBuf, 0, sfoSz, tryOff);
          if (sfoRead < 20) continue;
        }
        const parsed = parseSfo(sfoBuf);
        if (parsed.TITLE || parsed.CATEGORY || parsed.APP_VER || parsed.TITLE_ID) {
          sfoData = parsed; break;
        }
      }
    }

    // ── Fallback: scan for \x00PSF magic ONLY if entry table found no SFO ──────
    // This is the slow path. With correct entry IDs (0x1000) it should rarely fire.
    // Only scan if sfoOff === 0 meaning the entry table had no param.sfo entry at all.
    if (!sfoData.TITLE && !sfoData.CATEGORY && !sfoData.APP_VER && sfoOff === 0) {
      const SCAN_WIN = 512 * 1024; // 512 KB — enough for any legitimate PS4 SFO position

      // Window 1: start of file
      const win1Size = Math.min(SCAN_WIN, fileSize);
      const win1Buf  = win1Size <= bytesRead ? hdrBuf.slice(0, bytesRead) : Buffer.alloc(win1Size);
      if (win1Size > bytesRead) await fd.read(win1Buf, 0, win1Size, 0);
      const found1 = scanBufferForSfo(win1Buf);
      if (found1 && (found1.TITLE || found1.CATEGORY)) { sfoData = found1; }

      // Window 2: around pkg_body_offset (only if body is beyond what we already read)
      if (!sfoData.TITLE && !sfoData.CATEGORY && bodyOff64 > bytesRead && bodyOff64 < fileSize) {
        const win2Size = Math.min(SCAN_WIN, fileSize - bodyOff64);
        if (win2Size > 64) {
          const win2Buf = Buffer.alloc(win2Size);
          await fd.read(win2Buf, 0, win2Size, bodyOff64);
          const found2 = scanBufferForSfo(win2Buf);
          if (found2 && (found2.TITLE || found2.CATEGORY)) sfoData = found2;
        }
      }
    }

    let iconDataUrl = null;
    const iconReadSz = Math.min(iconSz, ICON_MAX_BYTES);
    if (iconOff > 0 && iconReadSz > 256) {
      const offsets = [];
      if (iconOff < fileSize) offsets.push(iconOff);
      if (bodyOff64 > 0 && bodyOff64 + iconOff < fileSize) offsets.push(bodyOff64 + iconOff);
      for (const tryOff of offsets) {
        if (tryOff + 8 > fileSize) continue;
        let iconBuf, iconBytes;
        if (tryOff + iconReadSz <= bytesRead) {
          // ✓ Fast path: icon already in buffer — zero extra I/O
          iconBuf   = hdrBuf.slice(tryOff, tryOff + iconReadSz);
          iconBytes = iconBuf.length;
        } else {
          const readSize = Math.min(iconReadSz, fileSize - tryOff);
          iconBuf = Buffer.alloc(readSize);
          const r = await fd.read(iconBuf, 0, readSize, tryOff);
          iconBytes = r.bytesRead;
        }
        if (iconBytes < 8) continue;
        const isPng  = iconBuf[0] === 0x89 && iconBuf[1] === 0x50 && iconBuf[2] === 0x4E && iconBuf[3] === 0x47;
        const isJpeg = iconBuf[0] === 0xFF && iconBuf[1] === 0xD8;
        if (isPng)  { iconDataUrl = `data:image/png;base64,${iconBuf.slice(0, iconBytes).toString('base64')}`; break; }
        if (isJpeg) { iconDataUrl = `data:image/jpeg;base64,${iconBuf.slice(0, iconBytes).toString('base64')}`; break; }
      }
    }
    // Fallback: scan the buffer for any PNG/JPEG if we still have no icon.
    // Catches PKGs where the entry table offset was wrong, encrypted, or
    // the icon sat outside our expected offset range.
    if (!iconDataUrl) {
      iconDataUrl = scanBufferForIcon(hdrBuf.slice(0, bytesRead));
    }

    // ── Extended icon search: read around bodyOff64 if still missing ────────
    // Handles PKGs where icon is stored deep in the body beyond our READ_BUF_SIZE
    if (!iconDataUrl && bodyOff64 > bytesRead && bodyOff64 < fileSize) {
      const winSz  = Math.min(1024 * 1024, fileSize - bodyOff64); // 1 MB window
      const winBuf = Buffer.alloc(winSz);
      try {
        const { bytesRead: bwr } = await fd.read(winBuf, 0, winSz, bodyOff64);
        if (bwr > 8) iconDataUrl = scanBufferForIcon(winBuf.slice(0, bwr));
      } catch (_) {}
    }

    // ── Resolve final fields ──────────────────────────────────────────────────
    const sfoTitle = sfoData.TITLE || sfoData.TITLE_00 || sfoData.TITLE_01 ||
                     sfoData.TITLE_02 || sfoData.TITLE_03 || '';
    const category = sfoData.CATEGORY ||
      // Fallback: infer category from filename if SFO has none
      (/theme/i.test(path.basename(filePath)) ? 'THEME' : '');
    const appVer   = sfoData.APP_VER  || '';
    const sysVer   = sfoData.SYSTEM_VER != null ? fwFromInt(sfoData.SYSTEM_VER) : '';
    if (!titleId && sfoData.TITLE_ID) titleId = sfoData.TITLE_ID;

    // Title priority: SFO title > filename-extracted name > CUSA ID > raw filename
    const fnTitle = titleFromFilename(filePath);
    const title   = sfoTitle || fnTitle || titleId || path.basename(filePath, '.pkg');

    return {
      filePath,
      fileName:    path.basename(filePath),
      dirPath:     path.dirname(filePath),
      fileSize,
      contentId,
      titleId,
      title,
      sfoTitle,     // raw SFO game name (empty string if SFO not found)
      fnTitle,      // filename-guessed name (null if not guessable)
      category,
      appVer,
      sysVer,
      region,
      pkgType,
      iconDataUrl,
      isDuplicate: false,
      isFtp:       false,
    };
  } finally {
    await fd.close();
  }
}

// ── Scanner ───────────────────────────────────────────────────────────────────
async function findPkgFiles(dir, signal, maxDepth = MAX_SCAN_DEPTH) {
  const results = [];

  // Sequential depth-first walk — safer for network shares (SMB/UNC/mapped drives).
  // Unlimited Promise.all recursion floods the share with hundreds of simultaneous
  // open-dir requests, which SMB servers rate-limit or outright refuse.
  // Sequential walk is only ~10% slower locally but far more reliable over the network.
  async function walk(d, depth) {
    if (signal?.aborted || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch (e) {
      // Log network errors so they're visible, but keep scanning the rest
      if (e.code && !['EACCES','EPERM','ENOENT'].includes(e.code)) {
        console.warn('[scan] readdir failed:', d, e.code || e.message);
      }
      return;
    }
    for (const e of entries) {
      if (signal?.aborted) return;
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) {
          await walk(full, depth + 1);
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.pkg')) {
          results.push(full);
        } else if (e.isFile() && (e.name.toLowerCase().endsWith('.pkg.part') || (e.name.toLowerCase().endsWith('.part') && e.name.toLowerCase().includes('.pkg')))) {
          results.push(full + '|partial');
        }
      } catch { /* skip individual entry errors */ }
    }
  }

  await walk(dir, 0);
  return results;
}

async function scanPkgs(sourceDir, sender, scanDepth) {
  const controller = new AbortController();
  activeCancelFlags.set(sender.id, () => controller.abort());

  sender.send('scan-progress', { type: 'scan-start' });

  try {
    // ── Pre-check: verify the source dir is accessible ────────────────────────
    // Mapped network drives can appear in the drive list but be "disconnected" —
    // fs.access returns immediately instead of hanging for 30 s.
    try {
      await fs.promises.access(sourceDir, fs.constants.R_OK);
    } catch (e) {
      sender.send('scan-progress', {
        type: 'scan-error',
        message: `Cannot access "${sourceDir}": ${e.code || e.message}. Check that the drive / network share is connected.`,
      });
      return [];
    }

    // ── Detect if this is a network path ─────────────────────────────────────
    let isNetworkPath = sourceDir.startsWith('\\\\') || sourceDir.startsWith('//');
    if (!isNetworkPath && process.platform === 'win32' && /^[A-Za-z]:/.test(sourceDir)) {
      try {
        const { execSync } = require('child_process');
        const letter = sourceDir.slice(0, 2).toUpperCase(); // e.g. "C:"
        // Use Where-Object instead of -Filter to avoid WMI filter quote-escaping issues.
        // DriveType 4 = Network drive.
        const out = execSync(
          `powershell -NoProfile -NonInteractive -Command "` +
          `(Get-WmiObject Win32_LogicalDisk | Where-Object { $_.DeviceID -eq '${letter}' } | ` +
          `Select-Object -ExpandProperty DriveType)"`,
          { timeout: 3000, windowsHide: true }
        ).toString().trim();
        if (out === '4') isNetworkPath = true;
      } catch { /* ignore, assume local */ }
    }

    sender.send('scan-progress', { type: 'scan-discovering' });
    const rawFiles  = await findPkgFiles(sourceDir, controller.signal, scanDepth || MAX_SCAN_DEPTH);
    // Separate partial files from complete ones
    const pkgFiles  = rawFiles.filter(f => !f.endsWith('|partial'));
    const partFiles = rawFiles.filter(f => f.endsWith('|partial')).map(f => f.replace('|partial',''));
    sender.send('scan-progress', { type: 'scan-found', total: pkgFiles.length });

    if (pkgFiles.length === 0) {
      sender.send('scan-progress', { type: 'scan-done', total: 0 });
      return [];
    }

    // ── Parse PKGs in parallel ────────────────────────────────────────────────
    // Network shares: cap at 4 workers — too many parallel reads over SMB
    // causes timeouts and connection stalls on most NAS/server configs.
    // Local drives: full SCAN_CONCURR (16) for fast NVMe performance.
    const concurr = isNetworkPath ? 4 : SCAN_CONCURR;
    const items = [];
    let done = 0, idx = 0;

    async function worker() {
      while (idx < pkgFiles.length) {
        if (controller.signal.aborted) break;
        const i  = idx++;
        const fp = pkgFiles[i];
        sender.send('scan-progress', { type: 'scan-parsing', file: path.basename(fp), done, total: pkgFiles.length });
        let item = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            item = await parsePkgFile(fp);
            break;
          } catch (e) {
            if (attempt === 0) {
              await new Promise(r => setTimeout(r, 500)); // brief pause then retry
            } else {
              console.warn('[scan] skip', path.basename(fp), e.message);
            }
          }
        }
        if (item) {
          items.push(item);
          sender.send('scan-progress', { type: 'scan-result', item });
        }
        done++;
        sender.send('scan-progress', { type: 'scan-parsing', file: path.basename(fp), done, total: pkgFiles.length });
      }
    }

    await Promise.all(Array.from({ length: concurr }, worker));

    // Mark duplicates by contentId
    const cidMap = new Map();
    for (const item of items) {
      if (!item.contentId) continue;
      if (!cidMap.has(item.contentId)) cidMap.set(item.contentId, []);
      cidMap.get(item.contentId).push(item);
    }
    for (const [, group] of cidMap) {
      if (group.length > 1) group.forEach(i => { i.isDuplicate = true; });
    }

    // Add partial PKG entries as warnings
    for (const partPath of (partFiles || [])) {
      const item = {
        filePath: partPath, fileName: path.basename(partPath),
        dirPath: path.dirname(partPath), fileSize: 0,
        title: path.basename(partPath, '.part').replace('.pkg','') + ' (incomplete)',
        sfoTitle: '', fnTitle: '', titleId: '', category: '', appVer: '', sysVer: '',
        region: '', contentId: '', pkgType: 0, iconDataUrl: null,
        isDuplicate: false, isFtp: false, isPartial: true,
      };
      items.push(item);
      sender.send('scan-progress', { type: 'scan-result', item });
    }
    sender.send('scan-progress', { type: 'scan-done', total: items.length });
    return items;

  } catch (e) {
    console.error('[scan] error:', e);
    sender.send('scan-progress', { type: 'scan-error', message: e.message });
    return [];
  } finally {
    activeCancelFlags.delete(sender.id);
  }
}

// ── FTP helpers ───────────────────────────────────────────────────────────────
function getFtp() {
  try { return require('basic-ftp'); }
  catch { throw new Error('basic-ftp not installed — run: npm install'); }
}

async function makeFtpClient(cfg) {
  const ftp    = getFtp();
  const client = new ftp.Client(20000); // 20 s timeout
  client.ftp.verbose = false;
  await client.access({
    host:     cfg.host,
    port:     parseInt(cfg.port) || 21,
    user:     cfg.user || 'anonymous',
    password: cfg.pass || '',
    secure:   false,
  });
  // Passive mode is default and works through NAT/routers.
  // Active mode sends PORT commands — some PS4 CFW FTP servers require it.
  if (cfg.activeMode) {
    client.ftp.passive = false;
  }
  return client;
}

// Walk FTP directory recursively, collecting .pkg entries.
// Uses explicit cd() then list() to keep CWD state consistent on the shared client.
async function ftpFindPkgs(client, remotePath, signal, depth = 0) {
  if (signal?.aborted || depth > MAX_SCAN_DEPTH) return [];
  const results = [];
  let list;
  try {
    await client.cd(remotePath);
    list = await client.list();
  } catch (e) {
    console.warn('[ftp-walk] cannot list', remotePath, e.message);
    return [];
  }
  for (const item of list) {
    if (signal?.aborted) break;
    // Build canonical absolute path — avoids double-slash for root
    const base = remotePath === '/' ? '' : remotePath.replace(/\/$/, '');
    const full = base + '/' + item.name;
    if (item.isDirectory) {
      results.push(...await ftpFindPkgs(client, full, signal, depth + 1));
    } else if (item.name.toLowerCase().endsWith('.pkg') && item.size > 1024 * 1024) {
      results.push({ remotePath: full, size: item.size });
    } else if (item.name.toLowerCase().includes('.pkg.part') || item.name.toLowerCase().endsWith('.part')) {
      results.push({ remotePath: full, size: item.size, isPartial: true });
    }
  }
  return results;
}

// ── FTP header download ───────────────────────────────────────────────────────
// Download the first N bytes of a remote PKG.
// 2 MB captures the PKG header + full entry table + SFO + icon0 for
// the vast majority of PS4/PS5 PKGs. Using REST (byte-range) when the server
// supports it; falling back to a truncated stream otherwise.
const FTP_HDR_SIZE = 2 * 1024 * 1024; // 2 MB — matches READ_BUF_SIZE, captures most icons in one FTP read

// Read a byte range from an FTP file by seeking with REST command.
// Falls back to null if the server doesn't support REST (RETR from offset 0).
async function ftpReadRange(client, remotePath, offset, length) {
  const chunks = [];
  let total = 0;
  try {
    const { Writable } = require('stream');
    const w = new Writable({
      write(chunk, _, cb) {
        if (total < length) {
          chunks.push(chunk.slice(0, Math.min(chunk.length, length - total)));
        }
        total += chunk.length;
        cb();
      }
    });
    // basic-ftp supports downloadTo with offset via client.send('REST', offset) + RETR
    await client.downloadTo(w, remotePath, offset);
    return chunks.length ? Buffer.concat(chunks) : null;
  } catch (_) {
    return null;
  }
}

async function ftpReadPkgHeader(client, remotePath) {
  // Do NOT call this.destroy() inside the Writable — it aborts the FTP data channel
  // and corrupts the shared pool client for all subsequent downloads.
  // Instead, buffer up to FTP_HDR_SIZE bytes and let the transfer complete naturally.
  const chunks = [];
  let total = 0;
  const { Writable } = require('stream');
  const writable = new Writable({
    write(chunk, _enc, cb) {
      if (total < FTP_HDR_SIZE) {
        const remaining = FTP_HDR_SIZE - total;
        chunks.push(chunk.slice(0, Math.min(chunk.length, remaining)));
      }
      total += chunk.length;
      cb();
    }
  });
  try {
    await client.downloadTo(writable, remotePath);
  } catch (e) {
    const msg = (e.message || '').toLowerCase();
    const expected = msg.includes('premature') || msg.includes('reset') ||
                     msg.includes('aborted') || msg.includes('destroyed');
    if (!chunks.length && !expected) throw e;
  }
  if (!chunks.length) throw new Error('FTP: no data received for ' + remotePath);
  return Buffer.concat(chunks);
}

// ── FTP connection pool ────────────────────────────────────────────────────────
// Maintains a small pool of persistent FTP clients so we can process multiple
// PKGs in parallel without paying the TCP+login overhead for every file.
// Eliminates the #1 cause of slow FTP scans: new connection per PKG.
let FTP_POOL_SIZE = 3 // settable via set-setting; // PS4/PS5 FTP servers handle 3-4 concurrent sessions well

async function withFtpPool(cfg, pkgList, signal, onItem) {
  // Pre-connect all pool clients in parallel
  const pool = await Promise.all(
    Array.from({ length: Math.min(FTP_POOL_SIZE, pkgList.length) }, () => makeFtpClient(cfg))
  );
  const queue  = [...pkgList];
  let idx = 0;

  async function worker(client) {
    while (queue.length > 0) {
      if (signal?.aborted) break;
      const item = queue.shift();
      if (!item) break;
      idx++;
      try { await onItem(client, item, idx); }
      catch (e) { console.warn('[ftp-pool] worker error, reconnecting:', e.message); }
      // If the client dropped, reconnect it once before continuing
      if (!client.closed) continue;
      try { client = await makeFtpClient(cfg); } catch (e2) { break; }
    }
  }

  try {
    await Promise.all(pool.map(client => worker(client)));
  } finally {
    pool.forEach(cl => { try { cl.close(); } catch (_) {} });
  }
}

// FTP scanner — parallel pool-based, mirrors scanPkgs
async function scanPkgsFtp(cfg, sender) {
  const controller = new AbortController();
  activeCancelFlags.set(sender.id, () => controller.abort());
  sender.send('scan-progress', { type: 'scan-start' });
  let _ftpRetry = false;

  let dirClient;
  try {
    dirClient = await makeFtpClient(cfg);
    sender.send('scan-progress', { type: 'scan-discovering' });
    const pkgList = await ftpFindPkgs(dirClient, cfg.path || '/', controller.signal);
    try { dirClient.close(); } catch (_) {}

    sender.send('scan-progress', { type: 'scan-found', total: pkgList.length });

    if (!pkgList.length) {
      sender.send('scan-progress', { type: 'scan-done', total: 0 });
      return [];
    }

    const items = [];
    let done = 0;
    const totalPkgs = pkgList.length;

    await withFtpPool(cfg, pkgList, controller.signal, async (client, { remotePath, size }, _idx) => {
      const fname = remotePath.split('/').pop();
      const myIdx = done; // capture before any await
      sender.send('scan-progress', { type: 'scan-parsing', file: fname, done: myIdx, total: totalPkgs });
      try {
        let headerBuf;
        try { headerBuf = await ftpReadPkgHeader(client, remotePath); }
        catch (e) { throw e; }

        if (headerBuf.readUInt32BE(0) !== PKG_MAGIC) throw new Error('not a PKG');

        const pkgType    = headerBuf.readUInt16BE(0x06);
        const cidBuf     = headerBuf.slice(0x40, 0x64);
        const cidNull    = cidBuf.indexOf(0);
        const contentId  = cidBuf.slice(0, cidNull >= 0 ? cidNull : 36).toString('ascii').trim();
        let titleId = '', region = '';
        const cm = contentId.match(/^([A-Z]{2})\d{4}-([A-Z]{4}\d{5})/);
        if (cm) { region = cm[1]; titleId = cm[2]; }

        const tableOff   = headerBuf.readUInt32BE(0x18); // pkg_table_entry_offset
        const entryCount = headerBuf.readUInt32BE(0x10); // pkg_table_entry_count (NOT 0x0C)

        let sfoData = {}, iconDataUrl = null;
        let sfoOff = 0, sfoSz = 0, iconOff = 0, iconSz = 0;
        const ftpBodyOff = (headerBuf.length >= 0x28)
          ? Number(headerBuf.readBigUInt64BE(0x20))
          : 0;

        if (tableOff > 0 && tableOff < headerBuf.length && entryCount > 0 && entryCount < 4096) {
          const tableBytes = entryCount * 32;
          const entryBuf   = headerBuf.slice(tableOff, Math.min(tableOff + tableBytes, headerBuf.length));
          for (let i = 0; i * 32 + 32 <= entryBuf.length; i++) {
            const eo      = i * 32;
            const id      = entryBuf.readUInt32BE(eo);
            const dataOff = entryBuf.readUInt32BE(eo + 16);
            const dataSz  = entryBuf.readUInt32BE(eo + 20);
            if (!dataSz) continue;
            // Correct entry IDs (from ShadPKG/PkgToolBox):
            // 0x1000 = param.sfo, 0x1200 = icon0.png, 0x1201-0x121F = icon variants
            if (id === 0x1000 && dataSz > 16 && dataSz < 1024*1024 && !sfoOff) { sfoOff = dataOff; sfoSz = dataSz; }
            if ((id === 0x1200 || (id >= 0x1201 && id <= 0x121F)) && dataSz > 256 && !iconOff) { iconOff = dataOff; iconSz = dataSz; }
          }
        }

        // SFO: try absolute offset first (confirmed correct by all reference implementations)
        if (sfoOff > 0 && sfoSz > 0) {
          const sfoTryOffsets = [];
          if (sfoOff + sfoSz <= headerBuf.length) {
            sfoTryOffsets.push(sfoOff);                              // 1st: absolute (correct)
          }
          if (ftpBodyOff > 0 && ftpBodyOff + sfoOff + sfoSz <= headerBuf.length) {
            sfoTryOffsets.push(ftpBodyOff + sfoOff);                 // 2nd: body-relative fallback
          }
          for (const tryOff of sfoTryOffsets) {
            const parsed = parseSfo(headerBuf.slice(tryOff, tryOff + sfoSz));
            if (parsed.TITLE || parsed.CATEGORY || parsed.APP_VER || parsed.TITLE_ID) {
              sfoData = parsed; break;
            }
          }
        }
        if (!sfoData.TITLE && !sfoData.CATEGORY && !sfoData.APP_VER) {
          const found = scanBufferForSfo(headerBuf);
          if (found) sfoData = found;
        }

        // Icon: try absolute offset first, body-relative fallback
        if (iconOff > 0) {
          const iconReadSz = Math.min(iconSz, ICON_MAX_BYTES);
          const tryOffsets = [];
          if (iconOff < headerBuf.length) tryOffsets.push(iconOff);                      // 1st: absolute
          if (ftpBodyOff > 0 && ftpBodyOff + iconOff < headerBuf.length) tryOffsets.push(ftpBodyOff + iconOff); // 2nd: body-rel
          for (const tryOff of tryOffsets) {
            const iconBuf = headerBuf.slice(tryOff, Math.min(tryOff + iconReadSz, headerBuf.length));
            const isPng   = iconBuf.length >= 4 && iconBuf[0] === 0x89 && iconBuf[1] === 0x50 && iconBuf[2] === 0x4E && iconBuf[3] === 0x47;
            const isJpeg  = iconBuf.length >= 3 && iconBuf[0] === 0xFF && iconBuf[1] === 0xD8;
            if (isPng)  { iconDataUrl = `data:image/png;base64,${iconBuf.toString('base64')}`;  break; }
            if (isJpeg) { iconDataUrl = `data:image/jpeg;base64,${iconBuf.toString('base64')}`; break; }
          }
        }
        // Primary scan
        if (!iconDataUrl) iconDataUrl = scanBufferForIcon(headerBuf);
        // If still missing and bodyOffset is beyond our buffer, try scanning there
        if (!iconDataUrl) {
          try {
            const bodyOff = Number(headerBuf.readBigUInt64BE(0x20));
            if (bodyOff > headerBuf.length && bodyOff < size) {
              const winBuf = await ftpReadRange(client, remotePath, bodyOff, Math.min(1024 * 1024, size - bodyOff));
              if (winBuf) iconDataUrl = scanBufferForIcon(winBuf);
            }
          } catch (_) {}
        }

        if (!titleId && sfoData.TITLE_ID) titleId = sfoData.TITLE_ID;
        const sfoTitle = sfoData.TITLE || sfoData.TITLE_00 || sfoData.TITLE_01 ||
                         sfoData.TITLE_02 || sfoData.TITLE_03 || '';
        const fnTitle  = titleFromFilename(remotePath);
        const title    = sfoTitle || fnTitle || titleId || path.basename(remotePath, '.pkg');
        const category = sfoData.CATEGORY || '';
        const appVer   = sfoData.APP_VER  || '';
        const sysVer   = sfoData.SYSTEM_VER != null ? fwFromInt(sfoData.SYSTEM_VER) : '';

        const item = {
          filePath:    remotePath,
          fileName:    fname,
          dirPath:     remotePath.substring(0, remotePath.lastIndexOf('/')),
          fileSize:    size,
          contentId, titleId, title,
          sfoTitle,     // raw SFO game name
          fnTitle,      // filename-guessed name
          category, appVer, sysVer,
          region, pkgType, iconDataUrl,
          isDuplicate: false, isFtp: true, ftpCfg: cfg,
        };
        items.push(item);
        sender.send('scan-progress', { type: 'scan-result', item });
      } catch (e) {
        if (!_ftpRetry) {
          _ftpRetry = true;
          await new Promise(r => setTimeout(r, 500));
          try {
            const hb2 = await ftpReadPkgHeader(client, remotePath);
            if (hb2 && hb2.readUInt32BE(0) === PKG_MAGIC) {
              console.log('[ftp-scan] retry read OK for', fname);
            }
          } catch (_) {}
        }
        console.warn('[ftp-scan] skip', fname, e.message);
      }
      done++;
      sender.send('scan-progress', { type: 'scan-parsing', file: fname, done, total: pkgList.length });
    });  // end withFtpPool callback

    // Mark duplicates
    const cidMap = new Map();
    for (const item of items) {
      if (!item.contentId) continue;
      if (!cidMap.has(item.contentId)) cidMap.set(item.contentId, []);
      cidMap.get(item.contentId).push(item);
    }
    for (const [, g] of cidMap) { if (g.length > 1) g.forEach(i => { i.isDuplicate = true; }); }

    sender.send('scan-progress', { type: 'scan-done', total: items.length });
    return items;
  } catch (e) {
    console.error('[ftp-scan] error:', e);
    sender.send('scan-progress', { type: 'scan-error', message: e.message });
    return [];
  } finally {
    activeCancelFlags.delete(sender.id);
  }
}

// ── File operations ───────────────────────────────────────────────────────────

// Copy with 4 MB buffers, cancel support, and timestamp preservation (M3)
async function copyFileWithProgress(src, dest, progressCallback, cancelCheck) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  const stat  = await fs.promises.stat(src);
  const total = stat.size;
  // Capture source mtime so we can restore it on the copy (preserves original dates)
  const srcMtime = stat.mtime;

  await new Promise((resolve, reject) => {
    let copied = 0;
    // 4 MB read/write buffers: dramatically reduces syscall overhead vs 64 KB default
    const rs = fs.createReadStream(src,  { highWaterMark: 4 * 1024 * 1024 });
    const ws = fs.createWriteStream(dest, { highWaterMark: 4 * 1024 * 1024 });
    let _lastProgressAt = 0;
    rs.on('data', chunk => {
      if (cancelCheck?.()) { rs.destroy(); ws.destroy(); reject(new Error('Cancelled')); return; }
      copied += chunk.length;
      // Throttle progress events to 10fps max — 4MB chunks at high LAN speed
      // can fire hundreds of times/sec and flood the IPC bridge
      const now = Date.now();
      if (now - _lastProgressAt >= 100 || copied >= total) {
        _lastProgressAt = now;
        progressCallback?.({ bytesCopied: copied, totalBytes: total, ts: now });
      }
    });
    rs.on('error', e => { ws.destroy(); reject(e); });
    ws.on('error', e => { rs.destroy(); reject(e); });
    ws.on('finish', resolve);
    rs.pipe(ws);
  });

  // Restore original timestamps
  try { await fs.promises.utimes(dest, srcMtime, srcMtime); } catch (_) {}
}

// Move: atomic rename first, EXDEV fallback to copy+delete with partial-dest cleanup (M1)
async function moveFileWithProgress(src, dest, progressCallback, cancelCheck) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.rename(src, dest);
    progressCallback?.({ bytesCopied: 1, totalBytes: 1 });
  } catch (e) {
    if (e.code === 'EXDEV' || e.code === 'EPERM') {
      // Cross-device move: copy then delete source.
      // If copy fails midway, remove the partial destination file.
      try {
        await copyFileWithProgress(src, dest, progressCallback, cancelCheck);
      } catch (copyErr) {
        fs.promises.unlink(dest).catch(() => {}); // best-effort cleanup of partial dest
        throw copyErr;
      }
      await fs.promises.unlink(src);
    } else {
      throw e;
    }
  }
}

// ── Layout helpers ────────────────────────────────────────────────────────────
function buildDestPath(item, destDir, layout, renameFormat) {
  const safeTitle   = sanitize(item.title || item.titleId || 'Unknown');
  const safeTitleId = sanitize(item.titleId || 'UNKNOWN');
  const safeVer     = sanitize(item.appVer || '00.00');
  const safeRegion  = sanitize(regionDisplay(item.region) || 'UNK');
  const safeCat     = sanitize(categoryDisplay(item.category) || 'Other');
  const origName    = item.fileName;

  let dir, base;
  switch (layout) {
    case 'by-title-id':
      dir  = path.join(destDir, safeTitleId);
      base = origName;
      break;
    case 'by-category':
      dir  = path.join(destDir, safeCat, safeTitleId);
      base = origName;
      break;
    case 'rename':
      dir  = destDir;
      base = applyRenameFormat(renameFormat, item) + '.pkg';
      break;
    case 'rename-organize':
      dir  = path.join(destDir, safeCat, safeTitleId);
      base = applyRenameFormat(renameFormat, item) + '.pkg';
      break;
    default: // 'flat'
      dir  = destDir;
      base = origName;
  }
  return path.join(dir, sanitize(base));
}

function applyRenameFormat(fmt, item) {
  const cat = categoryDisplay(item.category);
  const reg = regionDisplay(item.region);
  return (fmt || '{TITLE_ID} - {TITLE} [v{VERSION}] [{CATEGORY}]')
    .replace(/{TITLE_ID}/g,   sanitize(item.titleId  || 'UNKNOWN'))
    .replace(/{TITLE}/g,      sanitize(item.title    || 'Unknown'))
    .replace(/{VERSION}/g,    sanitize(item.appVer   || '00.00'))
    .replace(/{CATEGORY}/g,   sanitize(cat))
    .replace(/{REGION}/g,     sanitize(reg))
    .replace(/{CONTENT_ID}/g, sanitize(item.contentId || ''))
    .replace(/{REQ_FW}/g,     sanitize(item.sysVer   || ''))
    .trim();
}

function categoryDisplay(cat) {
  const c = (cat || '').toLowerCase().trim();
  if (['gd','gde','gda','gdc','hg'].includes(c)) return 'Game';
  if (c === 'gp')    return 'Patch';
  if (c === 'ac')    return 'DLC';
  if (c === 'theme' || c === 'gdc') return 'Theme';
  if (c === 'app' || c === 'ap') return 'App';
  return c ? c.toUpperCase() : 'Other';
}

function regionDisplay(r) {
  const map = { UP: 'USA', EP: 'EUR', JP: 'JPN', HP: 'ASIA', KP: 'KOR', IP: 'INT' };
  return map[r] || r || '—';
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('open-directory', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('cancel-operation', async event => {
  const cancel = activeCancelFlags.get(event.sender.id);
  if (cancel) cancel();
  activeCancelFlags.delete(event.sender.id);
});

ipcMain.handle('get-all-drives', async () => getAllDrives());

ipcMain.handle('show-in-folder', async (_event, targetPath) => {
  if (!targetPath) return;
  try {
    const stat = await fs.promises.stat(targetPath);
    if (stat.isDirectory()) shell.openPath(targetPath);
    else shell.showItemInFolder(targetPath);
  } catch { shell.showItemInFolder(targetPath); }
});

// Validate external URLs to prevent javascript:/file: scheme abuse
ipcMain.handle('open-external', async (_event, url) => {
  if (!url || typeof url !== 'string') return;
  if (!/^https?:\/\//i.test(url)) return; // only allow http(s)
  shell.openExternal(url);
});

ipcMain.handle('clipboard-write', async (_event, text) => {
  clipboard.writeText(text || '');
});

ipcMain.handle('scan-pkgs', async (event, sourceDir, scanDepth) => {
  return scanPkgs(sourceDir, event.sender, scanDepth);
});

// ── FTP IPC ───────────────────────────────────────────────────────────────────
ipcMain.handle('ftp-scan-pkgs', async (event, cfg) => scanPkgsFtp(cfg, event.sender));

ipcMain.handle('ftp-test-conn', async (_e, cfg) => {
  let client;
  try {
    client = await makeFtpClient(cfg);
    const list = await client.list(cfg.path || '/');
    return { ok: true, entries: list.length };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { try { client?.close(); } catch (_) {} }
});

ipcMain.handle('delete-pkgs', async (_event, items) => {
  const results = [];
  for (const item of items) {
    if (item.isFtp) {
      // FTP delete
      let client;
      try {
        client = await makeFtpClient(item.ftpCfg);
        await client.remove(item.filePath);
        results.push({ filePath: item.filePath, ok: true });
      } catch (e) {
        results.push({ filePath: item.filePath, ok: false, error: e.message });
      } finally { try { client?.close(); } catch (_) {} }
    } else {
      try   { await fs.promises.unlink(item.filePath); results.push({ filePath: item.filePath, ok: true }); }
      catch (e) { results.push({ filePath: item.filePath, ok: false, error: e.message }); }
    }
  }
  return results;
});

ipcMain.handle('rename-pkg', async (_event, item, newName) => {
  const sanitized = sanitize(newName);
  if (!sanitized) return { error: 'Invalid name' };
  if (sanitized.includes('/') || sanitized.includes('\\')) return { error: 'Name cannot contain path separators' };
  if (!sanitized.toLowerCase().endsWith('.pkg')) return { error: 'File must have .pkg extension' };

  if (item.isFtp) {
    const newRemote = item.dirPath.replace(/\/$/, '') + '/' + sanitized;
    let client;
    try {
      client = await makeFtpClient(item.ftpCfg);
      await client.rename(item.filePath, newRemote);
      try { client?.close(); } catch (_) {}
      return { ok: true, newPath: newRemote, newFileName: sanitized };
    } catch (e) { return { error: e.message }; }
    finally { try { client?.close(); } catch (_) {} }
  }

  const newPath = path.join(item.dirPath, sanitized);
  if (path.dirname(newPath) !== item.dirPath) return { error: 'Path traversal not allowed' };
  try {
    await fs.promises.rename(item.filePath, newPath);
    return { ok: true, newPath, newFileName: sanitized };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('check-pkg-conflicts', async (_event, items, destDir, layout, renameFormat) => {
  const conflicts = [];
  for (const item of items) {
    if (item.isFtp) continue; // skip FTP-source conflict check (no local stat available)
    const dest = buildDestPath(item, destDir, layout, renameFormat);
    try { await fs.promises.access(dest, fs.constants.F_OK); conflicts.push({ item, destPath: dest }); }
    catch { /* no conflict */ }
  }
  return conflicts;
});

// go-pkgs: handles Local→Local, FTP→Local (download), Local→FTP (upload), FTP→FTP (relay)
ipcMain.handle('go-pkgs', (event, items, destDir, action, layout, renameFormat, ftpDest, conflictModes) => {
  _runGoPkgs(event.sender, items, destDir, action, layout, renameFormat, ftpDest, conflictModes).catch(e => {
    event.sender.send('go-progress', { type: 'go-file-error', file: '', error: e.message });
    event.sender.send('go-progress', { type: 'go-done', ok: 0, error: 1, skipped: 0 });
  });
  return { ok: true, started: true };
});

async function _runGoPkgs(sender, items, destDir, action, layout, renameFormat, ftpDest, conflictModes) {
  // conflictModes: { [filePath]: 'skip'|'overwrite'|'rename' }
  const controller = new AbortController();
  activeCancelFlags.set(sender.id, () => controller.abort());
  const cancelCheck = () => controller.signal.aborted;

  const results = { ok: 0, skipped: 0, error: 0 };
  const total   = items.length;
  sender.send('go-progress', { type: 'go-start', total });

  // Shared FTP client for upload destination (created lazily)
  let destFtpClient = null;
  const getDestFtp = async () => {
    if (!destFtpClient) destFtpClient = await makeFtpClient(ftpDest);
    return destFtpClient;
  };

  try {
    for (let i = 0; i < items.length; i++) {
      if (cancelCheck()) { results.skipped += items.length - i; break; }

      const item     = items[i];
      const isFtpSrc = !!item.isFtp;
      let   destPath;

      if (ftpDest) {
        const rel = buildDestPath({ ...item, dirPath: '' }, '', layout, renameFormat);
        destPath  = (ftpDest.path || '/').replace(/\/$/, '') + '/' + rel.replace(/\\/g, '/').replace(/^\//, '');
      } else {
        destPath = buildDestPath(item, destDir, layout, renameFormat);
      }

      // Apply conflict resolution mode
      if (conflictModes) {
        const mode = conflictModes[item.filePath];
        if (mode === 'skip') { results.skipped++; continue; }
        if (mode === 'rename') {
          // Auto-rename: append _2, _3... until no conflict
          const ext  = path.extname(destPath);
          const base = destPath.slice(0, -ext.length);
          let n = 2;
          while (true) {
            const candidate = `${base}_${n}${ext}`;
            try { await fs.promises.access(candidate, fs.constants.F_OK); n++; }
            catch { destPath = candidate; break; }
          }
        }
        // 'overwrite' or undefined: proceed normally (fs will overwrite)
      }

      sender.send('go-progress', { type: 'go-file-start', file: item.fileName, current: i+1, total, destPath });

      try {
        if (isFtpSrc && !ftpDest) {
          // FTP → Local
          let client;
          try {
            client = await makeFtpClient(item.ftpCfg);
            await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
            client.trackProgress(info => {
              sender.send('go-progress', { type: 'go-file-progress', bytesCopied: info.bytes, totalBytes: item.fileSize, ts: Date.now() });
            });
            await client.downloadTo(destPath, item.filePath);
            client.trackProgress();
          } finally { try { client?.close(); } catch (_) {} }

        } else if (!isFtpSrc && ftpDest) {
          // Local → FTP
          const ftpClient = await getDestFtp();
          const remoteDir = destPath.substring(0, destPath.lastIndexOf('/'));
          if (remoteDir) { try { await ftpClient.ensureDir(remoteDir); } catch (_) {} }
          ftpClient.trackProgress(info => {
            sender.send('go-progress', { type: 'go-file-progress', bytesCopied: info.bytes, totalBytes: item.fileSize, ts: Date.now() });
          });
          await ftpClient.uploadFrom(item.filePath, destPath);
          ftpClient.trackProgress();

        } else if (isFtpSrc && ftpDest) {
          // FTP → FTP: relay via temp file
          const tmpPath = path.join(os.tmpdir(), `ps4vault_${Date.now()}_${item.fileName}`);
          let dlClient;
          try {
            dlClient = await makeFtpClient(item.ftpCfg);
            dlClient.trackProgress(info => {
              sender.send('go-progress', { type: 'go-file-progress', bytesCopied: info.bytes, totalBytes: item.fileSize, ts: Date.now() });
            });
            await dlClient.downloadTo(tmpPath, item.filePath);
            dlClient.trackProgress();
          } finally { try { dlClient?.close(); } catch (_) {} }
          try {
            const ulClient = await getDestFtp();
            const remDir   = destPath.substring(0, destPath.lastIndexOf('/'));
            if (remDir) { try { await ulClient.ensureDir(remDir); } catch (_) {} }
            await ulClient.uploadFrom(tmpPath, destPath);
          } finally { fs.promises.unlink(tmpPath).catch(() => {}); }

        } else {
          // Local → Local
          const fn = action === 'move' ? moveFileWithProgress : copyFileWithProgress;
          await fn(item.filePath, destPath, ({ bytesCopied, totalBytes }) => {
            sender.send('go-progress', { type: 'go-file-progress', bytesCopied, totalBytes, ts: Date.now(), file: item.fileName, current: i+1, total });
          }, cancelCheck);
        }

        sender.send('go-progress', { type: 'go-file-done', file: item.fileName, destPath });
        results.ok++;
      } catch (e) {
        if (cancelCheck()) results.skipped++;
        else {
          console.error('[go] error on', item.fileName, e.message);
          sender.send('go-progress', { type: 'go-file-error', file: item.fileName, error: e.message });
          results.error++;
        }
      }
    }
  } finally {
    try { destFtpClient?.close(); } catch (_) {}
    activeCancelFlags.delete(sender.id);
    sender.send('go-progress', { type: 'go-done', ...results });
  }
  return results;
};


// ══════════════════════════════════════════════════════════════════════════════
// ── Remote PKG Installer (flatz/ps4_remote_pkg_installer, port 12800) ────────
// ══════════════════════════════════════════════════════════════════════════════
// How it works:
//   1. PS4 Vault starts a local HTTP server on a user-chosen port (default 8090)
//      that serves PKG files by filename with full byte-range support.
//   2. For each selected PKG, we POST the file URL to the PS4's installer API:
//      POST http://<PS4_IP>:12800/api/install  { type:"direct", packages:["http://PC_IP:PORT/file.pkg"] }
//   3. The PS4 pulls the PKG from our server and installs it.
//   4. We poll /api/get_task_progress every 3 s and forward progress events to renderer.

// ── Local IP detection ────────────────────────────────────────────────────────
function getLocalIp() {
  const nets = os.networkInterfaces();
  // Prefer a 192.168.x.x or 10.x.x.x address (same LAN as PS4)
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('192.168.') || net.address.startsWith('10.')) return net.address;
    }
  }
  // Fall back to first external IPv4
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

// ── IPC: misc helpers ────────────────────────────────────────────────────────
ipcMain.handle('get-app-path',  () => __dirname);
ipcMain.handle('get-local-ip',  () => getLocalIp());
ipcMain.handle('get-log-path',  () => LOG_FILE);
ipcMain.handle('open-log',      () => shell.openPath(LOG_FILE).catch(() => shell.showItemInFolder(LOG_FILE)));
ipcMain.handle('open-log-folder', () => shell.openPath(LOG_DIR).catch(() => {}));

// ── Library persistence ───────────────────────────────────────────────────────
const LIBRARY_FILE = path.join(LOG_DIR, 'library.json');
ipcMain.handle('save-library', async (_e, items) => {
  try {
    // Strip iconDataUrl blobs before saving (they're regenerated on scan)
    // Keep iconDataUrl so covers display after library reload.
    // Strip only ftpCfg (contains credentials) and _b64key (runtime-only).
    const slim = items.map(i => { const { ftpCfg, _b64key, ...rest } = i; return rest; });
    await fs.promises.writeFile(LIBRARY_FILE, JSON.stringify(slim));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('load-library', async () => {
  try {
    const raw  = await fs.promises.readFile(LIBRARY_FILE, 'utf8');
    const items = JSON.parse(raw);
    // Normalise items: fill any fields that may be missing from older saved libraries.
    // This makes PS4 Vault resilient to schema changes between versions.
    const normalised = items.map(item => {
      // Recompute fnTitle from fileName if missing (was not saved in older versions)
      const fnTitle = item.fnTitle != null
        ? item.fnTitle
        : titleFromFilename(item.filePath || item.fileName || '');
      // Recompute best-effort title
      const title = item.sfoTitle || fnTitle || item.titleId || item.fileName || '';
      // Ensure dirPath is set (older saves may have stored it differently)
      const dirPath = item.dirPath ||
        (item.filePath ? path.dirname(item.filePath) : '');
      return {
        // Mandatory display fields — never undefined
        filePath:    item.filePath    || '',
        fileName:    item.fileName    || path.basename(item.filePath || ''),
        dirPath,
        fileSize:    item.fileSize    || 0,
        contentId:   item.contentId   || '',
        titleId:     item.titleId     || '',
        title,
        sfoTitle:    item.sfoTitle    || '',
        fnTitle:     fnTitle          || '',
        category:    item.category    || '',
        appVer:      item.appVer      || '',
        sysVer:      item.sysVer      || '',
        region:      item.region      || '',
        pkgType:     item.pkgType     ?? 0,
        iconDataUrl: item.iconDataUrl || null,
        isDuplicate: item.isDuplicate ?? false,
        isFtp:       item.isFtp       ?? false,
        isInstalled: item.isInstalled ?? false,
        isPartial:   item.isPartial   ?? false,
        ftpCfg:      null, // never persist credentials
      };
    });
    return { ok: true, items: normalised };
  } catch { return { ok: false, items: [] }; }
});

// Refetch covers for local PKGs missing iconDataUrl.
// Streams results back via 'cover-ready' events as they complete — 
// UI updates live, no waiting for all files to finish.
// Uses SCAN_CONCURR parallel workers for maximum throughput.
ipcMain.handle('refetch-covers', async (event, filePaths) => {
  if (!filePaths.length) return { ok: true };
  const sender   = event.sender;
  const queue    = [...filePaths];
  const concurr  = Math.min(SCAN_CONCURR, queue.length, 8);
  let   done     = 0;

  const worker = async () => {
    while (queue.length > 0) {
      const fp = queue.shift();
      if (!fp) break;
      try {
        await fs.promises.access(fp, fs.constants.R_OK);
        const parsed = await parsePkgFile(fp);
        if (parsed.iconDataUrl) {
          // Send immediately so the cover appears as soon as it's ready
          if (!sender.isDestroyed())
            sender.send('cover-ready', { filePath: fp, iconDataUrl: parsed.iconDataUrl });
        }
      } catch (_) {}
      done++;
      // Progress ping every 10 items
      if (done % 10 === 0 && !sender.isDestroyed())
        sender.send('cover-ready', { progress: done, total: filePaths.length });
    }
  };

  // Launch workers in parallel, return immediately
  Promise.all(Array.from({ length: concurr }, worker))
    .then(() => {
      if (!sender.isDestroyed())
        sender.send('cover-ready', { done: true, total: filePaths.length });
    })
    .catch(() => {});

  return { ok: true, total: filePaths.length };
});
ipcMain.handle('clear-library', async () => {
  try { await fs.promises.unlink(LIBRARY_FILE); } catch {}
  return { ok: true };
});

// ── Settings get/set ──────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(LOG_DIR, 'settings.json');
ipcMain.handle('get-setting', async (_e, key) => {
  try { const s = JSON.parse(await fs.promises.readFile(SETTINGS_FILE,'utf8')); return s[key]; } catch { return null; }
});
ipcMain.handle('set-setting', async (_e, key, val) => {
  let s = {}; try { s = JSON.parse(await fs.promises.readFile(SETTINGS_FILE,'utf8')); } catch {}
  s[key] = val;
  await fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(s));
  // Apply certain settings immediately at runtime
  if (key === 'ftpPool' && typeof val === 'number' && val >= 1 && val <= 8) {
    FTP_POOL_SIZE = val;
    console.log(`[settings] FTP_POOL_SIZE = ${val}`);
  }
  return { ok: true };
});

// ── PKG integrity check ───────────────────────────────────────────────────────
ipcMain.handle('verify-pkg', async (_e, filePath) => {
  try {
    const hash = crypto.createHash('sha256');
    const stat = await fs.promises.stat(filePath);
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return { ok: true, sha256: hash.digest('hex'), size: stat.size };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Network speed test to PS4 ─────────────────────────────────────────────────
ipcMain.handle('speed-test-ps4', async (_e, ps4Ip, ps4Port, fileServerPort) => {
  // Measure LAN throughput by timing an FTP download from PS4.
  // We cut the stream after TEST_BYTES so we never download an entire 50GB game.
  // Speed measured = bytes received / wall-clock seconds = real network throughput.
  const TEST_BYTES = 8 * 1024 * 1024; // 8 MB target — enough for accuracy, fast to complete
  let client;

  try {
    const ftpCfg = { host: ps4Ip, port: 2121, user: 'anonymous', pass: '' };
    client = await makeFtpClient(ftpCfg);

    // ── Find the largest readable file on the PS4 ─────────────────────────────
    // Walk directories in order, pick the single largest file we can find.
    // We prefer files >TEST_BYTES so we can cut early rather than reading the whole thing.
    const candidateDirs = [
      '/user/app', '/system', '/system_ex', '/user/data',
      '/system_data', '/mnt/sandbox', '/',
    ];
    let testFile = null, testSize = 0;
    for (const dir of candidateDirs) {
      try {
        const entries = await client.list(dir);
        for (const e of entries) {
          if (!e.isDirectory && e.size > testSize) {
            const base = dir === '/' ? '' : dir;
            testFile = base + '/' + e.name;
            testSize = e.size;
          }
        }
        // Recurse one level into directories to find game data
        if (testSize < TEST_BYTES) {
          for (const e of entries) {
            if (!e.isDirectory) continue;
            try {
              const sub = await client.list((dir === '/' ? '' : dir) + '/' + e.name);
              for (const f of sub) {
                if (!f.isDirectory && f.size > testSize) {
                  testFile = (dir === '/' ? '' : dir) + '/' + e.name + '/' + f.name;
                  testSize = f.size;
                }
              }
            } catch (_) {}
            if (testSize >= TEST_BYTES) break;
          }
        }
      } catch (_) {}
      if (testSize >= TEST_BYTES) break;
    }

    if (!testFile || testSize < 1024) {
      return { ok: false, error: 'No readable files found on PS4. Make sure FTP server is running and files exist.' };
    }

    console.log('[speed-test] testing with ' + testFile + ' (' + (testSize/1024/1024).toFixed(1) + ' MB)');

    // ── Download and cut after TEST_BYTES ─────────────────────────────────────
    // Use a Writable that stops accepting data once we have enough.
    // We destroy the underlying socket cleanly so the FTP session recovers.
    const { Writable } = require('stream');
    let received = 0;
    let startTime = 0;
    let cutDone = false;

    const result = await new Promise((resolve) => {
      const sink = new Writable({
        write(chunk, _, cb) {
          if (!startTime) startTime = Date.now();
          received += chunk.length;
          cb();
          // Cut the stream once we have enough data
          if (!cutDone && received >= TEST_BYTES) {
            cutDone = true;
            const elapsed = (Date.now() - startTime) / 1000;
            const mbps    = parseFloat((received / elapsed / 1024 / 1024).toFixed(2));
            const mbpsNet = parseFloat((received * 8 / elapsed / 1024 / 1024).toFixed(1));
            // Signal done — destroy will cause downloadTo to reject, we catch below
            this.destroy();
            resolve({ ok: true, mbps, mbpsNet, elapsed: Math.round(elapsed * 1000), size: received });
          }
        },
        final(cb) {
          // Stream ended naturally (file smaller than TEST_BYTES) — still measure it
          if (!cutDone && received > 0 && startTime) {
            const elapsed = (Date.now() - startTime) / 1000;
            if (elapsed >= 0.2 && received >= 64 * 1024) {
              const mbps    = parseFloat((received / elapsed / 1024 / 1024).toFixed(2));
              const mbpsNet = parseFloat((received * 8 / elapsed / 1024 / 1024).toFixed(1));
              resolve({ ok: true, mbps, mbpsNet, elapsed: Math.round(elapsed * 1000), size: received });
            } else {
              resolve({ ok: false, error: 'File too small or transfer too fast — try with a larger file on the console' });
            }
          }
          cb();
        }
      });

      client.downloadTo(sink, testFile, 0).catch(e => {
        // Expected: we destroyed the stream early. If we already resolved, ignore.
        if (!cutDone && received > 0 && startTime) {
          const elapsed = (Date.now() - startTime) / 1000;
          if (elapsed >= 0.2 && received >= 64 * 1024) {
            const mbps    = parseFloat((received / elapsed / 1024 / 1024).toFixed(2));
            const mbpsNet = parseFloat((received * 8 / elapsed / 1024 / 1024).toFixed(1));
            resolve({ ok: true, mbps, mbpsNet, elapsed: Math.round(elapsed * 1000), size: received });
          } else {
            resolve({ ok: false, error: e.message });
          }
        }
      });

      // Timeout: 20s max
      setTimeout(() => {
        if (!cutDone) {
          if (received > 64 * 1024 && startTime) {
            const elapsed = (Date.now() - startTime) / 1000;
            const mbps    = parseFloat((received / elapsed / 1024 / 1024).toFixed(2));
            const mbpsNet = parseFloat((received * 8 / elapsed / 1024 / 1024).toFixed(1));
            resolve({ ok: true, mbps, mbpsNet, elapsed: Math.round(elapsed * 1000), size: received, note: 'timeout' });
          } else {
            resolve({ ok: false, error: 'Timed out — PS4 FTP connected but no data received' });
          }
        }
      }, 20000);
    });

    console.log('[speed-test] ' + (result.ok ? result.mbps + ' MB/s (' + result.mbpsNet + ' Mbps)' : 'failed: ' + result.error));
    return result;

  } catch (e) {
    console.warn('[speed-test] error:', e.message);
    return { ok: false, error: e.message };
  } finally {
    try { client?.close(); } catch (_) {}
  }
});

// ── Quick TCP port probe ──────────────────────────────────────────────────────
function tcpProbe(hostname, port, timeoutMs = 5000) {
  const net = require('net');
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = ok => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error',   () => finish(false));
    sock.connect(port, hostname);
  });
}

// ── IPC: test PS4 installer reachability ─────────────────────────────────────
ipcMain.handle('test-ps4-conn', async (_e, ps4Ip, ps4Port) => {
  ps4Port = parseInt(ps4Port) || 12800;
  if (!ps4Ip) return { ok: false, error: 'No IP provided' };
  const open = await tcpProbe(ps4Ip.trim(), ps4Port, 5000);
  if (!open) return {
    ok: false,
    error: `Port ${ps4Port} not reachable on ${ps4Ip} — launch Remote PKG Installer and keep it IN FOCUS`,
  };
  return { ok: true, status: 200 };
});

// ── PKG HTTP file server (mirrors DPI's PS4Server exactly) ───────────────────
// Port: DPI uses 9898. We use the user-configured serverPort.
// Key DPI behaviours copied exactly:
//   • Accept-Ranges: none  (tells PS4 NOT to send Range requests)
//   • Connection: Keep-Alive
//   • Content-Disposition: attachment; filename="app.pkg"  (always app.pkg)
//   • No byte-range handling — full file only
//   • URL path: /file/?b64=BASE64(localFilePath)

let pkgServer        = null;
let pkgServerPort    = 0;
let pkgFileMap       = new Map(); // b64key → absolute local path
let pkgServerLastHit     = null;
let pkgServerActiveConns = 0;
let pkgServerProgressCb  = null;
let pkgServerBytesMap    = new Map(); // b64key → cumulative bytes sent (all connections)
// Speed tracking: ring buffer of {t, b} samples, minimum 150ms apart, kept for 4s window
let pkgServerSpeedBuf    = [];
let pkgServerSpeedLast   = 0;   // timestamp of last sample push (throttle gate)
let pkgServerXferStart   = 0;

async function startPkgServer(port, items) {
  await stopPkgServer();
  pkgFileMap = new Map();
  pkgServerLastHit     = null;
  pkgServerActiveConns = 0;
  pkgServerBytesMap    = new Map();
  pkgServerSpeedBuf    = [];
  pkgServerSpeedLast   = 0;
  pkgServerXferStart   = 0;

  // Register each item under a b64 key, exactly as DPI does with /file/?b64=
  for (const item of items) {
    if (!item.filePath || item.isFtp) continue;
    const b64 = Buffer.from(item.filePath).toString('base64url'); // url-safe: no +/=
    pkgFileMap.set(b64, item.filePath);
    item._b64key = b64;
  }

  return new Promise((resolve, reject) => {
    pkgServer = http.createServer(async (req, res) => {
      try {
        // Parse path: /file/?b64=XXXX
        // PS5/etaHEN appends extra params like &threadId=0?product=...&serverIpAddr=...
        // Strip them to recover the original b64 key.
        const rawUrl = req.url;
        const qIdx   = rawUrl.indexOf('?');
        const query  = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';
        // Extract raw b64 value — everything between 'b64=' and first '&' or end
        const b64Match = query.match(/(?:^|&)b64=([^&]*)/);
        // Also strip any malformed '?...' suffix that PS5 appends mid-value
        const b64Raw  = b64Match ? b64Match[1].split('?')[0] : '';
        // Decode %XX encoding but leave + as-is (we use base64url so no + expected)
        const b64     = decodeURIComponent(b64Raw);
        const fpath   = b64 ? pkgFileMap.get(b64) : null;

        if (!fpath) {
          console.warn('[pkg-server] 404:', req.url);
          res.writeHead(404); res.end('Not found');
          return;
        }

        const stat  = await fs.promises.stat(fpath);
        const total = stat.size;

        pkgServerLastHit = Date.now();
        pkgServerActiveConns++;
        console.log(`[pkg-server] ${req.method} /file/?b64=... → ${path.basename(fpath)} (${total} bytes) [active:${pkgServerActiveConns}]`);

        const displayName = encodeURIComponent(path.basename(fpath));
        const baseHeaders = {
          'Content-Type':        'application/octet-stream',
          'Accept-Ranges':       'bytes',   // MUST be bytes — PS5 makes parallel range requests
          'Connection':          'Keep-Alive',
          'Content-Disposition': `attachment; filename="app.pkg"; filename*=UTF-8''${displayName}`,
        };

        // HEAD: headers only, no body
        if (req.method === 'HEAD') {
          res.writeHead(200, { ...baseHeaders, 'Content-Length': String(total) });
          res.end();
          pkgServerActiveConns = Math.max(0, pkgServerActiveConns - 1);
          return;
        }

        // Byte-range support — PS5 opens multiple parallel connections for
        // different byte ranges. Without this, each connection gets bytes 0..N
        // and the PS5 stitches wrong data together → SHA digest mismatch.
        const rangeHeader = req.headers['range'];
        let start = 0, end = total - 1;
        if (rangeHeader) {
          const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
          if (m) {
            start = m[1] ? parseInt(m[1], 10) : total - parseInt(m[2], 10);
            end   = m[2] ? parseInt(m[2], 10) : total - 1;
            if (start > end || end >= total) { res.writeHead(416); res.end(); pkgServerActiveConns = Math.max(0, pkgServerActiveConns - 1); return; }
          }
        }
        const chunkSize = end - start + 1;
        const isPartial = rangeHeader && (start > 0 || end < total - 1);

        if (isPartial) {
          res.writeHead(206, {
            ...baseHeaders,
            'Content-Length': String(chunkSize),
            'Content-Range':  `bytes ${start}-${end}/${total}`,
          });
        } else {
          res.writeHead(200, { ...baseHeaders, 'Content-Length': String(total) });
        }

        // Aggregate bytes across ALL parallel range connections for this file.
        // PS5 opens 4–8 simultaneous range requests — each reports its own bytes,
        // but we add them all into pkgServerBytesMap[b64] to get the true total.
        if (!pkgServerBytesMap.has(b64)) pkgServerBytesMap.set(b64, 0);
        if (!pkgServerXferStart) pkgServerXferStart = Date.now();

        const stream = fs.createReadStream(fpath, { start, end });
        stream.on('data', chunk => {
          // Accumulate into the shared counter
          const prev = pkgServerBytesMap.get(b64) || 0;
          pkgServerBytesMap.set(b64, prev + chunk.length);
          pkgServerLastHit = Date.now();

          if (pkgServerProgressCb) {
            const totalSent = pkgServerBytesMap.get(b64);
            const now = Date.now();

            // ── Throttled sample push: min 150ms between samples ──────────────
            if (now - pkgServerSpeedLast >= 150) {
              pkgServerSpeedBuf.push({ t: now, b: totalSent });
              pkgServerSpeedLast = now;
              // Keep only samples from the last 4 seconds (sliding window)
              const cutoff = now - 4000;
              while (pkgServerSpeedBuf.length > 1 && pkgServerSpeedBuf[0].t < cutoff)
                pkgServerSpeedBuf.shift();
            }

            // ── Speed: bytes-in-last-3s / 3s (accurate, outlier-resistant) ───
            let speed = 0;
            if (pkgServerSpeedBuf.length >= 2) {
              // Use samples within last 3s only (discard older startup noise)
              const win = pkgServerSpeedBuf.filter(s => s.t >= now - 3000);
              if (win.length >= 2) {
                const dt = (win[win.length - 1].t - win[0].t) / 1000;
                const db = win[win.length - 1].b - win[0].b;
                if (dt > 0.1) speed = db / dt;
              } else {
                // Not enough recent samples — use full buffer
                const oldest = pkgServerSpeedBuf[0];
                const dt = (now - oldest.t) / 1000;
                if (dt > 0.1) speed = (totalSent - oldest.b) / dt;
              }
            }

            const pct = total > 0 ? Math.round(totalSent / total * 100) : null;
            // ETA: clamp to reasonable range (no negative, cap at 24h)
            const remaining = total - totalSent;
            const eta = speed > 1024 && remaining > 0
              ? Math.min(Math.round(remaining / speed), 86400) : null;

            pkgServerProgressCb({
              file: path.basename(fpath), bytesSent: totalSent, totalBytes: total,
              speed, pct, eta,
            });
          }
        });
        stream.pipe(res);
        res.on('finish', () => {
          pkgServerActiveConns = Math.max(0, pkgServerActiveConns - 1);
          console.log(`[pkg-server] ${isPartial ? 'RANGE' : 'GET'} complete: bytes ${start}-${end} [active:${pkgServerActiveConns}]`);
        });
        res.on('close', () => { pkgServerActiveConns = Math.max(0, pkgServerActiveConns - 1); });

      } catch (e) {
        console.error('[pkg-server] error:', e.message);
        try { res.writeHead(500); res.end(); } catch (_) {}
      }
    });

    pkgServer.on('error', err => { pkgServer = null; reject(err); });
    pkgServer.listen(port, '0.0.0.0', () => {
      pkgServerPort = port;
      console.log(`[pkg-server] listening on 0.0.0.0:${port} (DPI-compatible mode)`);

      // Configure Windows Firewall asynchronously — NEVER use execSync here.
      // execSync blocks the entire main process event loop, freezing all IPC,
      // button clicks, and progress events while PowerShell runs (up to 30s).
      if (process.platform === 'win32') {
        const { exec } = require('child_process');
        const ruleName = `PS4Vault-PKGServer-${port}`;
        const psCmd = [
          `Remove-NetFirewallRule -DisplayName '${ruleName}' -ErrorAction SilentlyContinue`,
          `New-NetFirewallRule -DisplayName '${ruleName}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any`,
          `Set-NetFirewallProfile -Profile Domain,Private,Public -AllowInboundRules True`,
          `Set-NetFirewallProfile -Profile Domain,Private,Public -DefaultInboundAction Allow`,
        ].join('; ');

        // Run PowerShell async — UI stays fully responsive during firewall setup
        const runPS = (cmd, elevated) => new Promise(res => {
          const shell = elevated
            ? `powershell -NoProfile -NonInteractive -Command "Start-Process powershell -ArgumentList '-NoProfile -NonInteractive -Command ''${cmd.replace(/'/g,"''")}''''' -Verb RunAs -Wait"`
            : `powershell -NoProfile -NonInteractive -Command "${cmd.replace(/"/g,'\\"')}"`;
          exec(shell, { windowsHide: !elevated, timeout: elevated ? 35000 : 10000 },
            (err) => res(!err));
        });

        // Fire and don't await — firewall configures in background while server is already listening
        runPS(psCmd, false).then(ok => {
          if (ok) { console.log(`[pkg-server] Firewall configured for port ${port}`); return; }
          return runPS(psCmd, true).then(ok2 => {
            if (ok2) console.log(`[pkg-server] Firewall configured for port ${port} (via UAC)`);
            else console.warn(`[pkg-server] Could not configure firewall — PS4/PS5 may not reach port ${port}`);
          });
        }).catch(() => {});
      }
      resolve();
    });
  });
}

function stopPkgServer() {
  return new Promise(resolve => {
    if (!pkgServer) { resolve(); return; }
    const s = pkgServer; pkgServer = null;
    s.close(() => resolve());
    try { s.closeAllConnections?.(); } catch (_) {}
  });
}

// ── HTTP POST to PS4/PS5 installer ────────────────────────────────────────────
// Mirrors DPI's HttpClient.PostAsync with StringContent(JSON, UTF8)
// which sends Content-Type: text/plain; charset=utf-8
function dpiHttpPost(hostname, port, urlPath, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const args = [
      '--silent', '--show-error',
      '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '--connect-timeout', '10',
      '-X', 'POST',
      '-H', 'Content-Type: text/plain; charset=utf-8',
      '-H', 'Expect:',
      '--data-raw', bodyStr,
      '--write-out', '\n__STATUS__%{http_code}',
      '--output', '-',
      `http://${hostname}:${port}${urlPath}`,
    ];
    const proc = spawn('curl.exe', args, { windowsHide: true });
    const out = []; const err = [];
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => err.push(d));
    proc.on('error', e => reject(Object.assign(new Error('curl not found: ' + e.message), { code: 'ENOENT' })));
    proc.on('close', code => {
      const raw    = Buffer.concat(out).toString('utf8');
      const errStr = Buffer.concat(err).toString('utf8').trim();

      if (code === 52) {
        // Empty reply — command accepted silently (GoldHEN/some RPI versions)
        resolve({ status: 200, body: '', emptyReply: true });
        return;
      }
      if (code !== 0) {
        const msg = errStr.includes('Connection refused') ? `Connection refused at ${hostname}:${port}`
          : errStr.includes('timed out') ? `Timed out connecting to PS4/PS5`
          : errStr || `curl exit ${code}`;
        reject(new Error(msg));
        return;
      }
      const sepIdx = raw.lastIndexOf('\n__STATUS__');
      const status = sepIdx >= 0 ? parseInt(raw.slice(sepIdx + 11), 10) : NaN;
      const body   = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
      if (isNaN(status)) {
        resolve({ status: 200, body: raw, emptyReply: true });
      } else {
        resolve({ status, body });
      }
    });
  });
}

// ── Installer type detection (mirrors DPI's IPHelper) ─────────────────────────
// RPI  (flatz):    GET :12800/api  → "Unsupported method" + "fail"
// etaHEN/GoldHEN: GET :12800/     → body contains "etaHEN"
async function detectInstallerType(ip, port) {
  const curlGet = (path, ms) => new Promise(resolve => {
    const { spawn } = require('child_process');
    const proc = spawn('curl.exe',
      ['--silent', '--max-time', String(Math.ceil((ms||3000)/1000)),
       '--connect-timeout', '3', `http://${ip}:${port}${path}`],
      { windowsHide: true });
    const out = [];
    proc.stdout.on('data', d => out.push(d));
    proc.on('error', () => resolve(''));
    proc.on('close', () => resolve(Buffer.concat(out).toString('utf8')));
  });

  // Check RPI: GET /api → body contains "Unsupported method" AND "fail"
  const apiBody = await curlGet('/api', 3000);
  if (apiBody.includes('Unsupported method') && apiBody.includes('fail')) {
    console.log('[install] Detected: RPI (flatz Remote PKG Installer)');
    return 'rpi';
  }

  // Check etaHEN: GET / → body contains "etaHEN"
  const rootBody = await curlGet('/', 3000);
  if (rootBody.toLowerCase().includes('etahen')) {
    console.log('[install] Detected: etaHEN');
    return 'etahen';
  }

  // Could be RPI that doesn't respond to /api, or GoldHEN, or something else.
  // Default to RPI-style (/api/install JSON POST).
  console.log(`[install] Installer type unclear (api:"${apiBody.slice(0,40)}" root:"${rootBody.slice(0,40)}") — defaulting to RPI`);
  return 'rpi';
}

// ── PushRPI: mirrors DPI's Installer.PushRPI exactly ─────────────────────────
// POST /api/install  body: {"type":"direct","packages":["URL_ENCODED_URL"]}
// Content-Type: text/plain; charset=utf-8   (StringContent default in C#)
// URL is HttpUtility.UrlEncode'd inside the JSON string
async function pushRPI(ps4Ip, ps4Port, pkgUrl) {
  // HttpUtility.UrlEncode: encodeURIComponent then replace %20 with + (form encoding)
  const escaped = encodeURIComponent(pkgUrl).replace(/%20/g, '+');
  const jsonBody = `{"type":"direct","packages":["${escaped}"]}`;
  console.log(`[install] PushRPI → ${ps4Ip}:${ps4Port} json=${jsonBody}`);

  const r = await dpiHttpPost(ps4Ip, ps4Port, '/api/install', jsonBody, 20000);
  if (r.emptyReply) {
    console.log('[install] PushRPI: empty reply — accepted silently');
    return { ok: true, taskId: null };
  }
  console.log(`[install] PushRPI response HTTP ${r.status}: ${r.body}`);
  if (!r.body.includes('"success"') && r.status !== 200) {
    throw new Error(`PS4 RPI error (${r.status}): ${r.body}`);
  }
  let taskId = null;
  try { taskId = JSON.parse(r.body).task_id ?? null; } catch (_) {}
  return { ok: true, taskId };
}

// ── PushEtaHen: POST to etaHEN/GoldHEN /upload using curl -F (multipart) ─────
// Uses curl's native -F flag to build the multipart body — this matches exactly
// what C# HttpClient.PostAsync with MultipartFormDataContent produces.
// -F 'file=;type=application/octet-stream'  → empty file field (required by etaHEN)
// -F 'url=http://...'                        → URL field with the package URL
async function pushEtaHen(ps4Ip, ps4Port, pkgUrl) {
  console.log(`[install] PushEtaHen → ${ps4Ip}:${ps4Port}/upload url=${pkgUrl}`);
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const args = [
      '--silent', '--show-error',
      '--max-time', '20',
      '--connect-timeout', '10',
      '-H', 'Expect:',
      '-F', 'file=;type=application/octet-stream',
      '-F', `url=${pkgUrl}`,
      `http://${ps4Ip}:${ps4Port}/upload`,
    ];
    const proc = spawn('curl.exe', args, { windowsHide: true });
    const out = []; const err = [];
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => err.push(d));
    proc.on('error', e => reject(e));
    proc.on('close', exitCode => {
      const respBody = Buffer.concat(out).toString('utf8').trim();
      const errMsg   = Buffer.concat(err).toString('utf8').trim();
      console.log(`[install] PushEtaHen response (exit ${exitCode}): ${respBody || errMsg}`);
      if (respBody.includes('SUCCESS:'))               { resolve({ ok: true,  taskId: null }); return; }
      if (respBody.includes('0x80990085'))             { reject(new Error('Not enough free space on PS4/PS5')); return; }
      if (exitCode === 0 || exitCode === 52 || (!respBody && !errMsg)) { resolve({ ok: true, taskId: null }); return; }
      if (respBody && !respBody.toLowerCase().startsWith('curl:')) { reject(new Error(`etaHEN error: ${respBody}`)); return; }
      reject(new Error(errMsg || `etaHEN curl exit ${exitCode}`));
    });
  });
}

// ── IPC: remote install ───────────────────────────────────────────────────────
// remote-install: returns immediately with { ok: true, started: true }
// All progress + completion communicated via install-progress events.
// This prevents the renderer from blocking on a 5-minute invoke.
ipcMain.handle('remote-install', (event, items, ps4Ip, ps4Port, serverPort, installDelay) => {
  _runRemoteInstall(event.sender, items, ps4Ip, ps4Port, serverPort, installDelay).catch(e => {
    event.sender.send('install-progress', { type: 'install-file-error', file: '', error: e.message });
    event.sender.send('install-progress', { type: 'install-done', ok: 0, failed: 1, skipped: 0 });
  });
  return { ok: true, started: true };
});

async function _runRemoteInstall(sender, items, ps4Ip, ps4Port, serverPort, installDelay) {
  ps4Port    = parseInt(ps4Port)    || 12800;
  serverPort = parseInt(serverPort) || 9898;  // DPI default port

  if (!ps4Ip?.trim()) return { ok: false, error: 'No PS4/PS5 IP address specified.' };
  ps4Ip = ps4Ip.trim();

  const localItems = items.filter(i => !i.isFtp);
  const ftpItems   = items.filter(i =>  i.isFtp);

  if (ftpItems.length) {
    sender.send('install-progress', { type: 'install-warn',
      message: `${ftpItems.length} FTP-sourced PKG(s) skipped — remote install requires local files.` });
  }
  if (!localItems.length) return { ok: false, error: 'No local PKGs selected.' };

  // Pre-check: can we reach the PS4 installer?
  sender.send('install-progress', { type: 'install-connecting', ps4Ip, ps4Port });
  const reachable = await tcpProbe(ps4Ip, ps4Port, 5000);
  if (!reachable) {
    const errMsg = `Cannot reach ${ps4Ip}:${ps4Port}.\n\nChecklist:\n` +
      `• Remote PKG Installer / etaHEN is running on PS4/PS5\n` +
      `• The app is IN FOCUS (not minimised)\n` +
      `• PS4/PS5 and PC are on the same network\n` +
      `• No firewall blocking port ${ps4Port}`;
    sender.send('install-progress', { type: 'install-ps4-unreachable', message: errMsg });
    return { ok: false, error: errMsg };
  }
  sender.send('install-progress', { type: 'install-ps4-ok', ps4Ip, ps4Port });

  // Detect installer type before starting server (saves time)
  const installerType = await detectInstallerType(ps4Ip, ps4Port);
  sender.send('install-progress', { type: 'install-warn',
    message: `📡 Installer: ${installerType === 'etahen' ? 'etaHEN' : 'RPI (flatz)'}` });

  // Start file server
  const localIp = getLocalIp();
  try {
    await startPkgServer(serverPort, localItems);
  } catch (e) {
    const msg = e.code === 'EADDRINUSE'
      ? `Port ${serverPort} already in use — try a different server port`
      : `Failed to start file server: ${e.message}`;
    return { ok: false, error: msg };
  }

  sender.send('install-progress', { type: 'install-server-ready', localIp, serverPort, total: localItems.length });
  console.log(`[install] File server: http://${localIp}:${serverPort}/file/?b64=...`);

  const results = { ok: 0, failed: 0, skipped: ftpItems.length };

  try {
    for (let i = 0; i < localItems.length; i++) {
      const item = localItems[i];

      // Inter-item delay: give the PS4 time to begin installing before sending next command
      if (i > 0) {
        const delayMs = (installDelay != null ? installDelay : 8000);
        if (delayMs > 0) {
          sender.send('install-progress', { type: 'install-task-progress', file: item.fileName,
            taskId: null, percent: null, status: `Waiting ${delayMs/1000}s before next install…` });
          await new Promise(r => setTimeout(r, delayMs));
        }
      }

      // Build URL in DPI format: http://PCIP:PORT/file/?b64=BASE64(localFilePath)
      const b64    = item._b64key || Buffer.from(item.filePath).toString('base64url');
      const pkgUrl = `http://${localIp}:${serverPort}/file/?b64=${b64}`;

      sender.send('install-progress', {
        type: 'install-file-start', file: item.fileName,
        title: item.title, current: i + 1, total: localItems.length, pkgUrl,
      });

      try {
        console.log(`[install] → ${item.fileName}`);
        console.log(`[install]   URL: ${pkgUrl}`);

        // Push to PS4/PS5 using the detected installer type
        let taskId = null;
        const pushResult = installerType === 'etahen'
          ? await pushEtaHen(ps4Ip, ps4Port, pkgUrl)
          : await pushRPI(ps4Ip, ps4Port, pkgUrl);
        taskId = pushResult.taskId;

        sender.send('install-progress', {
          type: 'install-file-queued', file: item.fileName, taskId, pkgUrl,
        });
        sender.send('install-progress', {
          type: 'install-task-progress', file: item.fileName, taskId,
          percent: null, status: 'Command sent — waiting for PS4/PS5 to connect…',
        });

        // Wire progress from pkg-server (already aggregated + speed calculated server-side)
        let _lastProgressSend = 0;
        pkgServerProgressCb = (ev) => {
          const now = Date.now();
          if (now - _lastProgressSend < 250 && ev.pct !== 100) return; // throttle to 4fps
          _lastProgressSend = now;
          sender.send('install-progress', {
            type: 'install-xfer-progress',
            file:       item.fileName,
            title:      item.title || item.sfoTitle || item.fileName,
            bytesSent:  ev.bytesSent,
            totalBytes: ev.totalBytes,
            speed:      ev.speed,
            pct:        ev.pct,
            eta:        ev.eta,
          });
        };

        // Wait for PS4 to hit our file server and complete the download
        const MAX_WAIT  = 300000; // 5 min
        const IDLE_BAIL = 60000;  // 60s idle after first hit
        const t0        = Date.now();
        let   confirmed = false;
        let   lastHit   = 0;

        while (Date.now() - t0 < MAX_WAIT) {
          await new Promise(r => setTimeout(r, 2000));

          if (pkgServerLastHit && pkgServerLastHit >= t0) {
            lastHit = pkgServerLastHit;
            if (!confirmed) {
              confirmed = true;
              console.log('[install] PS4/PS5 connected — downloading…');
            }
          }

          // Done: no active connections + 5s since last activity
          if (confirmed && pkgServerActiveConns === 0 && Date.now() - lastHit > 5000) {
            console.log('[install] Download complete');
            sender.send('install-progress', {
              type: 'install-task-progress', file: item.fileName, taskId,
              percent: 100, status: 'Download complete — installing on PS4/PS5…',
            });
            break;
          }
          // Idle bail
          if (confirmed && Date.now() - lastHit > IDLE_BAIL) {
            console.log('[install] Download idle 60s — assuming complete');
            break;
          }

          // Poll RPI task progress
          if (taskId !== null) {
            try {
              const r = await dpiHttpPost(ps4Ip, ps4Port, '/api/get_task_progress',
                JSON.stringify({ task_id: taskId }), 8000);
              if (!r.emptyReply && r.body) {
                const d = JSON.parse(r.body);
                const pct = d.length_size > 0
                  ? Math.round(d.transferred_size / d.length_size * 100) : null;
                sender.send('install-progress', {
                  type: 'install-task-progress', file: item.fileName, taskId,
                  transferred: d.transferred_size, percent: pct,
                  rest: d.rest_sec, status: d.status || null,
                });
                if (d.status === 'SUCCESS') { confirmed = true; break; }
                if (d.error_code && d.error_code !== 0) break;
              }
            } catch (_) {}
          }
        }

        pkgServerProgressCb = null; // stop progress events for this item

        if (!confirmed) {
          throw new Error(
            `PS4/PS5 did not connect to the file server at http://${localIp}:${serverPort}/\n\n` +
            `Test: open http://${localIp}:${serverPort}/file/?b64=dGVzdA== in the PS4 browser.\n` +
            `If it doesn't load, the PS4 cannot reach this PC on port ${serverPort}.\n\n` +
            `Run PS4 Vault as Administrator to auto-configure Windows Firewall.`
          );
        }

        results.ok++;
        sender.send('install-progress', { type: 'install-file-done', file: item.fileName });

      } catch (e) {
        console.error('[install] failed:', item.fileName, e.message);
        results.failed++;
        sender.send('install-progress', {
          type: 'install-file-error', file: item.fileName, error: e.message,
        });
      }
    }
  } finally {
    // Keep server alive 5 min — PS4 may still be transferring
    setTimeout(() => {
      stopPkgServer();
      console.log('[pkg-server] stopped');
      // Restore firewall — async so it never blocks anything
      if (process.platform === 'win32') {
        const { exec } = require('child_process');
        exec(`powershell -NoProfile -NonInteractive -Command "Set-NetFirewallProfile -Profile Domain,Private,Public -DefaultInboundAction Block"`,
          { windowsHide: true, timeout: 8000 },
          (err) => { if (!err) console.log('[install] Firewall DefaultInboundAction restored'); }
        );
      }
    }, 300000);
  }

  sender.send('install-progress', { type: 'install-done', ...results });
}

// ── IPC: stop file server ─────────────────────────────────────────────────────
ipcMain.handle('stop-pkg-server', async () => { await stopPkgServer(); });

// ── IPC: scan installed games on console via FTP ──────────────────────────────
// Reads param.sfo + icon0.png directly from /user/app/CUSAXXXXX/ on the console.
// No PKG archive parsing — direct filesystem read → much faster than PKG scanning.
// Works for both PS4 (CUSA#####) and PS5 (PPSA#####) jailbreaks.
ipcMain.handle('ftp-scan-installed', async (event, cfg) => {
  const sender = event.sender;
  sender.send('scan-progress', { type: 'scan-start' });
  let client;
  try {
    client = await makeFtpClient(cfg);

    // Possible base paths for installed games on PS4/PS5
    let appBase = '/user/app';
    for (const base of ['/user/app', '/system_data/priv/appmeta']) {
      try { await client.cd(base); appBase = base; break; } catch { /* try next */ }
    }

    sender.send('scan-progress', { type: 'scan-discovering' });
    let appDirs = [];
    try {
      await client.cd(appBase);
      const listing = await client.list();
      // Skip PPSA (PS5 native titles) — include all other PS4 formats
      appDirs = listing.filter(e => e.isDirectory &&
        /^(CUSA|PUSA|PLAS|BLES|BCUS|NPEB|NPUB)\d{5}/i.test(e.name) &&
        !/^PPSA/i.test(e.name));
    } catch (e) {
      sender.send('scan-progress', { type: 'scan-error', message: `Cannot list ${appBase}: ${e.message}` });
      return [];
    }

    sender.send('scan-progress', { type: 'scan-found', total: appDirs.length });
    const items = [];
    let done = 0;

    // Helper: sum all file sizes under a remote directory (recursive, up to maxDepth).
    // Uses a dedicated FTP client so it doesn't disrupt other transfers.
    async function ftpDirSize(remotePath, maxDepth = 4) {
      const sizeClient = await makeFtpClient(cfg);
      let total = 0;
      async function walk(p, depth) {
        if (depth > maxDepth) return;
        try {
          const entries = await sizeClient.list(p);
          for (const e of entries) {
            const full = (p === '/' ? '' : p) + '/' + e.name;
            if (e.isDirectory) await walk(full, depth + 1);
            else total += (e.size || 0);
          }
        } catch (_) {}
      }
      try { await walk(remotePath, 0); } finally { try { sizeClient.close(); } catch (_) {} }
      return total;
    }

    // Helper: download a remote file into a Buffer using a fresh FTP connection.
    // Using a fresh client per file avoids the state-corruption that occurs when
    // a previous download fails or is interrupted (e.g. file-not-found aborts
    // the data channel, leaving the shared client in a broken state).
    async function ftpDownloadBuf(remotePath, maxBytes) {
      const dlClient = await makeFtpClient(cfg);
      try {
        const chunks = [];
        let   received = 0;
        const { Writable } = require('stream');
        const w = new Writable({
          write(chunk, _e, cb) {
            // Buffer up to maxBytes but do NOT destroy — stream.destroy() aborts
            // the FTP data channel and corrupts the client for subsequent calls.
            if (received < maxBytes) {
              chunks.push(chunk.slice(0, Math.min(chunk.length, maxBytes - received)));
            }
            received += chunk.length;
            cb();
          }
        });
        await dlClient.downloadTo(w, remotePath);
        return Buffer.concat(chunks);
      } finally {
        try { dlClient.close(); } catch (_) {}
      }
    }

    for (const dir of appDirs) {
      const _done = done; // capture before async gap
      sender.send('scan-progress', { type: 'scan-parsing', file: dir.name, done: _done, total: appDirs.length });
      try {
        const titleId = dir.name.replace(/[^A-Z0-9]/gi, '').substring(0, 9);
        // Known PS4/PS5 jailbreak FTP path layouts for param.sfo:
        //  GoldHEN/etaHEN: /user/app/CUSAXXXXX/sce_sys/param.sfo
        //  Some CFW:       /user/app/CUSAXXXXX/app/sce_sys/param.sfo
        //  PS5 via FTP:    /system_data/priv/appmeta/CUSAXXXXX/param.sfo
        //  Alt mount:      /mnt/sandbox/CUSAXXXXX_000/sce_sys/param.sfo
        const SFO_PATHS = [
          `${appBase}/${dir.name}/sce_sys/param.sfo`,
          `${appBase}/${dir.name}/app/sce_sys/param.sfo`,
          `/system_data/priv/appmeta/${dir.name}/param.sfo`,
          `/mnt/sandbox/${dir.name}_000/sce_sys/param.sfo`,
          `${appBase}/${dir.name}/param.sfo`,
        ];
        const ICON_PATHS = [
          `${appBase}/${dir.name}/sce_sys/icon0.png`,
          `${appBase}/${dir.name}/app/sce_sys/icon0.png`,
          `/mnt/sandbox/${dir.name}_000/sce_sys/icon0.png`,
          `/system_data/priv/appmeta/${dir.name}/icon0.png`,
          `${appBase}/${dir.name}/sce_sys/icon0.dds`,
        ];

        // ── Smart SFO + icon discovery ─────────────────────────────────────
        // Try to LIST sce_sys/ inside the app dir to find param.sfo dynamically.
        // This handles all known PS4/PS5 FTP mount layouts automatically.
        // Falls back to the static path list if listing is not permitted.
        let sfoData = {};
        let iconDataUrl = null;
        const MAX_ICON = 512 * 1024;

        // Try each candidate base and dynamically verify param.sfo exists
        const tryDownloadSfo = async (p) => {
          const buf = await ftpDownloadBuf(p, 256 * 1024);
          if (buf.length < 20) throw new Error('too short');
          const parsed = parseSfo(buf);
          if (!parsed.TITLE && !parsed.TITLE_ID && !parsed.APP_VER && !parsed.CATEGORY)
            throw new Error('empty parse');
          return parsed;
        };

        // Build candidate dirs to search for sce_sys/
        const candidateDirs = [
          `${appBase}/${dir.name}`,
          `${appBase}/${dir.name}/app`,
          `/mnt/sandbox/${dir.name}_000`,
          `/system_data/priv/appmeta/${dir.name}`,
        ];

        let foundSceDir = null;
        for (const cDir of candidateDirs) {
          // Try direct param.sfo first (fastest)
          for (const sfName of ['sce_sys/param.sfo', 'param.sfo']) {
            try {
              const parsed = await tryDownloadSfo(`${cDir}/${sfName}`);
              console.log(`[installed-scan] ${dir.name} SFO="${parsed.TITLE}" via ${cDir}/${sfName}`);
              sfoData = parsed;
              foundSceDir = cDir;
              break;
            } catch (_) {}
          }
          if (foundSceDir) break;
        }
        if (!sfoData.TITLE && !sfoData.TITLE_ID) {
          console.warn(`[installed-scan] No SFO found for ${dir.name} — tried ${candidateDirs.length} paths`);
        }

        // Icon candidates — the icon lives ALONGSIDE param.sfo in the same dir,
        // NOT in a sce_sys/ subdirectory when under appmeta.
        // Icon is ALWAYS in the game's app dir (/user/app/CUSAXXXXX/sce_sys/icon0.png)
        // regardless of where param.sfo was found.
        // appmeta has SFO but NO icon. Game dir has both.
        const iconCandidates = [
          `${appBase}/${dir.name}/sce_sys/icon0.png`,          // standard — try first always
          `${appBase}/${dir.name}/app/sce_sys/icon0.png`,      // subdir variant
          `/mnt/sandbox/${dir.name}_000/sce_sys/icon0.png`,    // sandbox mount
          ...(foundSceDir && foundSceDir !== `${appBase}/${dir.name}` ? [
            `${foundSceDir}/sce_sys/icon0.png`,
            `${foundSceDir}/icon0.png`,
          ] : []),
          `${appBase}/${dir.name}/sce_sys/icon0.dds`,          // DDS fallback
          `/system_data/priv/appmeta/${dir.name}/icon0.png`,   // appmeta (unlikely but try)
        ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

        // Known PS4/PS5 icon paths (ordered by likelihood):
        // /user/appmeta/CUSAXXXXX/icon0.png  ← primary user-space appmeta
        // /system_data/priv/appmeta/CUSAXXXXX/icon0.png ← system appmeta (same dir as SFO)
        // /user/app/CUSAXXXXX/sce_sys/icon0.png ← game data dir
        const iconCandidates2 = [
          `/user/appmeta/${dir.name}/icon0.png`,
          ...(foundSceDir ? [
            `${foundSceDir}/icon0.png`,
            `${foundSceDir}/sce_sys/icon0.png`,
          ] : []),
          `/system_data/priv/appmeta/${dir.name}/icon0.png`,
          `${appBase}/${dir.name}/sce_sys/icon0.png`,
          `${appBase}/${dir.name}/sce_sys/icon0.dds`,
          `${appBase}/${dir.name}/app/sce_sys/icon0.png`,
          `/mnt/sandbox/${dir.name}_000/sce_sys/icon0.png`,
        ].filter((v, i, a) => a.indexOf(v) === i);

        for (const iconPath of iconCandidates2) {
          try {
            const buf = await ftpDownloadBuf(iconPath, MAX_ICON);
            if (buf.length > 8) {
              const isPng  = buf[0] === 0x89 && buf[1] === 0x50;
              const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
              if (isPng || isJpeg) {
                iconDataUrl = `data:image/${isPng ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`;
                console.log(`[installed-scan] ${dir.name} icon OK via ${iconPath}`);
                break;
              } else {
                console.warn(`[installed-scan] ${dir.name} icon bad magic at ${iconPath} (${buf[0].toString(16)} ${buf[1].toString(16)})`);
              }
            }
          } catch (e) {
            console.warn(`[installed-scan] ${dir.name} icon miss: ${iconPath} — ${e.message}`);
          }
        }
        if (!iconDataUrl) console.warn(`[installed-scan] ${dir.name} NO ICON in any of ${iconCandidates2.length} paths`);

        // Multi-language title fallback chain
        const sfoTitle = sfoData.TITLE    || sfoData.TITLE_00 || sfoData.TITLE_01 ||
                         sfoData.TITLE_02 || sfoData.TITLE_03 || '';
        const resolvedId = sfoData.TITLE_ID || titleId;
        const appVer   = sfoData.APP_VER  || '';
        const sysVer   = sfoData.SYSTEM_VER != null ? fwFromInt(sfoData.SYSTEM_VER) : '';
        // category: GD = full game, GP = patch, AC = DLC etc.
        const category = sfoData.CATEGORY || 'GD';
        const contentId = `${appBase}/${dir.name}`;

        // Region from content ID prefix (UP=USA, EP=EUR, JP=JPN, HP=ASIA)
        // NOT from title ID (CUSA/PPSA has no region info in the prefix)
        const regionFromContent = sfoData.CONTENT_ID
          ? sfoData.CONTENT_ID.substring(0, 2)
          : '';
        // Fallback: map well-known title-id prefixes to regions
        const regionFromTitle = resolvedId.startsWith('CUSA') ? 'UP'
                              : resolvedId.startsWith('PUSA') ? 'EP'
                              : resolvedId.startsWith('PPSA') ? 'UP'
                              : '';
        const region = regionFromContent || regionFromTitle;

        const item = {
          filePath:    contentId,
          fileName:    dir.name,
          dirPath:     appBase,
          fileSize:    0, // will be updated by background dir-size fetch
          contentId:   sfoData.CONTENT_ID || contentId,
          titleId:     resolvedId,
          title:       sfoTitle || resolvedId || dir.name,
          sfoTitle,
          fnTitle:     null,
          category,
          appVer,
          sysVer,
          region,
          pkgType:     0,
          iconDataUrl,
          isDuplicate: false,
          isFtp:       true,
          isInstalled: true,
          ftpCfg:      cfg,
        };
        items.push(item);
        sender.send('scan-progress', { type: 'scan-result', item });

        // Background: calculate directory size (non-blocking — updates item when done)
        ftpDirSize(`${appBase}/${dir.name}`).then(sz => {
          if (sz > 0) {
            item.fileSize = sz;
            sender.send('scan-progress', { type: 'scan-result-update', filePath: item.filePath, fileSize: sz });
            console.log(`[installed-scan] ${dir.name} size=${(sz/1e9).toFixed(2)} GB`);
          }
        }).catch(() => {});

      } catch (e) {
        console.warn('[installed-scan] skip', dir.name, e.message);
      }
      done++;
    }

    sender.send('scan-progress', { type: 'scan-done', total: items.length });
    return items;
  } catch (e) {
    console.error('[installed-scan] error:', e);
    sender.send('scan-progress', { type: 'scan-error', message: `Installed games scan failed: ${e.message}` });
    return [];
  } finally {
    try { client?.close(); } catch (_) {}
  }
});

// ── IPC: PS4/PS5 auto-discovery ──────────────────────────────────────────────
// Detects both PS4 and PS5 jailbreaks on the local subnet.
// PS4: FTP on 2121, Remote PKG Installer on 12800
// PS5: FTP on 2121, Remote PKG Installer on 12800, PS5-specific REST on 9090
ipcMain.handle('discover-ps4', async (event, customSubnet) => {
  const sender = event.sender;
  const localIp = getLocalIp();
  const parts   = localIp.split('.');
  if (!customSubnet && parts.length !== 4) return { found: [], error: 'Cannot determine local subnet' };

  // customSubnet: e.g. "192.168.0" — overrides auto-detect
  const subnet = customSubnet?.trim() || parts.slice(0, 3).join('.');
  const PROBE_PORTS  = [2121, 9090, 1337, 12800, 21];
  const CONFIRM_PORT = 12800;
  const TIMEOUT_MS   = 600;
  const net = require('net');

  sender.send('discover-ps4-progress', { type: 'start', subnet, total: 254 });

  function probePort(ip, port) {
    return new Promise(resolve => {
      const sock = new net.Socket();
      let done = false;
      const finish = (open) => { if (done) return; done = true; sock.destroy(); resolve(open); };
      sock.setTimeout(TIMEOUT_MS);
      sock.on('connect',  () => finish(true));
      sock.on('timeout',  () => finish(false));
      sock.on('error',    () => finish(false));
      sock.connect(port, ip);
    });
  }

  const found = [];
  const BATCH = 32;
  for (let start = 1; start <= 254; start += BATCH) {
    const batch = [];
    for (let h = start; h < start + BATCH && h <= 254; h++) batch.push(h);
    await Promise.all(batch.map(async h => {
      const ip = subnet + '.' + h;
      if (ip === localIp) return;
      for (const port of PROBE_PORTS) {
        const open = await probePort(ip, port);
        if (open) {
          const installerOpen = port === CONFIRM_PORT ? true : await probePort(ip, CONFIRM_PORT);
          const ps5RestOpen   = await probePort(ip, 9090);
          const ftpOpen2121   = port === 2121         ? true : await probePort(ip, 2121);
          const ftpOpen21     = !ftpOpen2121 ? await probePort(ip, 21) : false;
          const ftpPort       = ftpOpen2121 ? 2121 : (ftpOpen21 ? 21 : null);
          // PS5 jailbreaks typically expose port 9090 (bdj REST); PS4 doesn't
          const consoleType   = ps5RestOpen ? 'PS5' : 'PS4';
          const entry = { ip, port, installerOpen, ftpPort, consoleType };
          found.push(entry);
          sender.send('discover-ps4-progress', { type: 'found', ip, port, installerOpen, ftpPort, consoleType });
          break;
        }
      }
    }));
    sender.send('discover-ps4-progress', {
      type: 'batch-done', scanned: Math.min(start + BATCH - 1, 254), total: 254,
    });
  }

  sender.send('discover-ps4-progress', { type: 'done', found });
  return { found };
});

