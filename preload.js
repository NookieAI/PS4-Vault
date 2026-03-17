const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pkgApi', {
  // ── Navigation ──────────────────────────────────────────────────────────────
  openDirectory:       ()                               => ipcRenderer.invoke('open-directory'),
  showInFolder:        (p)                              => ipcRenderer.invoke('show-in-folder', p),
  openExternal:        (url)                            => ipcRenderer.invoke('open-external', url),
  copyToClipboard:     (text)                           => ipcRenderer.invoke('clipboard-write', text),
  getAllDrives:         ()                               => ipcRenderer.invoke('get-all-drives'),
  getLogoDataUrl:      ()                               => ipcRenderer.invoke('get-logo-data-url'),

  // ── Network helpers ─────────────────────────────────────────────────────────
  getLocalIp:          ()                               => ipcRenderer.invoke('get-local-ip'),
  getLogPath:          ()                               => ipcRenderer.invoke('get-log-path'),
  openLog:             ()                               => ipcRenderer.invoke('open-log'),
  openLogFolder:       ()                               => ipcRenderer.invoke('open-log-folder'),

  // ── Library persistence ────────────────────────────────────────────────────
  saveLibrary:         (items)                          => ipcRenderer.invoke('save-library', items),
  refetchCovers:       (filePaths)                      => ipcRenderer.invoke('refetch-covers', filePaths),
  onCoverReady:        (cb)                             => ipcRenderer.on('cover-ready', (_e, d) => cb(d)),
  offCoverReady:       ()                               => ipcRenderer.removeAllListeners('cover-ready'),
  loadLibrary:         ()                               => ipcRenderer.invoke('load-library'),
  clearLibrary:        ()                               => ipcRenderer.invoke('clear-library'),

  // ── Settings ───────────────────────────────────────────────────────────────
  setSetting:          (key, val)                       => ipcRenderer.invoke('set-setting', key, val),

  // ── PKG integrity ──────────────────────────────────────────────────────────
  verifyPkg:           (filePath)                       => ipcRenderer.invoke('verify-pkg', filePath),

  // ── Speed test ─────────────────────────────────────────────────────────────
  speedTestPs4:        (ip, port, srvPort)              => ipcRenderer.invoke('speed-test-ps4', ip, port, srvPort),

  // ── Auto-updater ──────────────────────────────────────────────────────────
  checkForUpdatesManual:      ()      => ipcRenderer.invoke('check-for-updates-manual'),
  downloadAndInstallUpdate:   (url)   => ipcRenderer.invoke('download-and-install-update', url),
  onUpdateAvailable:          (cb)    => ipcRenderer.on('update-available',         (_, d) => cb(d)),
  onUpdateDownloadProgress:   (cb)    => ipcRenderer.on('update-download-progress', (_, d) => cb(d)),
  onAppVersion:               (cb)    => ipcRenderer.on('app-version',              (_, v) => cb(v)),

  // ── Console discovery ──────────────────────────────────────────────────────
  discoverPs4:         (subnet)                         => ipcRenderer.invoke('discover-ps4', subnet),
  testPs4Conn:         (ip, port)                       => ipcRenderer.invoke('test-ps4-conn', ip, port),

  // ── Local scan ──────────────────────────────────────────────────────────────
  scanPkgs:            (sourceDir, scanDepth)           => ipcRenderer.invoke('scan-pkgs', sourceDir, scanDepth),
  cancelOperation:     ()                               => ipcRenderer.invoke('cancel-operation'),

  // ── FTP ─────────────────────────────────────────────────────────────────────
  ftpScanPkgs:         (cfg)                            => ipcRenderer.invoke('ftp-scan-pkgs', cfg),
  ftpTestConn:         (cfg)                            => ipcRenderer.invoke('ftp-test-conn', cfg),
  ftpScanInstalled:    (cfg)                            => ipcRenderer.invoke('ftp-scan-installed', cfg),

  // ── File ops ─────────────────────────────────────────────────────────────────
  deletePkgs:          (items)                          => ipcRenderer.invoke('delete-pkgs', items),
  renamePkg:           (item, newName)                  => ipcRenderer.invoke('rename-pkg', item, newName),
  checkPkgConflicts:   (items, dest, layout, fmt)       => ipcRenderer.invoke('check-pkg-conflicts', items, dest, layout, fmt),
  goPkgs:              (items, dest, act, lay, fmt, ftpDest, conflictModes) => ipcRenderer.invoke('go-pkgs', items, dest, act, lay, fmt, ftpDest, conflictModes),

  // ── Remote install ───────────────────────────────────────────────────────────
  remoteInstall:       (items, ps4Ip, ps4Port, srvPort, installDelay) => ipcRenderer.invoke('remote-install', items, ps4Ip, ps4Port, srvPort, installDelay),

  // ── Progress event streams ───────────────────────────────────────────────────
  onScanProgress:      cb  => ipcRenderer.on('scan-progress',           (_e, d) => cb(d)),
  offScanProgress:     ()  => ipcRenderer.removeAllListeners('scan-progress'),
  onGoProgress:        cb  => ipcRenderer.on('go-progress',             (_e, d) => cb(d)),
  offGoProgress:       ()  => ipcRenderer.removeAllListeners('go-progress'),
  onInstallProgress:   cb  => ipcRenderer.on('install-progress',        (_e, d) => cb(d)),
  offInstallProgress:  ()  => ipcRenderer.removeAllListeners('install-progress'),
  onDiscoverProgress:  cb  => ipcRenderer.on('discover-ps4-progress',   (_e, d) => cb(d)),
  offDiscoverProgress: ()  => ipcRenderer.removeAllListeners('discover-ps4-progress'),
});
