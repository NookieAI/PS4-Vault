const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pkgApi', {
  // ── Navigation ──────────────────────────────────────────────────────────────
  openDirectory:       ()                               => ipcRenderer.invoke('open-directory'),
  showInFolder:        (p)                              => ipcRenderer.invoke('show-in-folder', p),
  openExternal:        (url)                            => ipcRenderer.invoke('open-external', url),
  copyToClipboard:     (text)                           => ipcRenderer.invoke('clipboard-write', text),
  getAllDrives:         ()                               => ipcRenderer.invoke('get-all-drives'),

  // ── Network helpers ─────────────────────────────────────────────────────────
  getLocalIp:          ()                               => ipcRenderer.invoke('get-local-ip'),
  discoverPs4:         ()                               => ipcRenderer.invoke('discover-ps4'),
  testPs4Conn:         (ip, port)                        => ipcRenderer.invoke('test-ps4-conn', ip, port),

  // ── Local scan ──────────────────────────────────────────────────────────────
  scanPkgs:            (sourceDir)                      => ipcRenderer.invoke('scan-pkgs', sourceDir),
  cancelOperation:     ()                               => ipcRenderer.invoke('cancel-operation'),

  // ── FTP ─────────────────────────────────────────────────────────────────────
  ftpScanPkgs:         (cfg)                            => ipcRenderer.invoke('ftp-scan-pkgs', cfg),
  ftpTestConn:         (cfg)                            => ipcRenderer.invoke('ftp-test-conn', cfg),

  // ── File ops ─────────────────────────────────────────────────────────────────
  deletePkgs:          (items)                          => ipcRenderer.invoke('delete-pkgs', items),
  renamePkg:           (item, newName)                  => ipcRenderer.invoke('rename-pkg', item, newName),
  checkPkgConflicts:   (items, dest, layout, fmt)       => ipcRenderer.invoke('check-pkg-conflicts', items, dest, layout, fmt),
  goPkgs:              (items, dest, act, lay, fmt, ftpDest) => ipcRenderer.invoke('go-pkgs', items, dest, act, lay, fmt, ftpDest),

  // ── Remote install ───────────────────────────────────────────────────────────
  remoteInstall:       (items, ps4Ip, ps4Port, srvPort) => ipcRenderer.invoke('remote-install', items, ps4Ip, ps4Port, srvPort),
  stopPkgServer:       ()                               => ipcRenderer.invoke('stop-pkg-server'),

  // ── Progress event streams ───────────────────────────────────────────────────
  onScanProgress:      cb  => ipcRenderer.on('scan-progress',       (_e, d) => cb(d)),
  offScanProgress:     ()  => ipcRenderer.removeAllListeners('scan-progress'),
  onGoProgress:        cb  => ipcRenderer.on('go-progress',         (_e, d) => cb(d)),
  offGoProgress:       ()  => ipcRenderer.removeAllListeners('go-progress'),
  onInstallProgress:   cb  => ipcRenderer.on('install-progress',    (_e, d) => cb(d)),
  offInstallProgress:  ()  => ipcRenderer.removeAllListeners('install-progress'),
  onDiscoverProgress:  cb  => ipcRenderer.on('discover-ps4-progress', (_e, d) => cb(d)),
  offDiscoverProgress: ()  => ipcRenderer.removeAllListeners('discover-ps4-progress'),
});
