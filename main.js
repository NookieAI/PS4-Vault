const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const http   = require('http');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

const VERSION        = '1.1.0';
const SCAN_CONCURR   = 16;           // parallel PKG parse tasks
const MAX_SCAN_DEPTH = 10;
const ICON_MAX_BYTES = 800 * 1024;   // 800 KB cap on extracted icon
// 64 KB covers PS4 PKG header (0x400) + full entry table (typ. 50–200 entries × 32 B = ~6 KB).
// SFO and icon data are read separately via fd.read() at their absolute offsets — no need
// to slurp MB of file data upfront.
const READ_BUF_SIZE  = 64 * 1024;

const activeCancelFlags = new Map();

// ── Process-level error guards ─────────────────────────────────────────────────
process.on('uncaughtException',  e => console.error('[main] Uncaught:', e));
process.on('unhandledRejection', e => console.error('[main] Unhandled rejection:', e));

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;
function createWindow() {
  // Remove the native menu bar entirely (File / Edit / View / Help)
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width:  1380,
    height: 860,
    show:   false,              // hidden until ready-to-show → no resize flash
    resizable: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      nodeIntegration:  false,
      contextIsolation: true,
      devTools:         false,  // hard-disable DevTools in production
    },
  });

  // Maximize before showing → no visible resize animation
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

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
      if (sfoOff < fileSize) {
        sfoTryOffsets.push(sfoOff);                                // 1st: absolute (correct per spec)
      }
      if (bodyOff64 > 0 && bodyOff64 + sfoOff < fileSize) {
        sfoTryOffsets.push(bodyOff64 + sfoOff);                    // 2nd: body-relative (rare fallback)
      }

      for (const tryOff of sfoTryOffsets) {
        if (tryOff + sfoSz > fileSize) continue;
        const sfoBuf = Buffer.alloc(sfoSz);
        const { bytesRead: sfoRead } = await fd.read(sfoBuf, 0, sfoSz, tryOff);
        if (sfoRead < 20) continue;
        const parsed = parseSfo(sfoBuf);
        if (parsed.TITLE || parsed.CATEGORY || parsed.APP_VER || parsed.TITLE_ID) {
          sfoData = parsed;
          break;
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

    // ── Read icon — absolute offset first (confirmed by all reference impls) ─
    let iconDataUrl = null;
    const iconReadSz = Math.min(iconSz, ICON_MAX_BYTES);
    if (iconOff > 0 && iconReadSz > 256) {
      const offsets = [];
      if (iconOff < fileSize) offsets.push(iconOff);                          // 1st: absolute
      if (bodyOff64 > 0 && bodyOff64 + iconOff < fileSize) offsets.push(bodyOff64 + iconOff); // 2nd: body-rel fallback
      for (const tryOff of offsets) {
        if (tryOff + 8 > fileSize) continue;
        const readSize = Math.min(iconReadSz, fileSize - tryOff);
        const iconBuf = Buffer.alloc(readSize);
        const { bytesRead: iconBytes } = await fd.read(iconBuf, 0, readSize, tryOff);
        if (iconBytes < 8) continue;
        const isPng  = iconBuf[0] === 0x89 && iconBuf[1] === 0x50 && iconBuf[2] === 0x4E && iconBuf[3] === 0x47;
        const isJpeg = iconBuf[0] === 0xFF && iconBuf[1] === 0xD8;
        if (isPng)  { iconDataUrl = `data:image/png;base64,${iconBuf.slice(0, iconBytes).toString('base64')}`; break; }
        if (isJpeg) { iconDataUrl = `data:image/jpeg;base64,${iconBuf.slice(0, iconBytes).toString('base64')}`; break; }
      }
    }
    // Fallback icon scan: ONLY run if entry table had no icon entry (iconOff === 0).
    // Scanning 4 MB per PKG × 16 workers is the main cause of slow scans.
    if (!iconDataUrl && iconOff === 0) {
      const scanSz = Math.min(1024 * 1024, fileSize); // 1 MB fallback scan
      const scanBuf = Buffer.alloc(scanSz);
      const { bytesRead: scanRead } = await fd.read(scanBuf, 0, scanSz, 0);
      iconDataUrl = scanBufferForIcon(scanBuf.slice(0, scanRead));
    }

    // ── Resolve final fields ──────────────────────────────────────────────────
    const sfoTitle = sfoData.TITLE || sfoData.TITLE_00 || sfoData.TITLE_01 ||
                     sfoData.TITLE_02 || sfoData.TITLE_03 || '';
    const category = sfoData.CATEGORY || '';
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
        }
      } catch { /* skip individual entry errors */ }
    }
  }

  await walk(dir, 0);
  return results;
}

async function scanPkgs(sourceDir, sender) {
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
    const pkgFiles = await findPkgFiles(sourceDir, controller.signal);
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
        try {
          const item = await parsePkgFile(fp);
          items.push(item);
          sender.send('scan-progress', { type: 'scan-result', item });
        } catch (e) {
          console.warn('[scan] skip', path.basename(fp), e.message);
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
    } else if (item.name.toLowerCase().endsWith('.pkg') && item.size > 0) {
      results.push({ remotePath: full, size: item.size });
    }
  }
  return results;
}

// Download first FTP_HDR_SIZE bytes of a remote PKG for header parsing.
// Must be large enough to capture the SFO and icon which follow the entry table.
// 512 KB covers all standard PS4 PKGs. READ_BUF_SIZE (64 KB) is only for local files
// where we can seek; FTP must read contiguously from the start.
const FTP_HDR_SIZE = 512 * 1024;

async function ftpReadPkgHeader(client, remotePath) {
  // Download the first FTP_HDR_SIZE bytes of a remote PKG.
  // We use a Writable that destroys itself once we've collected enough bytes —
  // basic-ftp will throw an error when the socket closes early, which we catch
  // as long as we already received some data.
  const chunks = [];
  let total = 0;
  const { Writable } = require('stream');
  const writable = new Writable({
    write(chunk, _enc, cb) {
      const remaining = FTP_HDR_SIZE - total;
      if (remaining <= 0) { cb(); return; }
      const slice = chunk.slice(0, Math.min(chunk.length, remaining));
      chunks.push(slice);
      total += slice.length;
      cb();
      // Destroy the stream once we have enough — this aborts the transfer cleanly
      if (total >= FTP_HDR_SIZE) this.destroy();
    }
  });
  try {
    await client.downloadTo(writable, remotePath);
  } catch (e) {
    // Ignore "premature close" / ECONNRESET — expected when we destroy mid-transfer
    const msg = (e.message || '').toLowerCase();
    const expected = msg.includes('premature') || msg.includes('reset') ||
                     msg.includes('aborted') || msg.includes('destroyed');
    if (!chunks.length && !expected) throw e;
  }
  if (!chunks.length) throw new Error('FTP: no data received for ' + remotePath);
  return Buffer.concat(chunks);
}

// FTP scanner — mirrors scanPkgs but reads via FTP
async function scanPkgsFtp(cfg, sender) {
  const controller = new AbortController();
  activeCancelFlags.set(sender.id, () => controller.abort());
  sender.send('scan-progress', { type: 'scan-start' });

  let client;
  try {
    client = await makeFtpClient(cfg);
    sender.send('scan-progress', { type: 'scan-discovering' });
    const pkgList = await ftpFindPkgs(client, cfg.path || '/', controller.signal);
    sender.send('scan-progress', { type: 'scan-found', total: pkgList.length });

    if (!pkgList.length) {
      sender.send('scan-progress', { type: 'scan-done', total: 0 });
      return [];
    }

    const items = [];
    let done = 0;

    for (const { remotePath, size } of pkgList) {
      if (controller.signal.aborted) break;
      const fname = remotePath.split('/').pop();
      sender.send('scan-progress', { type: 'scan-parsing', file: fname, done, total: pkgList.length });
      try {
        // Need fresh client per download to avoid state issues after partial reads
        const hdrClient = await makeFtpClient(cfg);
        let headerBuf;
        try { headerBuf = await ftpReadPkgHeader(hdrClient, remotePath); }
        finally { try { hdrClient.close(); } catch (_) {} }

        if (headerBuf.readUInt32BE(0) !== PKG_MAGIC) throw new Error('not a PKG');

        // Parse PKG header from the downloaded buffer.
        // FTP mode: we only have headerBuf (up to READ_BUF_SIZE bytes).
        // The entry table and SFO/icon MUST be within this window.
        // READ_BUF_SIZE is 64KB which covers header + table + SFO/icon for all standard PKGs.
        // For very large PKGs where SFO is beyond 64KB, the magic-scan fallback handles it.
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
        if (!iconDataUrl) iconDataUrl = scanBufferForIcon(headerBuf);

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
        console.warn('[ftp-scan] skip', fname, e.message);
      }
      done++;
      sender.send('scan-progress', { type: 'scan-parsing', file: fname, done, total: pkgList.length });
    }

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
    try { client?.close(); } catch (_) {}
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
    rs.on('data', chunk => {
      if (cancelCheck?.()) { rs.destroy(); ws.destroy(); reject(new Error('Cancelled')); return; }
      copied += chunk.length;
      progressCallback?.({ bytesCopied: copied, totalBytes: total });
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
  if (c === 'theme') return 'Theme';
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

ipcMain.handle('scan-pkgs', async (event, sourceDir) => {
  return scanPkgs(sourceDir, event.sender);
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
ipcMain.handle('go-pkgs', async (event, items, destDir, action, layout, renameFormat, ftpDest) => {
  const sender     = event.sender;
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

      sender.send('go-progress', { type: 'go-file-start', file: item.fileName, current: i+1, total, destPath });

      try {
        if (isFtpSrc && !ftpDest) {
          // FTP → Local
          let client;
          try {
            client = await makeFtpClient(item.ftpCfg);
            await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
            client.trackProgress(info => {
              sender.send('go-progress', { type: 'go-file-progress', bytesCopied: info.bytes, totalBytes: item.fileSize });
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
            sender.send('go-progress', { type: 'go-file-progress', bytesCopied: info.bytes, totalBytes: item.fileSize });
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
              sender.send('go-progress', { type: 'go-file-progress', bytesCopied: info.bytes, totalBytes: item.fileSize });
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
            sender.send('go-progress', { type: 'go-file-progress', bytesCopied, totalBytes, file: item.fileName, current: i+1, total });
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
});


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

// ── PKG HTTP file server ──────────────────────────────────────────────────────
let pkgServer     = null;
let pkgServerPort = 0;
let pkgFileMap    = new Map(); // filename (encoded) → absolute local path

async function startPkgServer(port, items) {
  await stopPkgServer();
  pkgFileMap = new Map();
  for (const item of items) {
    if (!item.filePath || item.isFtp) continue;
    pkgFileMap.set(encodeURIComponent(item.fileName), item.filePath);
    pkgFileMap.set(item.fileName, item.filePath); // also store raw name
  }

  return new Promise((resolve, reject) => {
    pkgServer = http.createServer(async (req, res) => {
      // Strip leading slash and query string
      const rawName = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]);
      const fpath   = pkgFileMap.get(rawName) || pkgFileMap.get(encodeURIComponent(rawName));
      if (!fpath) {
        console.warn('[pkg-server] 404:', rawName);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      try {
        const stat  = await fs.promises.stat(fpath);
        const total = stat.size;
        const range = req.headers['range'];

        if (range) {
          // Byte-range support — PS4 may request partial content
          const m = range.match(/bytes=(\d+)-(\d*)/);
          if (!m) { res.writeHead(416); res.end(); return; }
          const start = parseInt(m[1], 10);
          const end   = m[2] ? parseInt(m[2], 10) : total - 1;
          if (start > end || end >= total) { res.writeHead(416); res.end(); return; }
          res.writeHead(206, {
            'Content-Type':   'application/octet-stream',
            'Content-Range':  `bytes ${start}-${end}/${total}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges':  'bytes',
          });
          fs.createReadStream(fpath, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Type':   'application/octet-stream',
            'Content-Length': String(total),
            'Accept-Ranges':  'bytes',
          });
          fs.createReadStream(fpath).pipe(res);
        }
      } catch (e) {
        console.error('[pkg-server] error serving', rawName, e.message);
        try { res.writeHead(500); res.end(); } catch (_) {}
      }
    });

    pkgServer.on('error', err => {
      pkgServer = null;
      reject(err);
    });
    pkgServer.listen(port, '0.0.0.0', () => {
      pkgServerPort = port;
      const uniqueFiles = new Set(pkgFileMap.values()).size;
      console.log(`[pkg-server] listening on 0.0.0.0:${port}, serving ${uniqueFiles} file(s)`);
      resolve();
    });
  });
}

function stopPkgServer() {
  return new Promise(resolve => {
    if (!pkgServer) { resolve(); return; }
    const s = pkgServer;
    pkgServer = null;
    s.close(() => resolve());
    // Force-close any lingering connections
    try { s.closeAllConnections?.(); } catch (_) {}
  });
}


// ── Reliable HTTP POST helper using Node's built-in http module ───────────────
// Replaces global fetch() which has unreliable timeout/error handling in some
// Electron builds and requires AbortSignal.timeout (Node 17.3+).
function httpPost(hostname, port, urlPath, bodyObj, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req  = http.request({
      hostname,
      port,
      path:   urlPath,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connection':     'close',
      },
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end',  () => resolve({ status: res.statusCode, body: raw }));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(
        `Timed out after ${timeoutMs/1000}s connecting to ${hostname}:${port} — ` +
        `is Remote PKG Installer running and IN FOCUS on PS4?`
      ));
    });

    req.on('error', err => {
      let msg = err.message;
      if (err.code === 'ECONNREFUSED')
        msg = `Connection refused at ${hostname}:${port} — PS4 not reachable or installer not running`;
      else if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH')
        msg = `Host unreachable: ${hostname} — check PS4 is on the same network`;
      else if (err.code === 'ENOTFOUND')
        msg = `Cannot resolve ${hostname} — enter a numeric IP address`;
      reject(new Error(msg));
    });

    req.write(body);
    req.end();
  });
}

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

// ── Poll install task progress ────────────────────────────────────────────────
async function pollTaskProgress(ps4Ip, ps4Port, taskId, fileName, sender) {
  const MAX_POLLS = 240, INTERVAL = 3000;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, INTERVAL));
    try {
      const { status, body } = await httpPost(ps4Ip, ps4Port,
        '/api/get_task_progress', { task_id: taskId }, 10000);
      if (status !== 200) break;
      const d = JSON.parse(body);
      sender.send('install-progress', {
        type:        'install-task-progress',
        file:        fileName, taskId,
        transferred: d.transferred_size,
        length:      d.length_size,
        percent:     d.length_size > 0 ? Math.round(d.transferred_size / d.length_size * 100) : null,
        rest:        d.rest_sec,
        status:      d.status     || null,
        errorCode:   d.error_code || null,
      });
      if (d.status === 'SUCCESS') break;
      if (d.error_code && d.error_code !== 0) break;
      if (d.length_size > 0 && d.transferred_size >= d.length_size) break;
    } catch (e) {
      console.warn('[install] poll error for task', taskId, e.message);
      break;
    }
  }
}

// ── IPC: get local IP ─────────────────────────────────────────────────────────
ipcMain.handle('get-local-ip', () => getLocalIp());

// ── IPC: test PS4 installer reachability ─────────────────────────────────────
ipcMain.handle('test-ps4-conn', async (_e, ps4Ip, ps4Port) => {
  ps4Port = parseInt(ps4Port) || 12800;
  if (!ps4Ip) return { ok: false, error: 'No IP provided' };
  const open = await tcpProbe(ps4Ip.trim(), ps4Port, 5000);
  if (!open) return {
    ok: false,
    error: `Port ${ps4Port} not reachable on ${ps4Ip} — launch Remote PKG Installer and keep it IN FOCUS on PS4`,
  };
  try {
    const { status } = await httpPost(ps4Ip.trim(), ps4Port, '/api/is_exists',
      { title_id: 'CUSA00000' }, 5000);
    return { ok: true, status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── IPC: remote install ───────────────────────────────────────────────────────
ipcMain.handle('remote-install', async (event, items, ps4Ip, ps4Port, serverPort) => {
  const sender = event.sender;
  ps4Port    = parseInt(ps4Port)    || 12800;
  serverPort = parseInt(serverPort) || 8090;

  if (!ps4Ip || !ps4Ip.trim()) return { ok: false, error: 'No PS4 IP address specified.' };
  ps4Ip = ps4Ip.trim();

  const localItems = items.filter(i => !i.isFtp);
  const ftpItems   = items.filter(i =>  i.isFtp);

  if (ftpItems.length) {
    sender.send('install-progress', {
      type: 'install-warn',
      message: `${ftpItems.length} FTP-sourced PKG${ftpItems.length > 1 ? 's' : ''} skipped — remote install requires locally stored files.`,
    });
  }
  if (!localItems.length) return { ok: false, error: 'No local PKGs selected.' };

  // ── Pre-check: can we reach the PS4 installer? ───────────────────────────
  sender.send('install-progress', { type: 'install-connecting', ps4Ip, ps4Port });
  const reachable = await tcpProbe(ps4Ip, ps4Port, 5000);
  if (!reachable) {
    const errMsg =
      `Cannot reach ${ps4Ip}:${ps4Port}.\n\n` +
      `Checklist:\n` +
      `• Remote PKG Installer is running on PS4\n` +
      `• The PS4 app is IN FOCUS (not minimised/suspended)\n` +
      `• PS4 and PC are on the same network\n` +
      `• No firewall blocking port ${ps4Port}`;
    sender.send('install-progress', { type: 'install-ps4-unreachable', message: errMsg });
    return { ok: false, error: errMsg };
  }
  sender.send('install-progress', { type: 'install-ps4-ok', ps4Ip, ps4Port });

  // ── Start file server ─────────────────────────────────────────────────────
  const localIp = getLocalIp();
  try {
    await startPkgServer(serverPort, localItems);
  } catch (e) {
    const msg = e.code === 'EADDRINUSE'
      ? `Port ${serverPort} already in use — choose a different server port`
      : `Failed to start file server: ${e.message}`;
    return { ok: false, error: msg };
  }

  sender.send('install-progress', { type: 'install-server-ready', localIp, serverPort, total: localItems.length });

  const results = { ok: 0, failed: 0, skipped: ftpItems.length };

  try {
    for (let i = 0; i < localItems.length; i++) {
      const item   = localItems[i];
      const pkgUrl = `http://${localIp}:${serverPort}/${encodeURIComponent(item.fileName)}`;

      sender.send('install-progress', {
        type: 'install-file-start', file: item.fileName,
        title: item.title, current: i + 1, total: localItems.length, pkgUrl,
      });

      try {
        console.log(`[install] → PS4 ${ps4Ip}:${ps4Port} url=${pkgUrl}`);
        const { status, body } = await httpPost(
          ps4Ip, ps4Port, '/api/install',
          { type: 'direct', packages: [pkgUrl] },
          20000
        );
        console.log(`[install] PS4 response ${status}: ${body}`);

        if (status !== 200) throw new Error(`PS4 returned HTTP ${status}: ${body}`);

        let taskId = null;
        try { taskId = JSON.parse(body).task_id ?? null; } catch (_) {}

        sender.send('install-progress', { type: 'install-file-queued', file: item.fileName, taskId, pkgUrl });

        if (taskId !== null) {
          await pollTaskProgress(ps4Ip, ps4Port, taskId, item.fileName, sender);
        } else {
          sender.send('install-progress', {
            type: 'install-task-progress', file: item.fileName,
            taskId: null, percent: null, status: 'queued — PS4 is downloading',
          });
        }

        results.ok++;
        sender.send('install-progress', { type: 'install-file-done', file: item.fileName });

      } catch (e) {
        console.error('[install] failed:', item.fileName, e.message);
        results.failed++;
        sender.send('install-progress', { type: 'install-file-error', file: item.fileName, error: e.message });
      }
    }
  } finally {
    // Keep server alive 90 s — PS4 starts its download after the command
    setTimeout(() => { stopPkgServer(); console.log('[pkg-server] stopped'); }, 90000);
  }

  sender.send('install-progress', { type: 'install-done', ...results });
  return { ok: true, ...results };
});

// ── IPC: stop file server ─────────────────────────────────────────────────────
ipcMain.handle('stop-pkg-server', async () => { await stopPkgServer(); });

// ── PS4 auto-discovery ────────────────────────────────────────────────────────
// Scans the local /24 subnet for a host responding on the remote installer ports.
// Check order: 2121, 1337, then 12800 (actual installer port).
// We try 2121/1337 as "ping" ports (PS4 debug ports) to quickly find PS4 IPs,
// then confirm with 12800.
ipcMain.handle('discover-ps4', async (event) => {
  const sender = event.sender;
  const localIp = getLocalIp();
  const parts   = localIp.split('.');
  if (parts.length !== 4) return { found: [], error: 'Cannot determine local subnet' };

  const subnet  = parts.slice(0, 3).join('.');
  const PROBE_PORTS  = [2121, 1337, 12800];
  const CONFIRM_PORT = 12800;
  const TIMEOUT_MS   = 600;
  const net = require('net');

  sender.send('discover-ps4-progress', { type: 'start', subnet, total: 254 });

  function probePort(ip, port) {
    return new Promise(resolve => {
      const sock = new net.Socket();
      let done = false;
      const finish = (open) => {
        if (done) return;
        done = true;
        sock.destroy();
        resolve(open);
      };
      sock.setTimeout(TIMEOUT_MS);
      sock.on('connect',  () => finish(true));
      sock.on('timeout',  () => finish(false));
      sock.on('error',    () => finish(false));
      sock.connect(port, ip);
    });
  }

  const found = [];
  // Probe in batches of 32 to avoid overwhelming the network stack
  const BATCH = 32;
  for (let start = 1; start <= 254; start += BATCH) {
    const batch = [];
    for (let h = start; h < start + BATCH && h <= 254; h++) {
      batch.push(h);
    }
    await Promise.all(batch.map(async h => {
      const ip = subnet + '.' + h;
      if (ip === localIp) return; // skip self
      // Try each probe port — first open one wins
      for (const port of PROBE_PORTS) {
        const open = await probePort(ip, port);
        if (open) {
          const entry = { ip, port };
          // If found on a non-installer port, also confirm 12800 is reachable
          if (port !== CONFIRM_PORT) {
            entry.installerOpen = await probePort(ip, CONFIRM_PORT);
          } else {
            entry.installerOpen = true;
          }
          found.push(entry);
          sender.send('discover-ps4-progress', { type: 'found', ip, port, installerOpen: entry.installerOpen });
          break;
        }
      }
    }));
    sender.send('discover-ps4-progress', {
      type: 'batch-done',
      scanned: Math.min(start + BATCH - 1, 254),
      total: 254,
    });
  }

  sender.send('discover-ps4-progress', { type: 'done', found });
  return { found };
});

