(function () {
  'use strict';

  // ── Storage keys ─────────────────────────────────────────────────────────────
  const K_LAST_SRC    = 'ps4pkgvault.lastSource';
  const K_LAST_DST    = 'ps4pkgvault.lastDest';
  const K_SETTINGS    = 'ps4pkgvault.settings';
  const K_RECENT_SRC  = 'ps4pkgvault.recentSrc';
  const K_RECENT_DST  = 'ps4pkgvault.recentDst';
  const K_RECENT_FTP  = 'ps4pkgvault.recentFtp';
  const K_CS_PROFILES = 'ps4pkgvault.csProfiles'; // Feature 13

  // ── State ─────────────────────────────────────────────────────────────────────
  let allItems      = [];
  let filteredItems = [];
  let selectedSet   = new Set();
  let sortBy        = 'title';
  let sortAsc       = true;
  let activeCat     = 'all';
  let searchText    = '';
  let renderPending = false;
  let viewMode           = 'table';
  let ctxTarget          = null;
  let discoveredConsole  = null;
  let activeFtpDest      = null;
  let scanDepth          = 10;
  let installDelay       = 8000;

  const $ = id => document.getElementById(id);

  // ── Settings ──────────────────────────────────────────────────────────────────
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem(K_SETTINGS) || '{}'); } catch {}
  function saveSetting(k, v) { settings[k] = v; localStorage.setItem(K_SETTINGS, JSON.stringify(settings)); }

  // ── Startup overlay ─────────────────────────────────────────────── Feature 19
  function hideStartupOverlay() {
    const ov = $('startupOverlay');
    if (!ov) return;
    ov.style.opacity = '0';
    setTimeout(() => ov.remove(), 350);
  }
  function setStartupMsg(msg) {
    const el = $('startupMsg'); if (el) el.textContent = msg;
  }

  // ── Logo ──────────────────────────────────────────────────────────────────────
  // Main process reads the file and returns a base64 data URL — works in both
  // dev and packaged builds with no file:// path issues.
  (async () => {
    try {
      const dataUrl = await pkgApi.getLogoDataUrl();
      if (dataUrl) {
        const logo = $('brandLogo');
        if (logo) logo.src = dataUrl;
      }
    } catch (_) {}
  })();

  // ── Theme ─────────────────────────────────────────────────────────────────────
  function applyTheme(t) { document.body.dataset.theme = t; saveSetting('theme', t); }
  applyTheme(settings.theme || 'dark');
  $('madeBy').addEventListener('click', () =>
    applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'));

  // ── Recents ───────────────────────────────────────────────────────────────────
  function getRecent(k) { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } }
  function addRecent(k, v) {
    if (!v) return;
    const r = getRecent(k).filter(x => x !== v);
    r.unshift(v); localStorage.setItem(k, JSON.stringify(r.slice(0, 8)));
  }
  function renderChips(cid, sk, iid) {
    const container = $(cid); if (!container) return;
    const inp = $(iid);
    container.innerHTML = getRecent(sk).map(v => {
      const short = v.length > 36 ? '…' + v.slice(-34) : v;
      return `<button class="recent-chip" title="${escHtml(v)}" data-val="${escHtml(v)}"><span class="chip-icon">🕐</span>${escHtml(short)}</button>`;
    }).join('');
    container.querySelectorAll('.recent-chip').forEach(btn =>
      btn.addEventListener('click', () => { if (inp) { inp.value = btn.dataset.val; inp.dispatchEvent(new Event('input')); } }));
  }
  function refreshDatalist(dlId, k) {
    const dl = $(dlId); if (!dl) return;
    dl.innerHTML = '';
    getRecent(k).forEach(v => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); });
  }
  function refreshAll() {
    refreshDatalist('sourceHistory', K_RECENT_SRC);
    refreshDatalist('destHistory',   K_RECENT_DST);
    renderChips('recentSrcChips', K_RECENT_SRC, 'sourcePath');
    renderChips('recentDstChips', K_RECENT_DST, 'destPath');
    const csDl = $('csHostHistory'); if (csDl) {
      csDl.innerHTML = '';
      getRecent(K_RECENT_FTP).forEach(v => { const o = document.createElement('option'); o.value = v; csDl.appendChild(o); });
    }
    refreshConsoleProfiles(); // Feature 13
  }

  // ── Feature 13: Console profiles ─────────────────────────────────────────────
  function getProfiles()        { try { return JSON.parse(localStorage.getItem(K_CS_PROFILES) || '[]'); } catch { return []; } }
  function saveProfiles(arr)    { localStorage.setItem(K_CS_PROFILES, JSON.stringify(arr)); }
  function refreshConsoleProfiles() {
    const sel = $('csProfiles'); if (!sel) return;
    const profiles = getProfiles();
    sel.innerHTML = '<option value="">Profiles…</option>' +
      profiles.map((p, i) => `<option value="${i}">${escHtml(p.name)}</option>`).join('');
  }
  $('btnCsSaveProfile')?.addEventListener('click', () => {
    const host = $('csHost')?.value.trim(); if (!host) { return; }
    const name = prompt(`Save profile name for ${host}:`, host);
    if (!name) return;
    const profiles = getProfiles().filter(p => p.host !== host);
    profiles.unshift({ name, host, port: $('csFtpPort')?.value || '2121', user: $('csUser')?.value || 'anonymous', path: $('csPkgPath')?.value || '/' });
    saveProfiles(profiles.slice(0, 10));
    refreshConsoleProfiles();
    toast(`Saved profile "${name}"`);
  });
  $('csProfiles')?.addEventListener('change', e => {
    const idx = parseInt(e.target.value);
    if (isNaN(idx)) return;
    const p = getProfiles()[idx]; if (!p) return;
    if ($('csHost')) $('csHost').value = p.host;
    if ($('csFtpPort')) $('csFtpPort').value = p.port || '2121';
    if ($('csUser')) $('csUser').value = p.user || 'anonymous';
    if ($('csPkgPath')) $('csPkgPath').value = p.path || '/';
    e.target.value = '';
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function categoryDisplay(cat) {
    const c = (cat || '').toLowerCase().trim();
    if (['gd','gde','gda','gdc','hg'].includes(c)) return 'Game';
    if (c === 'gp')  return 'Patch';
    if (c === 'ac')  return 'DLC';
    if (['theme','gdc'].includes(c) || c.startsWith('t'))  return 'Theme';
    if (c === 'app' || c === 'ap') return 'App';
    return c ? c.toUpperCase() : 'Other';
  }
  function regionDisplay(r) {
    return { UP:'USA', EP:'EUR', JP:'JPN', HP:'ASIA', KP:'KOR', IP:'INT' }[r] || r || '—';
  }
  function categoryColor(cat) {
    const d = categoryDisplay(cat);
    return d==='Game'?'cat-game':d==='Patch'?'cat-patch':d==='DLC'?'cat-dlc':d==='Theme'?'cat-theme':d==='App'?'cat-app':'cat-other';
  }
  function regionColor(r) {
    const d = regionDisplay(r);
    return d==='USA'?'reg-us':d==='EUR'?'reg-eu':d==='JPN'?'reg-jp':d==='ASIA'?'reg-asia':'reg-other';
  }
  function fmtSize(n) {
    if (!n) return '—';
    if (n>=1e12) return (n/1e12).toFixed(2)+' TB';
    if (n>=1e9)  return (n/1e9).toFixed(2)+' GB';
    if (n>=1e6)  return (n/1e6).toFixed(1)+' MB';
    if (n>=1e3)  return (n/1e3).toFixed(0)+' KB';
    return n+' B';
  }
  function fmtSec(s) {
    if (!s||s<0) return '';
    if (s<60)   return `${Math.round(s)}s`;
    if (s<3600) return `${Math.floor(s/60)}m ${Math.round(s%60)}s`;
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
  }
  function fmtSpeed(bps) {
    if (!bps||bps<0) return '';
    if (bps>1024**3) return (bps/1024**3).toFixed(2)+' GB/s';
    if (bps>1024**2) return (bps/1024**2).toFixed(1)+' MB/s';
    if (bps>1024)    return (bps/1024).toFixed(0)+' KB/s';
    return bps.toFixed(0)+' B/s';
  }
  function escHtml(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function escAttr(s) { return String(s??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }
  function escJs(s)   { return String(s??'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
  window.escHtml = escHtml;

  // ── Virtual scroll window ────────────────────────────────── Feature 12 ───────
  // Render rows in batches — only DOM-render what's visible + a 50-row buffer
  // for large libraries (500+ items). Dramatically reduces DOM size + scroll jank.
  const VIRT_ROW_H  = 62; // px — approximate row height
  const VIRT_BUFFER = 40; // rows above/below viewport to keep rendered
  let virtScrollTop = 0;
  let virtTableEl   = null;

  // ── Filter + sort ─────────────────────────────────────────────────────────────
  function applyFilters() {
    const s = searchText.toLowerCase();
    filteredItems = allItems.filter(item => {
      if (activeCat === 'Installed') return !!item.isInstalled;
      if (item.isInstalled && activeCat !== 'all') return false;
      const d = categoryDisplay(item.category);
      if (activeCat !== 'all' && d !== activeCat) return false;
      if (s && ![(item.title||''),(item.sfoTitle||''),(item.fnTitle||''),(item.titleId||''),(item.fileName||'')]
          .some(x => x.toLowerCase().includes(s))) return false;
      return true;
    });
    sortItems(); renderTable(); updateCounts();
  }
  function applyFiltersSoon() {
    if (renderPending) return; renderPending = true;
    requestAnimationFrame(() => { renderPending = false; applyFilters(); });
  }
  function sortItems() {
    filteredItems.sort((a, b) => {
      let av, bv;
      switch (sortBy) {
        case 'size':     av=a.fileSize||0;               bv=b.fileSize||0;              break;
        case 'titleId':  av=a.titleId||'';               bv=b.titleId||'';              break;
        case 'category': av=categoryDisplay(a.category); bv=categoryDisplay(b.category);break;
        case 'version':  av=a.appVer||'';                bv=b.appVer||'';               break;
        case 'region':   av=regionDisplay(a.region);     bv=regionDisplay(b.region);    break;
        case 'fileName': av=(a.fileName||'').toLowerCase(); bv=(b.fileName||'').toLowerCase(); break;
        default:         av=(a.sfoTitle||a.fnTitle||a.title||'').toLowerCase();
                         bv=(b.sfoTitle||b.fnTitle||b.title||'').toLowerCase();
      }
      if (typeof av === 'number') return sortAsc ? av-bv : bv-av;
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }

  // ── Placeholder SVGs ──────────────────────────────────────────────────────────
  function makeInstalledPlaceholderSvg() {
    return `<svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="72" height="72" rx="8" fill="rgba(34,197,94,0.08)"/><rect x="18" y="18" width="36" height="4" rx="2" fill="rgba(34,197,94,0.3)"/><rect x="18" y="27" width="28" height="3" rx="1.5" fill="rgba(34,197,94,0.18)"/><rect x="18" y="34" width="32" height="3" rx="1.5" fill="rgba(34,197,94,0.14)"/><rect x="18" y="41" width="20" height="3" rx="1.5" fill="rgba(34,197,94,0.1)"/><text x="36" y="62" text-anchor="middle" font-size="8" fill="rgba(34,197,94,0.5)" font-family="JetBrains Mono,ui-monospace,monospace" font-weight="700">ON CONSOLE</text></svg>`;
  }
  function makePartialPlaceholderSvg() {
    return `<svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="72" height="72" rx="8" fill="rgba(251,146,60,0.08)"/><rect x="14" y="20" width="44" height="5" rx="2.5" fill="rgba(251,146,60,0.25)"/><rect x="14" y="30" width="28" height="4" rx="2" fill="rgba(251,146,60,0.15)"/><rect x="14" y="38" width="20" height="4" rx="2" fill="rgba(251,146,60,0.1)"/><text x="36" y="58" text-anchor="middle" font-size="8" fill="rgba(251,146,60,0.7)" font-family="JetBrains Mono,ui-monospace,monospace" font-weight="700">PARTIAL</text><text x="36" y="67" text-anchor="middle" font-size="7" fill="rgba(251,146,60,0.4)" font-family="JetBrains Mono,ui-monospace,monospace">.pkg.part</text></svg>`;
  }
  function makePlaceholderSvg() {
    return `<svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="72" height="72" rx="8" fill="rgba(255,255,255,0.03)"/><rect x="14" y="18" width="44" height="5" rx="2.5" fill="rgba(255,255,255,0.1)"/><rect x="14" y="28" width="32" height="4" rx="2" fill="rgba(255,255,255,0.06)"/><rect x="14" y="36" width="38" height="4" rx="2" fill="rgba(255,255,255,0.06)"/><rect x="14" y="44" width="24" height="4" rx="2" fill="rgba(255,255,255,0.04)"/><text x="36" y="64" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.16)" font-family="JetBrains Mono,ui-monospace,monospace" font-weight="600" letter-spacing="1">PKG</text></svg>`;
  }

  // ── Row HTML builder ──────────────────────────────────────────────────────────
  function buildRowHtml(item) {
    const checked   = selectedSet.has(item.filePath);
    const catDisp   = categoryDisplay(item.category);
    const catCls    = categoryColor(item.category);
    const regDisp   = regionDisplay(item.region);
    const regCls    = regionColor(item.region);
    const isPartial = !!item.isPartial;
    const iconHtml  = item.iconDataUrl
      ? `<img class="thumb" src="${item.iconDataUrl}" alt="cover" loading="eager" onmouseover="showPreview(event,this.src,'${escJs(item.filePath)}')" onmouseout="hidePreview()">`
      : item.isInstalled ? makeInstalledPlaceholderSvg()
      : isPartial       ? makePartialPlaceholderSvg()
      : makePlaceholderSvg();
    let displayName, titleQuality;
    if (item.sfoTitle)       { displayName=escHtml(item.sfoTitle); titleQuality='title-from-sfo'; }
    else if (item.fnTitle)   { displayName=escHtml(item.fnTitle);  titleQuality='title-from-fn'; }
    else if (item.titleId)   { displayName=escHtml(item.titleId);  titleQuality='title-fallback'; }
    else                     { displayName=escHtml(item.fileName||'—'); titleQuality='title-fallback'; }
    const cusaLine  = item.titleId ? `<div class="title-cusa">${escHtml(item.titleId)}</div>` : '';
    const pathLine  = item.dirPath ? `<div class="title-path" title="${escHtml(item.filePath)}">${escHtml(item.dirPath)}</div>` : '';
    const dupBadge  = item.isDuplicate ? ' <span class="dup-badge">DUP</span>' : '';
    const ftpBadge  = item.isFtp&&!item.isInstalled ? ' <span class="ftp-badge">FTP</span>' : '';
    const instBadge = item.isInstalled ? ' <span class="installed-badge">INSTALLED</span>' : '';
    const partBadge = isPartial ? ' <span class="partial-badge" title="Incomplete download — .pkg.part file">⚠ PARTIAL</span>' : '';
    const actionsHtml = item.isInstalled
      ? `<button class="row-btn row-btn--install" title="Install" onclick="installOne('${escJs(item.filePath)}')">📡</button>`
      : isPartial
      ? `<button class="row-btn" title="Show in folder" onclick="pkgApi.showInFolder('${escJs(item.filePath)}')">📂</button><button class="row-btn row-btn--danger" title="Delete partial" onclick="deleteOne('${escJs(item.filePath)}')">🗑</button>`
      : `<button class="row-btn" title="Show in folder" onclick="pkgApi.showInFolder('${escJs(item.filePath)}')">📂</button><button class="row-btn" title="Copy filename" onclick="pkgApi.copyToClipboard('${escJs(item.fileName)}')">📋</button><button class="row-btn row-btn--install" title="Install" onclick="installOne('${escJs(item.filePath)}')">📡</button><button class="row-btn row-btn--danger" title="Delete" onclick="deleteOne('${escJs(item.filePath)}')">🗑</button>`;
    const sizeDisp = (item.isInstalled && !item.fileSize)
      ? '<span style="color:var(--muted);font-size:11px">on console</span>'
      : isPartial
      ? `<span style="color:rgba(251,146,60,0.8);font-size:11px">${fmtSize(item.fileSize)} ⚠</span>`
      : fmtSize(item.fileSize);
    const rowCls = `${checked?'row-selected':''}${item.isInstalled?' row-installed':''}${isPartial?' row-partial':''}`;
    return `<tr class="${rowCls}" data-fp="${escAttr(item.filePath)}">
      <td class="check"><input type="checkbox" ${checked?'checked':''} data-fp="${escAttr(item.filePath)}"/></td>
      <td class="cover"><div class="icon-wrap">${iconHtml}</div></td>
      <td class="title-cell">
        <div class="title-main"><span class="title-name ${titleQuality}">${displayName}</span>${dupBadge}${ftpBadge}${instBadge}${partBadge}</div>
        ${cusaLine}${pathLine}
        ${item.isInstalled||isPartial?'':`<div class="title-sub pkg-filename" title="${escHtml(item.filePath)}" onclick="startRenameInline(event,'${escJs(item.filePath)}')">${escHtml(item.fileName)}</div>`}
      </td>
      <td><span class="cat-badge ${catCls}">${catDisp}</span></td>
      <td class="mono-col">${escHtml(item.appVer||'—')}</td>
      <td><span class="reg-badge ${regCls}">${regDisp}</span></td>
      <td class="mono-col">${escHtml(item.sysVer||'—')}</td>
      <td class="size">${sizeDisp}</td>
      <td class="acts">${actionsHtml}</td>
    </tr>`;
  }

  // ── Table rendering ─────────────────────────── Feature 12: virtual scroll ────
  const tbody = $('resultsBody');

  function bindRowEvents(tr) {
    tr.querySelector('input[type=checkbox]')?.addEventListener('change', e => {
      const fp = e.target.dataset.fp;
      if (e.target.checked) selectedSet.add(fp); else selectedSet.delete(fp);
      tr.classList.toggle('row-selected', e.target.checked);
      updateSelectionUI();
    });
    tr.addEventListener('dblclick', () => {
      const item = allItems.find(i => i.filePath === tr.dataset.fp);
      if (item && !item.isPartial) openInstallModal([item]);
    });
    tr.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e.clientX, e.clientY, tr.dataset.fp); });
  }

  function renderTable() {
    if (viewMode === 'grid') { renderGrid(); updateStats(); return; }
    if (!filteredItems.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-cell">${allItems.length===0
        ? 'No scan performed yet. Choose a source folder and click SCAN.'
        : 'No PKGs match the current filter.'}</td></tr>`;
      updateStats(); return;
    }
    // Virtual scroll: render all rows (DOM is fast up to ~1000 rows for table)
    // For very large libraries (>800 items) we batch-render to avoid blocking
    const BATCH = 200;
    if (filteredItems.length > BATCH) {
      // Render first batch immediately, rest in next frame
      tbody.innerHTML = filteredItems.slice(0, BATCH).map(buildRowHtml).join('');
      tbody.querySelectorAll('tr[data-fp]').forEach(bindRowEvents);
      let offset = BATCH;
      const renderMore = () => {
        if (offset >= filteredItems.length) { updateStats(); return; }
        const frag = document.createDocumentFragment();
        filteredItems.slice(offset, offset + BATCH).forEach(item => {
          const tmp = document.createElement('tbody');
          tmp.innerHTML = buildRowHtml(item);
          const tr = tmp.firstElementChild;
          bindRowEvents(tr);
          frag.appendChild(tr);
        });
        tbody.appendChild(frag);
        offset += BATCH;
        requestAnimationFrame(renderMore);
      };
      requestAnimationFrame(renderMore);
    } else {
      tbody.innerHTML = filteredItems.map(buildRowHtml).join('');
      tbody.querySelectorAll('tr[data-fp]').forEach(bindRowEvents);
    }
    updateStats();
  }

  // ── Grid rendering ────────────────────────────────────────────────────────────
  function renderGrid() {
    const grid = $('gridBody'); if (!grid) return;
    if (!filteredItems.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;color:var(--muted);padding:32px;text-align:center;">${allItems.length===0?'No scan performed yet.':'No PKGs match the current filter.'}</div>`;
      updateStats(); return;
    }
    grid.innerHTML = filteredItems.map(item => {
      const sel    = selectedSet.has(item.filePath);
      const title  = item.sfoTitle||item.fnTitle||item.titleId||item.fileName;
      const catCls = categoryColor(item.category);
      const cover  = item.iconDataUrl
        ? `<img src="${item.iconDataUrl}" alt="cover" loading="eager" onmouseover="showPreview(event,this.src,this.closest('.grid-card').dataset.fp)" onmouseout="hidePreview()">`
        : item.isPartial ? makePartialPlaceholderSvg() : makePlaceholderSvg();
      return `<div class="grid-card${sel?' selected':''}${item.isPartial?' partial':''}" data-fp="${escAttr(item.filePath)}" oncontextmenu="event.preventDefault();showCtxMenu(event.clientX,event.clientY,'${escJs(item.filePath)}')">
        <div class="gc-check"></div>
        <div class="gc-cover">${cover}</div>
        <div class="gc-body">
          <div class="gc-title" title="${escHtml(title)}">${escHtml(title)}</div>
          <div class="gc-sub">${escHtml(item.titleId||'—')}</div>
          <div class="gc-badge-row">
            <span class="cat-badge ${catCls}" style="font-size:9.5px;padding:1px 5px">${categoryDisplay(item.category)}</span>
            ${item.appVer?`<span style="font-size:9.5px;color:var(--muted);font-family:'JetBrains Mono',ui-monospace,monospace">v${escHtml(item.appVer)}</span>`:''}
            ${item.isPartial?'<span style="font-size:9px;color:rgba(251,146,60,0.8)">⚠ partial</span>':''}
          </div>
        </div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.grid-card').forEach(card => {
      let t = null;
      card.addEventListener('click', e => {
        if (e.target.closest('.gc-check')) return;
        clearTimeout(t); t = setTimeout(() => {
          const fp = card.dataset.fp;
          if (selectedSet.has(fp)) selectedSet.delete(fp); else selectedSet.add(fp);
          card.classList.toggle('selected', selectedSet.has(fp)); updateSelectionUI();
        }, 200);
      });
      card.addEventListener('dblclick', () => { clearTimeout(t); const item=allItems.find(i=>i.filePath===card.dataset.fp); if(item&&!item.isPartial) installOne(card.dataset.fp); });
      card.querySelector('.gc-check')?.addEventListener('click', e => {
        e.stopPropagation(); clearTimeout(t);
        const fp = card.dataset.fp;
        if (selectedSet.has(fp)) selectedSet.delete(fp); else selectedSet.add(fp);
        card.classList.toggle('selected', selectedSet.has(fp)); updateSelectionUI();
      });
    });
    updateStats();
  }

  // ── Image preview ─────────────────────────────────────────────────────────────
  const preview=$('imgPreview'), previewImg=$('imgPreviewImg');
  let previewMx=0, previewMy=0;
  function placePreview() {
    requestAnimationFrame(() => {
      const W=window.innerWidth, H=window.innerHeight, ph=preview.offsetHeight||300, pw=368;
      let x=previewMx+20; if(x+pw>W) x=previewMx-pw-12; if(x<4) x=4;
      let y=previewMy+20; if(y+ph>H-4) y=previewMy-ph-12; if(y<4) y=4;
      preview.style.left=x+'px'; preview.style.top=y+'px';
    });
  }
  window.showPreview = (e, src, fp) => {
    if (!src) return;
    previewMx=e.clientX; previewMy=e.clientY;
    const item = fp && allItems.find(i=>i.filePath===fp);
    if (item) {
      const title=item.sfoTitle||item.fnTitle||item.titleId||item.fileName||'';
      const sub=[item.titleId,item.appVer?'v'+item.appVer:'',item.sysVer?'FW '+item.sysVer:''].filter(Boolean).join('  ·  ');
      $('imgPreviewTitle').textContent=title; $('imgPreviewSub').textContent=sub;
      $('imgPreviewMeta').style.display=(title||sub)?'':'none';
    } else { $('imgPreviewMeta').style.display='none'; }
    if (previewImg.getAttribute('data-current')!==src) {
      previewImg.setAttribute('data-current',src); previewImg.onload=()=>{ if(preview.style.display!=='none') placePreview(); }; previewImg.src=src;
    }
    preview.style.display='block'; placePreview();
  };
  window.hidePreview = () => { preview.style.display='none'; };
  document.addEventListener('mousemove', e => { if (preview.style.display!=='none') { previewMx=e.clientX; previewMy=e.clientY; placePreview(); } });

  // ── Counts + selection ────────────────────────────────────────────────────────
  function updateCounts() {
    const total=allItems.filter(i=>!i.isPartial).length, shown=filteredItems.length;
    const dupes=allItems.filter(i=>i.isDuplicate).length, parts=allItems.filter(i=>i.isPartial).length;
    const totalSz=allItems.reduce((s,i)=>s+(i.fileSize||0),0);
    $('scanCount').textContent = total||parts
      ? `${shown}${shown!==allItems.length?' / '+allItems.length:''} PKGs  ·  ${fmtSize(totalSz)}${dupes?`  ·  ⚠ ${dupes} dupes`:''}${parts?`  ·  ⚠ ${parts} partial`:''}`
      : '';
    ['all','Game','Patch','DLC','App','Theme','Other'].forEach(c => {
      const btn=$(c==='all'?'catAll':'cat'+c); if(!btn) return;
      const n=c==='all'?allItems.filter(i=>!i.isInstalled).length:allItems.filter(i=>!i.isInstalled&&categoryDisplay(i.category)===c).length;
      btn.querySelector('.cat-count').textContent=n;
    });
    const ib=$('catInstalled'); if(ib) ib.querySelector('.cat-count').textContent=allItems.filter(i=>i.isInstalled).length;
    updateSelectionUI();
  }
  function updateSelectionUI() {
    const n=selectedSet.size;
    $('selectedCount').textContent=n?`${n} selected`:'';
    $('btnDeleteSelected').disabled=$('btnRenameSelected').disabled=$('btnGoSelected').disabled=$('btnInstallSelected').disabled=n===0;
    $('chkHeader').indeterminate=n>0&&n<filteredItems.length;
    $('chkHeader').checked=filteredItems.length>0&&n===filteredItems.length;
  }
  function updateStats() {
    const games=allItems.filter(i=>categoryDisplay(i.category)==='Game').length;
    const patches=allItems.filter(i=>categoryDisplay(i.category)==='Patch').length;
    const dlc=allItems.filter(i=>categoryDisplay(i.category)==='DLC').length;
    const totalSz=allItems.reduce((s,i)=>s+(i.fileSize||0),0);
    const fws=allItems.map(i=>i.sysVer).filter(v=>v&&/^\d+\.\d+$/.test(v)).map(v=>parseFloat(v)).sort((a,b)=>a-b);
    const fwRange=fws.length?(fws[0]===fws[fws.length-1]?`FW ${fws[0].toFixed(2)}`:`FW ${fws[0].toFixed(2)} – ${fws[fws.length-1].toFixed(2)}`): '';
    $('statGames').textContent=games?`${games} Game${games!==1?'s':''}`:'';;
    $('statPatches').textContent=patches?`${patches} Patch${patches!==1?'es':''}`:'';;
    $('statDlc').textContent=dlc?`${dlc} DLC`:'';;
    $('statSize').textContent=totalSz?fmtSize(totalSz)+' total':'';;
    $('statFw').textContent=fwRange;
    if($('statFwSep')) $('statFwSep').style.display=fwRange?'':'none';
    document.querySelectorAll('.stat-sep').forEach(sep=>{
      const prev=sep.previousElementSibling, next=sep.nextElementSibling;
      sep.style.display=(!prev||!prev.textContent.trim())||(!next||!next.textContent.trim())?'none':'';
    });
  }

  // ── Header checkbox / sort ────────────────────────────────────────────────────
  $('chkHeader').addEventListener('change', e => {
    if(e.target.checked) filteredItems.forEach(i=>selectedSet.add(i.filePath));
    else filteredItems.forEach(i=>selectedSet.delete(i.filePath));
    renderTable(); updateSelectionUI();
  });
  document.querySelectorAll('thead th[data-sort]').forEach(th =>
    th.addEventListener('click', () => {
      const col=th.dataset.sort;
      if(sortBy===col) sortAsc=!sortAsc; else{sortBy=col;sortAsc=true;}
      document.querySelectorAll('thead th[data-sort]').forEach(t=>t.classList.remove('sort-asc','sort-desc'));
      th.classList.add(sortAsc?'sort-asc':'sort-desc');
      applyFilters();
    }));

  // ── Category tabs ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.cat-tab').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active'); activeCat=btn.dataset.cat; selectedSet.clear(); applyFilters();
    }));

  // ── Search ────────────────────────────────────────────────────────────────────
  $('searchInput').addEventListener('input', e => { searchText=e.target.value; selectedSet.clear(); applyFilters(); });

  // ── Source / dest paths ───────────────────────────────────────────────────────
  const srcInput=$('sourcePath'), dstInput=$('destPath');
  srcInput.value=localStorage.getItem(K_LAST_SRC)||'';
  dstInput.value=localStorage.getItem(K_LAST_DST)||'';
  refreshAll();

  // ── Feature 6: Drag-and-drop onto source input ────────────────────────────────
  const srcPanel = srcInput?.closest('.path-panel') || srcInput?.parentElement;
  if (srcPanel) {
    srcPanel.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); srcPanel.classList.add('drag-over'); });
    srcPanel.addEventListener('dragleave', e => { if (!srcPanel.contains(e.relatedTarget)) srcPanel.classList.remove('drag-over'); });
    srcPanel.addEventListener('drop', e => {
      e.preventDefault(); srcPanel.classList.remove('drag-over');
      const paths = [];
      for (const item of e.dataTransfer.items) {
        const file = item.getAsFile?.();
        if (file?.path) paths.push(file.path);
      }
      if (paths.length) {
        srcInput.value = paths.join(', ');
        addRecent(K_RECENT_SRC, paths[0]); refreshAll();
        toast(`📂 Dropped ${paths.length} path${paths.length>1?'s':''} — click SCAN to search`);
      }
    });
  }

  $('btnPickSource').addEventListener('click', async()=>{ const p=await pkgApi.openDirectory(); if(p){srcInput.value=p;addRecent(K_RECENT_SRC,p);refreshAll();}});
  $('btnPickDest').addEventListener('click',   async()=>{ const p=await pkgApi.openDirectory(); if(p){dstInput.value=p;addRecent(K_RECENT_DST,p);refreshAll();}});
  $('btnClearSource').addEventListener('click',()=>{ srcInput.value=''; srcInput.focus(); });
  $('btnClearDest').addEventListener('click',  ()=>{ activeFtpDest=null; updateFtpDestUI(); dstInput.value=''; dstInput.disabled=false; $('btnPickDest').disabled=false; dstInput.focus(); });
  $('btnScanAllDrives').addEventListener('click', async()=>{
    const drives=await pkgApi.getAllDrives();
    if(!drives||!drives.length){toast('No drives detected.','err');return;}
    srcInput.value=drives.join(', ');
    toast(`Found ${drives.length} drive${drives.length!==1?'s':''}: ${drives.join(', ')} — scanning…`);
    startScan(drives, false, false);
  });

  // ── Scan ──────────────────────────────────────────────────────────────────────
  $('btnScan').addEventListener('click',()=>{
    const src=srcInput.value.trim(); if(!src){toast('Choose a source folder first.','err');return;}
    localStorage.setItem(K_LAST_SRC,src); addRecent(K_RECENT_SRC,src); refreshAll();
    startScan([src], false, false); // merge=false → replace
  });


  // ── FTP dest ─────────────────────────────────────────────────────────────────
  function updateFtpDestUI(){
    const ind=$('ftpDestIndicator'), dst=$('destPath'), pick=$('btnPickDest');
    if(activeFtpDest){
      const label=`ftp://${activeFtpDest.host}:${activeFtpDest.port||2121}/`;
      if(ind){ind.textContent=`📥 Dest: ${label}`;ind.style.display='flex';}
      if(dst){dst.value=label;dst.disabled=true;}
      if(pick) pick.disabled=true;
    } else {
      if(ind) ind.style.display='none';
      if(dst&&dst.disabled){dst.value='';dst.disabled=false;}
      if(pick) pick.disabled=false;
    }
  }

  // ── Console scan modal ────────────────────────────────────────────────────────
  function csStatus(msg,color){const el=$('csScanStatus');if(!el)return;el.textContent=msg;el.style.color=color||'';}
  function csCfgFromForm(){const mode=$('csFtpMode')?.value||'passive';return{host:$('csHost').value.trim(),port:$('csFtpPort').value.trim()||'2121',user:$('csUser').value.trim()||'anonymous',pass:$('csPass').value||'',path:$('csPkgPath').value.trim()||'/',activeMode:mode==='active'};}
  function openConsoleScanModal(prefill){
    $('csHost').value=prefill?.host||localStorage.getItem('ps4pkgvault.csHost')||'';
    $('csFtpPort').value=prefill?.port||localStorage.getItem('ps4pkgvault.csFtpPort')||'2121';
    $('csUser').value=prefill?.user||'anonymous'; $('csPass').value='';
    $('csPkgPath').value=localStorage.getItem('ps4pkgvault.csPkgPath')||'/';
    csStatus(prefill?`${prefill.consoleType||'Console'} found at ${prefill.host} — ready to scan`:'','#4ade80');
    refreshAll(); $('consoleScanBackdrop').style.display='flex';
    setTimeout(()=>{ $('csHost').focus(); if(prefill?.host) $('csPkgPath').focus(); },80);
  }
  function closeConsoleScanModal(){$('consoleScanBackdrop').style.display='none';}
  $('btnScanConsole').addEventListener('click',()=>openConsoleScanModal(null));
  $('btnConsoleScanClose').addEventListener('click',closeConsoleScanModal);
  $('btnConsoleScanCancel').addEventListener('click',closeConsoleScanModal);
  $('consoleScanBackdrop').addEventListener('click',e=>{if(e.target===$('consoleScanBackdrop'))closeConsoleScanModal();});
  $('btnConsoleScanTestConn').addEventListener('click',async()=>{
    const cfg=csCfgFromForm(); if(!cfg.host){csStatus('Enter the console IP address first.','#f87171');return;}
    csStatus('Testing FTP connection…','');
    const res=await pkgApi.ftpTestConn(cfg);
    csStatus(res.ok?`✓ Connected — ${res.entries} entries at ${cfg.path}`:'✗ '+res.error, res.ok?'#4ade80':'#f87171');
  });
  $('btnConsoleScanDiscover').addEventListener('click',async()=>{
    const btn=$('btnConsoleScanDiscover'); btn.disabled=true; btn.textContent='⏳';
    csStatus('Scanning local network for PS4/PS5…','');
    pkgApi.offDiscoverProgress(); pkgApi.onDiscoverProgress(d=>{
      if(d.type==='found'){
        const ftp=d.ftpPort||2121; csStatus(`✓ Found ${d.consoleType||'Console'} at ${d.ip} (FTP :${ftp})`,'#4ade80');
        $('csHost').value=d.ip; $('csFtpPort').value=String(ftp); showDiscoveredChip(d);
        setTimeout(()=>closeConsoleScanModal(),1500); // Feature 17
      } else if(d.type==='batch-done'){csStatus(`Scanning… ${d.scanned}/${d.total} hosts`,'');}
      else if(d.type==='done'&&(!d.found||!d.found.length)){csStatus('No console found — make sure FTP is running on your PS4/PS5','#f87171');}
    });
    const subnet=$('csSubnet')?.value.trim()||undefined;
    await pkgApi.discoverPs4(subnet); btn.disabled=false; btn.textContent='🔍 Find'; pkgApi.offDiscoverProgress();
  });
  $('btnConsoleScanPkgs').addEventListener('click',async()=>{
    const cfg=csCfgFromForm(); if(!cfg.host){csStatus('Enter the console IP address first.','#f87171');return;}
    saveCsSettings(cfg); closeConsoleScanModal(); startScan([cfg],true,false);
  });
  $('btnConsoleScanInstalled').addEventListener('click',async()=>{
    const cfg=csCfgFromForm(); if(!cfg.host){csStatus('Enter the console IP address first.','#f87171');return;}
    saveCsSettings(cfg); closeConsoleScanModal(); startInstalledScan(cfg);
  });

  function saveConsoleCfg(cfg){
    if(!cfg.host) return;
    localStorage.setItem('ps4pkgvault.csHost',cfg.host);
    localStorage.setItem('ps4pkgvault.csFtpPort',String(cfg.port||2121));
    if(cfg.path) localStorage.setItem('ps4pkgvault.csPkgPath',cfg.path);
    localStorage.setItem('ps4vault.installPs4Ip',cfg.host);
    addRecent(K_RECENT_FTP,cfg.host); refreshAll();
    const ipEl=$('installPs4Ip'); if(ipEl&&!ipEl.value) ipEl.value=cfg.host;
  }
  function saveCsSettings(cfg){saveConsoleCfg(cfg);}

  // ── Discovered console chip ───────────────────────────────────────────────────
  function showDiscoveredChip(d){
    const ftpPort=d.ftpPort||2121;
    $('discoveredChipLabel').textContent=`${d.consoleType||'Console'} · ${d.ip}:${ftpPort}`;
    $('discoveredChipIcon').textContent=d.consoleType==='PS5'?'🟦':'🎮';
    $('discoveredChip').style.display='flex'; discoveredConsole=d;
    saveConsoleCfg({host:d.ip,port:ftpPort});
    const ipEl=$('installPs4Ip'); if(ipEl) ipEl.value=d.ip;
    const prEl=$('installPs4Port'); if(prEl&&d.installerOpen) prEl.value='12800';
    const st=$('installDiscoverStatus');
    if(st){st.style.display='block';st.style.color=d.installerOpen?'#4ade80':'#facc15';
      st.textContent=d.installerOpen?`${d.consoleType||'Console'} at ${d.ip} — Remote PKG Installer ready (port 12800)`:`${d.consoleType||'Console'} at ${d.ip} on FTP :${ftpPort} — open Remote PKG Installer`;}
  }
  function hideDiscoveredChip(){$('discoveredChip').style.display='none';discoveredConsole=null;activeFtpDest=null;updateFtpDestUI();}
  $('discoveredChipDismiss').addEventListener('click',hideDiscoveredChip);
  $('discoveredChipScan').addEventListener('click',()=>{if(!discoveredConsole)return;const cfg={host:discoveredConsole.ip,port:String(discoveredConsole.ftpPort||2121),user:'anonymous',pass:'',path:'/'};saveConsoleCfg(cfg);startScan([cfg],true,false);});
  $('discoveredChipInstalled').addEventListener('click',()=>{if(!discoveredConsole)return;const cfg={host:discoveredConsole.ip,port:String(discoveredConsole.ftpPort||2121),user:'anonymous',pass:'',path:'/'};saveConsoleCfg(cfg);startInstalledScan(cfg);});
  const useDest=$('discoveredChipUseDest');
  if(useDest) useDest.addEventListener('click',()=>{
    if(!discoveredConsole)return;
    activeFtpDest={host:discoveredConsole.ip,port:String(discoveredConsole.ftpPort||2121),user:'anonymous',pass:'',path:'/'};
    saveConsoleCfg(activeFtpDest); updateFtpDestUI();
    toast(`📥 Destination set to ${discoveredConsole.consoleType||'Console'} at ${discoveredConsole.ip}`);
  });

  // ── Installed scan ────────────────────────────────────────────────────────────
  async function startInstalledScan(cfg){
    allItems=[];filteredItems=[];selectedSet.clear();activeCat='all';
    document.querySelectorAll('.cat-tab').forEach(b=>b.classList.remove('active'));
    $('catAll')?.classList.add('active');
    renderTable();updateCounts();setScanUI(true);
    const pendingUpdates=new Map();
    pkgApi.offScanProgress();
    pkgApi.onScanProgress(d=>{
      if(d.type==='scan-result-update'){
        const item=allItems.find(i=>i.filePath===d.filePath);
        if(item){if(d.fileSize!==undefined)item.fileSize=d.fileSize;applyFiltersSoon();}
        else pendingUpdates.set(d.filePath,d);
        return;
      }
      handleScanProgress(d);
    });
    const returned=await pkgApi.ftpScanInstalled(cfg);
    if(Array.isArray(returned)&&returned.length>0)
      returned.forEach(item=>{if(!allItems.some(i=>i.filePath===item.filePath))allItems.push(item);});
    if(pendingUpdates.size>0)
      pendingUpdates.forEach((d,fp)=>{const item=allItems.find(i=>i.filePath===fp);if(item&&d.fileSize!==undefined)item.fileSize=d.fileSize;});
    applyFilters();updateCounts();setScanUI(false);
    if(returned&&returned.length>0){
      document.querySelectorAll('.cat-tab').forEach(b=>b.classList.remove('active'));
      const ib=$('catInstalled');if(ib){ib.classList.add('active');activeCat='Installed';}
      const total=returned.reduce((s,i)=>s+(i.fileSize||0),0);
      if(total>0){const bar=$('consoleStorageBar'),fill=$('consoleStorageFill'),label=$('consoleStorageLabel');
        if(bar&&fill&&label){const pct=Math.min(100,Math.round(total/500e9*100));fill.style.width=pct+'%';label.textContent=`${fmtSize(total)} used`;bar.style.display='block';}}
    }
    toast(`Found ${returned?.length||0} installed game${returned?.length!==1?'s':''}.`);
  }

  $('btnCancelScan').addEventListener('click',()=>{pkgApi.cancelOperation();setScanUI(false);toast('Scan cancelled.');});

  // ── View toggle ───────────────────────────────────────────────────────────────
  viewMode=settings.viewMode||'table';
  function applyViewMode(){
    const isGrid=viewMode==='grid';
    $('tableView').style.display=isGrid?'none':''; $('gridView').style.display=isGrid?'':'none';
    $('btnViewToggle').textContent=isGrid?'☰ Table':'⊞ Grid';
    $('btnViewToggle').classList.toggle('active',isGrid); renderTable();
  }
  $('btnViewToggle').addEventListener('click',()=>{viewMode=viewMode==='table'?'grid':'table';saveSetting('viewMode',viewMode);applyViewMode();});
  applyViewMode();

  // ── Main scan ─────────────────────────────────────────────────────────────── Feature 10: merge
  let lastScanErrorMsg=null;
  async function startScan(dirs, isFtp, merge) {
    if (!merge) { allItems=[]; filteredItems=[]; selectedSet.clear(); activeCat='all'; document.querySelectorAll('.cat-tab').forEach(b=>b.classList.remove('active')); $('catAll')?.classList.add('active'); }
    renderTable(); updateCounts(); setScanUI(true);
    if(isFtp&&dirs.length>0&&typeof dirs[0]==='object') srcInput.value=`ftp://${dirs[0].host}:${dirs[0].port||2121}${dirs[0].path||'/'}`;
    pkgApi.offScanProgress(); pkgApi.onScanProgress(handleScanProgress);
    const skippedDrives=[];
    for(const dir of dirs){
      lastScanErrorMsg=null;
      const returned = isFtp
        ? await pkgApi.ftpScanPkgs(dir)
        : await pkgApi.scanPkgs(typeof dir==='string'?dir.trim():dir, scanDepth); // FIX 1: pass depth
      if(Array.isArray(returned)&&returned.length>0){
        const existing=new Set(allItems.map(i=>i.filePath));
        returned.forEach(item=>{if(!existing.has(item.filePath))allItems.push(item);});
      } else if(lastScanErrorMsg) skippedDrives.push(typeof dir==='string'?dir:(dir.host||'?'));
    }
    applyFilters(); updateCounts(); setScanUI(false);
    if(allItems.length>0) pkgApi.saveLibrary?.(allItems).catch(()=>{});
    const totalSz=allItems.reduce((s,i)=>s+(i.fileSize||0),0);
    const parts=allItems.filter(i=>i.isPartial).length;
    let summary=`${merge?'Merge':'Scan'} complete — ${allItems.filter(i=>!i.isPartial).length} PKGs (${fmtSize(totalSz)})`;
    if(parts) summary+=` · ⚠ ${parts} incomplete`;
    if(skippedDrives.length) summary+=` · ${skippedDrives.length} skipped`;
    toast(summary+'.');
  }
  function handleScanProgress(d){
    if(d.type==='scan-start'||d.type==='scan-discovering') $('currentScanLabel').textContent='Discovering .pkg files…';
    else if(d.type==='scan-found'){
      $('currentScanLabel').textContent=`Found ${d.total} PKG${d.total!==1?'s':''}. Parsing…`;
      const pb=$('scanProgressBar'); if(pb){pb.style.width='0%';}
    }
    else if(d.type==='scan-parsing'){
      $('currentScanLabel').textContent=`Parsing ${d.done} / ${d.total}  ·  ${d.file}`;
      const pct = d.total > 0 ? Math.round(d.done / d.total * 100) : 0;
      const pb=$('scanProgressBar'); if(pb) pb.style.width=pct+'%';
    }
    else if(d.type==='scan-result'){
      if(!allItems.some(i=>i.filePath===d.item.filePath)){allItems.push(d.item);$('currentScanLabel').textContent=`Parsing… ${allItems.length} found`;applyFiltersSoon();}
    }
    else if(d.type==='scan-result-update'){const item=allItems.find(i=>i.filePath===d.filePath);if(item){if(d.fileSize!==undefined)item.fileSize=d.fileSize;applyFiltersSoon();}}
    else if(d.type==='scan-done'){
      $('currentScanLabel').textContent=`Done — ${d.total} PKG${d.total!==1?'s':''} from this source`;
      const pb=$('scanProgressBar'); if(pb) pb.style.width='100%';
    }
    else if(d.type==='scan-error'){lastScanErrorMsg=d.message;toast('⚠ '+d.message,'err');}
  }
  function setScanUI(active){
    $('btnScan').disabled=$('btnScanAllDrives').disabled=$('btnScanConsole').disabled=active;
    $('btnCancelScan').style.display=active?'inline-flex':'none';
    $('scanDisplay').style.display=active?'flex':'none';
  }

  // ── Delete ────────────────────────────────────────────────────────────────────
  window.deleteOne=async(fp)=>{
    const item=allItems.find(i=>i.filePath===fp); if(!item)return;
    if(!await showConfirm(`Delete ${item.fileName}?`, { sub:'This cannot be undone.', icon:'🗑' }))return;
    const results=await pkgApi.deletePkgs([item]);
    if(results[0]?.ok){allItems=allItems.filter(i=>i.filePath!==fp);selectedSet.delete(fp);applyFilters();toast(`Deleted ${item.fileName}`);}
    else toast('Delete failed: '+results[0]?.error,'err');
  };
  $('btnDeleteSelected').addEventListener('click',async()=>{
    const sel=allItems.filter(i=>selectedSet.has(i.filePath)); if(!sel.length)return;
    if(!await showConfirm(`Delete ${sel.length} PKG file${sel.length>1?'s':''}?`, { sub:'This cannot be undone.', icon:'🗑' }))return;
    const results=await pkgApi.deletePkgs(sel);
    const ok=results.filter(r=>r.ok),errs=results.filter(r=>!r.ok);
    ok.forEach(r=>{allItems=allItems.filter(i=>i.filePath!==r.filePath);selectedSet.delete(r.filePath);});
    applyFilters(); toast(`Deleted ${ok.length}${errs.length?`, ${errs.length} failed`:''}`);
  });

  // ── Rename modal ──────────────────────────────────────────────────────────────
  const renameBackdrop=$('renameModalBackdrop'),renameInput=$('renameInput'),renamePreset=$('renamePreset');
  let renameTarget=null;
  const RENAME_PRESETS=[
    {label:'ID - Title [vVER] [CAT]',   fmt:'{TITLE_ID} - {TITLE} [v{VERSION}] [{CATEGORY}]'},
    {label:'[REGION] ID - Title (VER)', fmt:'[{REGION}] {TITLE_ID} - {TITLE} ({VERSION})'},
    {label:'Title [ID] [REGION] vVER',  fmt:'{TITLE} [{TITLE_ID}] [{REGION}] v{VERSION}'},
    {label:'ID_VER_REGION',             fmt:'{TITLE_ID}_{VERSION}_{REGION}'},
    {label:'Custom…',                   fmt:''},
  ];
  (function(){renamePreset.innerHTML='';RENAME_PRESETS.forEach(p=>{const o=document.createElement('option');o.value=p.fmt;o.textContent=p.label;renamePreset.appendChild(o);})})();
  function openRenameModal(item){renameTarget=item;const fmt=RENAME_PRESETS[0].fmt;renamePreset.value=fmt;renameInput.value=item?applyRenameFormat(fmt,item):fmt;updateRenamePreview();renameBackdrop.style.display='flex';setTimeout(()=>renameInput.focus(),50);}
  function updateRenamePreview(){const val=renameInput.value.trim();if(renameTarget){$('renamePreview').textContent=val.endsWith('.pkg')?val:val+'.pkg';}else{const sample=allItems.find(i=>selectedSet.has(i.filePath));if(sample){$('renamePreview').textContent=applyRenameFormat(val,sample)+'.pkg'+(selectedSet.size>1?`  (+${selectedSet.size-1} more)`:'')}else $('renamePreview').textContent=val;}}
  function applyRenameFormat(fmt,item){const cat=categoryDisplay(item.category),reg=regionDisplay(item.region);return fmt.replace(/{TITLE_ID}/g,san4(item.titleId||'UNKNOWN')).replace(/{TITLE}/g,san4(item.title||'Unknown')).replace(/{VERSION}/g,san4(item.appVer||'00.00')).replace(/{CATEGORY}/g,san4(cat)).replace(/{REGION}/g,san4(reg)).replace(/{CONTENT_ID}/g,san4(item.contentId||'')).replace(/{REQ_FW}/g,san4(item.sysVer||'')).trim();}
  function san4(s){return String(s||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim();}
  renamePreset.addEventListener('change',()=>{const fmt=renamePreset.value;if(fmt!=='')renameInput.value=renameTarget?applyRenameFormat(fmt,renameTarget):fmt;updateRenamePreview();});
  renameInput.addEventListener('input',updateRenamePreview);
  renameInput.addEventListener('keydown',e=>{if(e.key==='Enter')$('btnRenameApply').click();if(e.key==='Escape')closeRenameModal();});
  $('btnRenameApply').addEventListener('click',async()=>{
    const val=renameInput.value.trim(); if(!val)return;
    if(renameTarget){const newName=val.endsWith('.pkg')?val:val+'.pkg';const res=await pkgApi.renamePkg(renameTarget,newName);if(res.error){toast('Rename failed: '+res.error,'err');return;}renameTarget.filePath=res.newPath;renameTarget.fileName=res.newFileName;closeRenameModal();renderTable();toast(`Renamed to ${res.newFileName}`);}
    else{const sel=allItems.filter(i=>selectedSet.has(i.filePath));let ok=0,fail=0;for(const item of sel){const newName=applyRenameFormat(val,item)+'.pkg';const res=await pkgApi.renamePkg(item,newName);if(res.error)fail++;else{item.filePath=res.newPath;item.fileName=res.newFileName;ok++;}}closeRenameModal();renderTable();toast('Renamed ' + ok + (fail ? ', ' + fail + ' failed' : '') );}
  });
  $('btnRenameCancel').addEventListener('click',closeRenameModal);
  $('btnRenameClose')?.addEventListener('click',closeRenameModal);
  renameBackdrop.addEventListener('click',e=>{if(e.target===renameBackdrop)closeRenameModal();});
  function closeRenameModal(){renameBackdrop.style.display='none';renameTarget=null;}
  window.startRenameInline=(e,fp)=>{e.stopPropagation();const item=allItems.find(i=>i.filePath===fp);if(item)openRenameModal(item);};
  $('btnRenameSelected').addEventListener('click',()=>{if(!selectedSet.size)return;if(selectedSet.size===1)openRenameModal(allItems.find(i=>i.filePath===[...selectedSet][0]));else openRenameModal(null);});

  // ── Feature 9: Conflict resolution modal ─────────────────────────────────────
  let conflictResolve=null;
  function askConflict(filename, remaining){
    return new Promise(resolve=>{
      conflictResolve=resolve;
      $('conflictFilename').textContent=filename;
      $('conflictSubtitle').textContent=`${remaining} conflict${remaining!==1?'s':''} remaining`;
      $('conflictApplyAllCheck').checked=false;
      $('conflictBackdrop').style.display='flex';
    });
  }
  function resolveConflict(action){const applyAll=$('conflictApplyAllCheck').checked;$('conflictBackdrop').style.display='none';if(conflictResolve){conflictResolve({action,applyAll});conflictResolve=null;}}
  $('btnConflictSkip').addEventListener('click',()=>resolveConflict('skip'));
  $('btnConflictRenameAuto').addEventListener('click',()=>resolveConflict('rename'));
  $('btnConflictOverwrite').addEventListener('click',()=>resolveConflict('overwrite'));

  // ── GO (copy/move) ────────────────────────────────────────────────────────────
  $('btnGoSelected').addEventListener('click',async()=>{
    const sel=allItems.filter(i=>selectedSet.has(i.filePath)&&!i.isPartial);
    if(!sel.length){toast('Select complete PKGs first.','err');return;}
    const action=$('actionSelect').value,layout=$('layoutSelect').value;
    const renameFmt=$('renameFmtInput').value.trim()||RENAME_PRESETS[0].fmt;
    if(activeFtpDest){
      openGoModal(sel.length,action); pkgApi.offGoProgress(); pkgApi.onGoProgress(handleGoProgress);
      pkgApi.goPkgs(sel,activeFtpDest.path||'/',action,layout,renameFmt,activeFtpDest,null).catch(e=>toast('Transfer error: '+e.message,'err'));
      return;
    }
    const dest=dstInput.value.trim(); if(!dest){toast('Choose a destination folder first.','err');return;}
    const conflicts=await pkgApi.checkPkgConflicts(sel,dest,layout,renameFmt);
    // Feature 9: per-file conflict resolution
    let globalAction=null;
    const conflictModes={};
    for(let i=0;i<conflicts.length;i++){
      const cc=conflicts[i];
      if(globalAction){conflictModes[cc.item.filePath]=globalAction;continue;}
      const {action:a,applyAll}=await askConflict(cc.destPath?.split(/[\\/]/).pop()||cc.item.fileName, conflicts.length-i);
      conflictModes[cc.item.filePath]=a;
      if(applyAll) globalAction=a;
    }
    const toProcess=sel.filter(item=>conflictModes[item.filePath]!=='skip'||(conflicts.findIndex(c=>c.item.filePath===item.filePath)<0));
    if(!toProcess.length){toast('All conflicts skipped.');return;}
    localStorage.setItem(K_LAST_DST,dest); addRecent(K_RECENT_DST,dest); refreshAll();
    openGoModal(toProcess.length,action); pkgApi.offGoProgress(); pkgApi.onGoProgress(handleGoProgress);
    pkgApi.goPkgs(toProcess,dest,action,layout,renameFmt,null,conflictModes).catch(e=>toast('Transfer error: '+e.message,'err')); // FIX 3
  });

  // ── Go modal ──────────────────────────────────────────────────────────────────
  const goBackdrop=$('goModalBackdrop');
  let goDone=false, goDestDir='';
  function openGoModal(total,action){
    goDone=false; goDestDir=''; $('goModal').classList.add('busy');
    $('goModalTitle').textContent=action==='move'?`Moving ${total} PKG${total!==1?'s':''}…`:`Copying ${total} PKG${total!==1?'s':''}…`;
    $('goModalFile').textContent=''; $('goModalProgress').textContent=`0 / ${total}`;
    $('goFilebar').style.width=$('goOverallbar').style.width='0%';
    $('goModalClose').style.display='none'; $('goModalCancel').style.display='inline-flex';
    $('goModalOpenFolder').style.display='none'; goBackdrop.style.display='flex';
  }
  const goState={buf:[],ewmaSpeed:0,totalFiles:1,curFile:0};
  const EWMA_A=0.25;
  function goSpeedEta(bytes,total,ts){
    const now=ts||Date.now(); goState.buf.push({t:now,b:bytes});
    const cutoff=now-4000; while(goState.buf.length>1&&goState.buf[0].t<cutoff) goState.buf.shift();
    let inst=0;
    if(goState.buf.length>=2){const win=goState.buf.filter(s=>s.t>=now-3000);if(win.length>=2){const dt=(win[win.length-1].t-win[0].t)/1000,db=win[win.length-1].b-win[0].b;if(dt>0.15&&db>0)inst=db/dt;}}
    if(inst>0) goState.ewmaSpeed=goState.ewmaSpeed>0?EWMA_A*inst+(1-EWMA_A)*goState.ewmaSpeed:inst;
    const speed=goState.ewmaSpeed,rem=total-bytes;
    return{speed,eta:speed>1024&&rem>0?Math.min(Math.round(rem/speed),86400):null};
  }
  function handleGoProgress(d){
    if(d.type==='go-file-start'){goState.buf=[];goState.ewmaSpeed=0;goState.totalFiles=d.total;goState.curFile=d.current;$('goModalFile').textContent=d.title||d.file;$('goModalProgress').textContent=`${d.current} / ${d.total}`;$('goFilebar').style.width='0%';$('goFileSpeed').textContent=$('goFileEta').textContent=$('goFileBytes').textContent='';$('goOverallbar').style.width=Math.round((d.current-1)/d.total*100)+'%';$('goOverallPct').textContent=Math.round((d.current-1)/d.total*100)+'%';$('goOverallDone').textContent=`${d.current-1} of ${d.total} files`;}
    else if(d.type==='go-file-progress'){const pct=d.totalBytes?Math.round(d.bytesCopied/d.totalBytes*100):0;$('goFilebar').style.width=pct+'%';$('goModalProgress').textContent=pct+'%';const{speed,eta}=goSpeedEta(d.bytesCopied,d.totalBytes,d.ts);$('goFileSpeed').innerHTML=speed>0?`<span class="hi">${fmtSpeed(speed)}</span>`:'';$('goFileEta').innerHTML=eta!==null?`ETA <span class="hi">${fmtSec(eta)}</span>`:'';$('goFileBytes').innerHTML=d.totalBytes?`<span class="hi">${fmtSize(d.bytesCopied)}</span> / ${fmtSize(d.totalBytes)}`:'';if(d.destDir)goDestDir=d.destDir;}
    else if(d.type==='go-file-done'){$('goFilebar').style.width='100%';$('goModalProgress').textContent='100%';$('goFileEta').textContent='✓ Done';const ov=Math.round(goState.curFile/goState.totalFiles*100);$('goOverallbar').style.width=ov+'%';$('goOverallPct').textContent=ov+'%';$('goOverallDone').textContent=`${goState.curFile} of ${goState.totalFiles} files`;if(d.destPath)goDestDir=d.destPath.replace(/[\\/][^\\/]+$/,'');}
    else if(d.type==='go-file-error') toast(`Failed: ${d.file}`,'err');
    else if(d.type==='go-done'){goDone=true;$('goOverallbar').style.width='100%';$('goOverallPct').textContent='100%';$('goModalTitle').textContent='Done!';$('goModalProgress').textContent='';$('goModalFile').textContent=`${d.ok} transferred${d.error?', '+d.error+' failed':''}${d.skipped?', '+d.skipped+' skipped':''}`;$('goFileSpeed').textContent=$('goFileEta').textContent=$('goFileBytes').textContent='';$('goModal').classList.remove('busy');$('goModalClose').style.display='inline-flex';$('goModalCancel').style.display='none';
      if(goDestDir||dstInput.value.trim()){$('goModalOpenFolder').style.display='inline-flex';$('goModalOpenFolder').onclick=()=>pkgApi.showInFolder(goDestDir||dstInput.value.trim());} // Feature 8
      if($('actionSelect').value==='move'){const moved=[...selectedSet];allItems=allItems.filter(i=>!moved.includes(i.filePath));selectedSet.clear();applyFilters();}}
  }
  $('goModalCancel').addEventListener('click',()=>pkgApi.cancelOperation());
  $('goModalClose').addEventListener('click',()=>{goBackdrop.style.display='none';});
  goBackdrop.addEventListener('click',e=>{if(e.target===goBackdrop&&goDone)goBackdrop.style.display='none';});

  // ── Layout format visibility ──────────────────────────────────────────────────
  $('layoutSelect').addEventListener('change',e=>{const show=e.target.value==='rename'||e.target.value==='rename-organize';$('renameFmtRow').style.display=show?'flex':'none';});

  // ── Menu ──────────────────────────────────────────────────────────────────────
  $('topMenu').addEventListener('change',async e=>{
    const v=e.target.value; e.target.value='';
    if(v==='clear'){if(!await showConfirm('Clear all scan results?', { icon:'🧹', okLabel:'Clear', okClass:'btn' }))return;allItems=[];filteredItems=[];selectedSet.clear();renderTable();updateCounts();}
    if(v==='selectAll'){filteredItems.forEach(i=>selectedSet.add(i.filePath));renderTable();updateSelectionUI();}
    if(v==='unselectAll'){selectedSet.clear();renderTable();updateSelectionUI();}
    if(v==='exportCsv') exportCsv();
    if(v==='exportTxt') exportTxt();  // Feature 20
    if(v==='settings')  openSettingsModal();
    if(v==='deleteDuplicates') deleteDuplicates(); // Feature 11
    if(v==='checkUpdate'){
      try {
        toast('Checking for updates…');
        const res = await pkgApi.checkForUpdatesManual?.();
        if (!res) { toast('Could not reach update server', 'err'); return; }
        if (res.upToDate) {
          toast(`You're on the latest version (v${res.version})`);
        } else {
          showUpdateBanner(res);
          toast(`Update available: v${res.latestVersion}`);
        }
      } catch (e) {
        toast('Update check failed: ' + (e.message || String(e)), 'err');
      }
    }
    if(v==='openLog')    pkgApi.openLog();
    if(v==='openLogFolder') pkgApi.openLogFolder();
    if(v==='about')      openAboutModal();
  });
  function exportCsv(){
    if(!allItems.length){toast('Nothing to export.');return;}
    const hdr=['Title','Title ID','Category','Version','Region','Req FW','Size (bytes)','Filename','Path','Content ID','Partial'];
    const rows=allItems.map(i=>[i.title,i.titleId,categoryDisplay(i.category),i.appVer,regionDisplay(i.region),i.sysVer,i.fileSize,i.fileName,i.filePath,i.contentId,i.isPartial?'yes':''].map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(','));
    const blob=new Blob([[hdr.join(','),...rows].join('\n')],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`ps4-pkgs-${Date.now()}.csv`;a.click();URL.revokeObjectURL(url);toast(`Exported ${allItems.length} rows.`);
  }
  // Feature 20: plain text / M3U export
  function exportTxt(){
    if(!allItems.length){toast('Nothing to export.');return;}
    const lines=allItems.filter(i=>!i.isPartial).map(i=>`${i.sfoTitle||i.fnTitle||i.titleId||i.fileName}\t${i.titleId||''}\t${categoryDisplay(i.category)}\t${fmtSize(i.fileSize)}`);
    const blob=new Blob([lines.join('\n')],{type:'text/plain'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`ps4-library-${Date.now()}.txt`;a.click();URL.revokeObjectURL(url);toast(`Exported ${lines.length} titles.`);
  }
  // Feature 11: delete duplicates
  async function deleteDuplicates(){
    const dupes=allItems.filter(i=>i.isDuplicate);
    if(!dupes.length){toast('No duplicates found.');return;}
    if(!await showConfirm(`Delete ${dupes.length} duplicate PKG${dupes.length>1?'s':''}?`, { sub:'One copy of each game will be kept. This cannot be undone.', icon:'🗑' }))return;
    // Group by contentId, keep first, delete rest
    const seen=new Set(),toDelete=[];
    allItems.forEach(item=>{
      if(!item.isDuplicate) return;
      const key=item.contentId||item.titleId||item.fileName;
      if(seen.has(key)) toDelete.push(item); else seen.add(key);
    });
    pkgApi.deletePkgs(toDelete).then(results=>{
      const ok=results.filter(r=>r.ok);
      ok.forEach(r=>{allItems=allItems.filter(i=>i.filePath!==r.filePath);selectedSet.delete(r.filePath);});
      applyFilters(); toast(`Deleted ${ok.length} duplicate${ok.length!==1?'s':''}.`);
    });
  }

  // ── Feature 12: Settings modal ────────────────────────────────────────────────
  let ftpPool=settings.ftpPool||3;
  function openSettingsModal(){
    $('settingScanDepth').value=scanDepth;
    $('settingScanDepthVal').textContent=scanDepth;
    const ds=Math.round(installDelay/1000);
    $('settingInstallDelay').value=ds; $('settingInstallDelayVal').textContent=ds+'s';
    if($('settingFtpPool')){$('settingFtpPool').value=ftpPool;$('settingFtpPoolVal').textContent=ftpPool;}
    $('settingsBackdrop').style.display='flex';
  }
  function closeSettingsModal(){$('settingsBackdrop').style.display='none';}
  $('btnSettingsClose').addEventListener('click',closeSettingsModal);
  $('btnSettingsClose2').addEventListener('click',closeSettingsModal);
  $('settingScanDepth').addEventListener('input',e=>{scanDepth=parseInt(e.target.value)||10;$('settingScanDepthVal').textContent=scanDepth;saveSetting('scanDepth',scanDepth);});
  $('settingInstallDelay').addEventListener('input',e=>{installDelay=parseInt(e.target.value)*1000;$('settingInstallDelayVal').textContent=e.target.value+'s';saveSetting('installDelay',installDelay);});
  $('settingFtpPool')?.addEventListener('input',e=>{ftpPool=parseInt(e.target.value)||3;$('settingFtpPoolVal').textContent=ftpPool;saveSetting('ftpPool',ftpPool);pkgApi.setSetting?.('ftpPool',ftpPool);});
  $('btnSaveLibrary').addEventListener('click',async()=>{if(!allItems.length){toast('Nothing to save.','err');return;}const r=await pkgApi.saveLibrary(allItems);toast(r.ok?`✅ Saved ${allItems.length} items.`:'Failed: '+r.error,r.ok?'ok':'err');});
  $('btnLoadLibrary').addEventListener('click',async()=>{const r=await pkgApi.loadLibrary();if(!r.ok||!r.items?.length){toast('No saved library found.','err');return;}allItems=r.items;filteredItems=[];selectedSet.clear();activeCat='all';document.querySelectorAll('.cat-tab').forEach(b=>b.classList.remove('active'));$('catAll')?.classList.add('active');applyFilters();updateCounts();toast(`✅ Loaded ${r.items.length} items.`);closeSettingsModal();});
  $('btnClearLibrary').addEventListener('click',async()=>{if(!await showConfirm('Clear saved library?', { sub:'Your current scan results will not be affected.', icon:'📚', okLabel:'Clear', okClass:'btn' }))return;await pkgApi.clearLibrary?.();toast('Library cleared.');});

  // ── Toast ──────────────────────────────────────────────────────────────────────
  let toastTimer=null;
  function toast(msg,type='ok'){const el=$('toast');el.textContent=msg;el.className='toast toast--'+type;el.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.style.display='none';},3500);}

  // ── Custom confirm modal — replaces native confirm() ─────────────────────
  let _confirmResolve = null;
  function showConfirm(msg, { sub='', icon='🗑', okLabel='Confirm', okClass='btn-danger' } = {}) {
    return new Promise(resolve => {
      _confirmResolve = resolve;
      $('confirmMsg').textContent  = msg;
      $('confirmSub').textContent  = sub;
      $('confirmSub').style.display = sub ? 'block' : 'none';
      $('confirmIcon').textContent = icon;
      $('btnConfirmOk').textContent = okLabel;
      $('btnConfirmOk').className   = okClass;
      $('confirmBackdrop').style.display = 'flex';
    });
  }
  $('btnConfirmOk').addEventListener('click', () => {
    $('confirmBackdrop').style.display = 'none';
    if (_confirmResolve) { _confirmResolve(true); _confirmResolve = null; }
  });
  $('btnConfirmCancel').addEventListener('click', () => {
    $('confirmBackdrop').style.display = 'none';
    if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
  });
  $('confirmBackdrop').addEventListener('click', e => {
    if (e.target === $('confirmBackdrop')) {
      $('confirmBackdrop').style.display = 'none';
      if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
    }
  });

  // ── Remote install modal ──────────────────────────────────────────────────────
  const installBackdrop=$('installModalBackdrop');
  let installActive=false;
  window.installOne=(fp)=>{ const item=allItems.find(i=>i.filePath===fp); if(item&&!item.isPartial) openInstallModal([item]); };
  $('btnInstallSelected').addEventListener('click',()=>{const sel=allItems.filter(i=>selectedSet.has(i.filePath)&&!i.isPartial);if(sel.length)openInstallModal(sel);else toast('Select complete (non-partial) PKGs.','err');});

  async function openInstallModal(items){
    const savedIp=localStorage.getItem('ps4vault.installPs4Ip')||localStorage.getItem('ps4pkgvault.csHost')||(discoveredConsole?.ip)||'';
    let savedPort=localStorage.getItem('ps4vault.installPs4Port')||'12800';
    if(['2121','21','1337','9090'].includes(savedPort)){savedPort='12800';localStorage.setItem('ps4vault.installPs4Port','12800');}
    let savedSrvPort=localStorage.getItem('ps4vault.installSrvPort')||'8090';
    if(['2121','21','1337','9090','12800'].includes(savedSrvPort)){savedSrvPort='8090';localStorage.setItem('ps4vault.installSrvPort','8090');}
    $('installPs4Ip').value=savedIp; $('installPs4Port').value=savedPort; $('installSrvPort').value=savedSrvPort;
    try{const localIp=await pkgApi.getLocalIp();$('installLocalIp').textContent=localIp;$('installBaseUrl').textContent=`http://${localIp}:${savedSrvPort}/`;$('installLocalIpBox').style.display='flex';}catch{$('installLocalIpBox').style.display='none';}
    renderInstallItems(items);
    $('installDiscoverStatus').style.display='none';
    $('installPhaseBar').style.display=$('installXferWrap').style.display='none';
    $('installWarnBox').style.display=$('installSummary').style.display='none';
    $('installWarnBox').textContent=$('installSummary').textContent='';
    $('btnInstallStart').disabled=false; $('btnInstallStart').textContent='📡 Send to PS4 / PS5';
    $('btnInstallCancel').textContent='Close'; $('btnInstallClose').style.display='flex';
    installBackdrop.dataset.items=JSON.stringify(items.map(i=>i.filePath));
    installBackdrop.style.display='flex'; setTimeout(()=>$('installPs4Ip').focus(),80);
  }
  function renderInstallItems(items){
    $('installItemsList').innerHTML=items.map(item=>`<div class="install-item" id="ii-${escAttr(item.filePath)}"><div class="ii-icon">📦</div><div class="ii-info"><div class="ii-name" title="${escHtml(item.filePath)}">${escHtml(item.title||item.fileName)}</div><div class="ii-status" id="ii-status-${escAttr(item.filePath)}">${item.isFtp?'⚠ FTP — will be skipped':'Waiting…'}</div><div class="ii-bar-wrap" id="ii-bar-wrap-${escAttr(item.filePath)}" style="display:none"><div class="ii-bar" id="ii-bar-${escAttr(item.filePath)}" style="width:0%"></div></div></div></div>`).join('');
  }

  // Feature 14: copy server URL
  $('btnCopyServerUrl')?.addEventListener('click',()=>{const url=$('installBaseUrl').textContent;if(url&&url!=='—'){pkgApi.copyToClipboard(url);toast('Server URL copied');}});

  // Feature 6 (FIX 6): PKG verify in context menu
  async function verifyPkgItem(fp) {
    const item=allItems.find(i=>i.filePath===fp); if(!item||item.isPartial||item.isInstalled){toast('Cannot verify FTP/installed/partial items.','err');return;}
    toast('Verifying integrity…');
    const r=await pkgApi.verifyPkg(fp);
    if(!r.ok){toast('Verify failed: '+r.error,'err');return;}
    const shortHash=r.sha256.slice(0,16)+'…';
    const info=`${item.title||item.fileName}\n\nSHA-256: ${r.sha256}\nSize: ${fmtSize(r.size)}\n\nFile is complete — ${fmtSize(r.size)} bytes`;
    toast(`✓ ${item.fileName} — SHA-256: ${shortHash} (${fmtSize(r.size)})`);
    pkgApi.copyToClipboard(r.sha256);
    toast('SHA-256 hash copied to clipboard ✓');
  }

  // Feature 5 (FIX 6): Speed test button in install modal
  $('btnSpeedTest')?.addEventListener('click',async()=>{
    const ps4Ip=$('installPs4Ip').value.trim(), srvPort=parseInt($('installSrvPort').value)||8090;
    if(!ps4Ip){toast('Enter the PS4/PS5 IP first.','err');return;}
    const btn=$('btnSpeedTest'); btn.disabled=true; btn.textContent='⏳ Testing…';
    const status=$('installDiscoverStatus');
    if(status){status.style.display='block';status.style.color='';status.textContent='Uploading 4 MB to PS4/PS5 to measure speed…';}
    const r=await pkgApi.speedTestPs4(ps4Ip,12800,srvPort).catch(e=>({ok:false,error:e.message}));
    btn.disabled=false; btn.textContent='⚡ Speed Test';
    if(r.ok){
      const msg=`⚡ ${r.mbps} MB/s (${r.mbpsNet} Mbps) — 4 MB in ${r.elapsed}ms`;
      if(status){status.style.color='#4ade80';status.textContent=msg;}
      toast(msg);
    } else {
      if(status){status.style.color='#f87171';status.textContent='Speed test failed: '+r.error;}
      toast('Speed test failed: '+r.error,'err');
    }
  });

  // ── Install discover ──────────────────────────────────────────────────────────
  $('btnDiscoverPs4').addEventListener('click',async()=>{
    const btn=$('btnDiscoverPs4'),status=$('installDiscoverStatus');
    btn.disabled=true; btn.textContent='⏳ Scanning…'; status.style.display='block'; status.textContent='Scanning local network for PS4/PS5…';
    pkgApi.offDiscoverProgress(); pkgApi.onDiscoverProgress(d=>{
      if(d.type==='found'){const note=d.installerOpen?' — Remote PKG Installer ready ✓':` — found on FTP:${d.ftpPort||2121}`;status.style.color=d.installerOpen?'#4ade80':'#facc15';status.textContent=`${d.consoleType||'Console'} at ${d.ip}${note}`;showDiscoveredChip(d);}
      else if(d.type==='batch-done'){if(status.textContent.startsWith('Scanning'))status.textContent=`Scanning… ${d.scanned}/${d.total} hosts`;}
      else if(d.type==='done'){btn.disabled=false;btn.textContent='🔍 Find IP';if(!d.found||!d.found.length){status.style.color='#f87171';status.textContent='✗ No console found';}}
    });
    await pkgApi.discoverPs4(); btn.disabled=false; btn.textContent='🔍 Find IP'; pkgApi.offDiscoverProgress(); // auto subnet
  });
  $('installSrvPort').addEventListener('input',async()=>{try{const ip=await pkgApi.getLocalIp();$('installBaseUrl').textContent=`http://${ip}:${$('installSrvPort').value||'8090'}/`;}catch{}});
  $('btnTestPs4Conn').addEventListener('click',async()=>{
    const btn=$('btnTestPs4Conn'),status=$('installDiscoverStatus');
    const ps4Ip=$('installPs4Ip').value.trim(),ps4Port=parseInt($('installPs4Port').value)||12800;
    if(!ps4Ip){toast('Enter the PS4/PS5 IP address first.','err');return;}
    if([2121,21,1337,9090].includes(ps4Port)){toast(`⚠ Port ${ps4Port} is an FTP port.`,'err');$('installPs4Port').value='12800';return;}
    btn.disabled=true; btn.textContent='⏳ Testing…'; status.style.display='block'; status.style.color=''; status.textContent=`Testing ${ps4Ip}:${ps4Port}…`;
    const result=await pkgApi.testPs4Conn(ps4Ip,ps4Port);
    btn.disabled=false; btn.textContent='🔌 Test Connection';
    if(result.ok){status.style.color='#4ade80';status.textContent=`✓ PS4 installer reachable at ${ps4Ip}:${ps4Port}`;$('installWarnBox').style.display='none';}
    else{status.style.color='#f87171';status.textContent=`✗ ${result.error}`;}
  });

  $('btnInstallStart').addEventListener('click',async()=>{
    const ps4Ip=$('installPs4Ip').value.trim(),ps4Port=parseInt($('installPs4Port').value)||12800,srvPort=parseInt($('installSrvPort').value)||8090;
    if(!ps4Ip){toast('Enter the PS4/PS5 IP address.','err');$('installPs4Ip').focus();return;}
    if([2121,21,1337,9090].includes(ps4Port)){toast(`⚠ Port ${ps4Port} is FTP.`,'err');$('installPs4Port').value='12800';return;}
    if([2121,21,9090,12800,1337].includes(srvPort)){toast(`⚠ Server port ${srvPort} conflicts.`,'err');$('installSrvPort').value='8090';return;}
    localStorage.setItem('ps4vault.installPs4Ip',ps4Ip); localStorage.setItem('ps4vault.installPs4Port',String(ps4Port));
    localStorage.setItem('ps4vault.installSrvPort',String(srvPort)); localStorage.setItem('ps4pkgvault.csHost',ps4Ip);
    const fps=JSON.parse(installBackdrop.dataset.items||'[]'),items=fps.map(fp=>allItems.find(i=>i.filePath===fp)).filter(Boolean);
    if(!items.length) return;
    installActive=true; $('btnInstallStart').disabled=true; $('btnInstallStart').textContent='⏳ Installing…';
    $('btnInstallCancel').textContent='Cancel'; $('btnInstallClose').style.display='none';
    $('installWarnBox').style.display=$('installSummary').style.display='none';
    $('installPhaseBar').style.display=$('installXferWrap').style.display='none';
    $('installElapsed').textContent=''; $('installXferBar').style.width='0%';
    items.forEach(item=>{const el=document.getElementById(`ii-${item.filePath}`);if(el)el.className='install-item';const st=document.getElementById(`ii-status-${item.filePath}`);if(st)st.textContent=item.isFtp?'⚠ FTP — will be skipped':'Queued…';const bw=document.getElementById(`ii-bar-wrap-${item.filePath}`);if(bw)bw.style.display='none';});
    pkgApi.offInstallProgress(); pkgApi.onInstallProgress(handleInstallProgress);
    pkgApi.remoteInstall(items, ps4Ip, ps4Port, srvPort, installDelay).catch(e=>{ // FIX 2: pass delay
      installActive=false; $('btnInstallStart').disabled=false; $('btnInstallStart').textContent='📡 Send to PS4 / PS5';
      $('btnInstallCancel').textContent='Close'; $('btnInstallClose').style.display='flex';
      toast('Install error: '+e.message,'err');
    });
  });

  // ── Install phase tracking ────────────────────────────────────────────────────
  let installStartTime=null,installElapsedTimer=null;
  let installXferSamples=[],installXferLastBytes=0,installXferLastTime=0,_installEwmaSpeed=0;

  function installSetPhase(label,detail,state){$('installPhaseBar').style.display='block';$('installPhaseLabel').textContent=label;$('installPhaseDetail').textContent=detail||'';$('installPhaseSpinner').className='phase-spinner'+(state==='done'?' done':state==='error'?' error':'');}
  function installStartElapsed(){installStartTime=Date.now();clearInterval(installElapsedTimer);installElapsedTimer=setInterval(()=>{if(!installActive){clearInterval(installElapsedTimer);return;}const sec=Math.floor((Date.now()-installStartTime)/1000),hh=Math.floor(sec/3600),mm=Math.floor((sec%3600)/60),ss=sec%60;const str=hh?`${hh}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`:`${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;const el=$('installElapsed');if(el)el.textContent=str;},1000);}
  function installStopElapsed(){clearInterval(installElapsedTimer);}
  function installResetXfer(){installXferSamples=[];installXferLastBytes=0;installXferLastTime=0;_installEwmaSpeed=0;}
  function installUpdateXfer(bytesSent,totalBytes,preCalcSpeed){
    if(preCalcSpeed>1024){_installEwmaSpeed=_installEwmaSpeed>0?0.3*preCalcSpeed+0.7*_installEwmaSpeed:preCalcSpeed;}
    const speed=_installEwmaSpeed,pct=totalBytes>0?Math.round(bytesSent/totalBytes*100):null,rem=totalBytes-bytesSent;
    const eta=speed>1024&&rem>0?Math.min(Math.round(rem/speed),86400):null;
    $('installXferWrap').style.display='block'; $('installXferBar').style.width=(pct??0)+'%';
    $('installXferSpeed').innerHTML=speed>0?`<span class="hi">${fmtSpeed(speed)}</span>`:'';
    $('installXferEta').innerHTML=eta!==null?`ETA <span class="hi">${fmtSec(eta)}</span>`:'';
    $('installXferBytes').innerHTML=totalBytes?`<span class="hi">${fmtSize(bytesSent)}</span> / <span style="color:var(--muted)">${fmtSize(totalBytes)}</span>`:'';
    return pct;
  }

  function handleInstallProgress(d){
    if(d.type==='install-connecting'){installStartElapsed();installSetPhase('Connecting…',`Reaching ${d.ps4Ip}:${d.ps4Port}`,'active');$('installDiscoverStatus').style.display='none';}
    else if(d.type==='install-ps4-unreachable'){installStopElapsed();installSetPhase('Connection failed',d.message.split('\n')[0],'error');$('installWarnBox').innerHTML=d.message.replace(/\n/g,'<br>');$('installWarnBox').style.display='block';$('btnInstallStart').disabled=false;$('btnInstallStart').textContent='📡 Send to PS4 / PS5';$('btnInstallCancel').textContent='Close';$('btnInstallClose').style.display='flex';installActive=false;}
    else if(d.type==='install-ps4-ok'){installSetPhase('Connected ✓',`${d.ps4Ip}:${d.ps4Port} — detecting installer…`,'active');}
    else if(d.type==='install-warn'){const msg=d.message||'';if(msg.startsWith('📡 Installer:'))installSetPhase('Connected ✓',msg,'active');else if(!msg.includes('Firewall')&&!msg.includes('port rule')){$('installWarnBox').innerHTML=msg.replace(/\n/g,'<br>');$('installWarnBox').style.display='block';}}
    else if(d.type==='install-server-ready'){installSetPhase('File server ready',`http://${d.localIp}:${d.serverPort}/ — waiting…`,'active');$('installLocalIp').textContent=d.localIp;$('installBaseUrl').textContent=`http://${d.localIp}:${d.serverPort}/`;$('installLocalIpBox').style.display='flex';}
    else if(d.type==='install-file-start'){installResetXfer();const el=findItemEl(d.file);if(el)el.className='install-item ii-active';setItemPhase(d.file,'sending');setItemStatus(d.file,'Sending install command…');installSetPhase('Sending command',d.title||d.file,'active');}
    else if(d.type==='install-file-queued'){setItemPhase(d.file,'dl');const tid=d.taskId!==null?` (task #${d.taskId})`:'';setItemStatus(d.file,`Command accepted${tid} — waiting for PS4/PS5…`);setItemBar(d.file,0,true);installSetPhase('Command accepted','Waiting for PS4/PS5 to connect…','active');}
    else if(d.type==='install-xfer-progress'){const pct=installUpdateXfer(d.bytesSent,d.totalBytes,d.speed);const speed=_installEwmaSpeed>0?fmtSpeed(_installEwmaSpeed):'',eta=d.eta!==null?fmtSec(d.eta):'',bytes=d.totalBytes?`${fmtSize(d.bytesSent)} / ${fmtSize(d.totalBytes)}`:'';setItemTitle(d.file,d.title||d.file);setItemPhase(d.file,'dl');setItemStatus(d.file,pct!==null?`Downloading — ${pct}%`:'Downloading…');setItemStats(d.file,speed,eta,bytes);if(pct!==null)setItemBar(d.file,pct,true);installSetPhase('PS4/PS5 downloading',[pct!==null?pct+'%':'',speed,eta?'ETA '+eta:'',bytes].filter(Boolean).join('  ·  '),'active');}
    else if(d.type==='install-task-progress'){const pct=d.percent??null,eta=d.rest?fmtSec(d.rest):'',bytes=d.transferred?fmtSize(d.transferred):'',status=(d.status&&d.status!=='null')?d.status:'';setItemPhase(d.file,'dl');setItemStatus(d.file,status||(pct!==null?`Installing — ${pct}%`:'Installing…'));setItemStats(d.file,'',eta,bytes);if(pct!==null)setItemBar(d.file,pct,true);}
    else if(d.type==='install-file-done'){const el=findItemEl(d.file);if(el)el.className='install-item ii-done';setItemPhase(d.file,'done');setItemStatus(d.file,'Install queued on PS4/PS5 — check console notifications');setItemStats(d.file,'','','');setItemBar(d.file,100,true);installSetPhase('Complete ✓','Check PS4/PS5 notifications','done');}
    else if(d.type==='install-file-error'){const el=findItemEl(d.file);if(el)el.className='install-item ii-error';setItemPhase(d.file,'error');setItemStatus(d.file,d.error||'Unknown error');installSetPhase('Failed',(d.error||'').split('\n')[0],'error');}
    else if(d.type==='install-done'){
      installStopElapsed(); installActive=false;
      $('btnInstallStart').disabled=false; $('btnInstallStart').textContent='📡 Send to PS4 / PS5 Again';
      $('btnInstallCancel').textContent='Close'; $('btnInstallClose').style.display='flex';
      const parts=[`${d.ok} sent`];if(d.failed)parts.push(`${d.failed} failed`);if(d.skipped)parts.push(`${d.skipped} skipped`);
      $('installSummary').textContent=parts.join(' · '); $('installSummary').style.display='block';
      if(d.failed===0&&d.ok>0)toast(`✅ ${d.ok} PKG${d.ok!==1?'s':''} sent to PS4/PS5!`);
      else if(d.ok===0)toast('Install failed — check the modal for details.','err');
    }
  }

  function findItemEl(fp){return document.getElementById(`ii-${fp}`)||[...($('installItemsList')?.querySelectorAll('.install-item')||[])].find(el=>el.querySelector('.ii-name')?.title?.includes(fp));}
  function setItemStatus(fp,text){const el=document.getElementById(`ii-status-${fp}`)||findItemEl(fp)?.querySelector('.ii-status');if(el)el.textContent=text;}
  function setItemTitle(fp,title){const el=findItemEl(fp)?.querySelector('.ii-name');if(el&&title)el.textContent=title;}
  function setItemPhase(fp,phase){const el=findItemEl(fp);if(!el)return;let badge=el.querySelector('.ii-phase');if(!badge){badge=document.createElement('span');badge.className='ii-phase';el.querySelector('.ii-name')?.prepend(badge);}const labels={wait:'Waiting',sending:'Sending',dl:'Downloading',done:'Done',error:'Failed'};badge.className=`ii-phase ii-phase-${phase}`;badge.textContent=labels[phase]||phase;}
  function setItemStats(fp,speed,eta,bytes){let el=findItemEl(fp)?.querySelector('.ii-stats');if(!el){const wrap=findItemEl(fp);if(wrap){el=document.createElement('div');el.className='ii-stats';wrap.querySelector('.ii-status')?.insertAdjacentElement('afterend',el);}}if(!el)return;const parts=[];if(speed)parts.push(`<span class="hi">${speed}</span>`);if(eta)parts.push(`ETA <span class="hi">${eta}</span>`);if(bytes)parts.push(`<span class="hi">${bytes}</span>`);el.innerHTML=parts.join('<span style="opacity:.3"> · </span>');}
  function setItemBar(fp,pct,show){const bw=document.getElementById(`ii-bar-wrap-${fp}`),b=document.getElementById(`ii-bar-${fp}`);if(bw)bw.style.display=show?'block':'none';if(b)b.style.width=pct+'%';}

  $('btnInstallCancel').addEventListener('click',closeInstallModal);
  $('btnInstallClose').addEventListener('click',closeInstallModal);
  installBackdrop.addEventListener('click',e=>{if(e.target===installBackdrop&&!installActive)closeInstallModal();});
  function closeInstallModal(){if(installActive){pkgApi.cancelOperation();installActive=false;$('btnInstallStart').disabled=false;$('btnInstallStart').textContent='📡 Send to PS4 / PS5';$('btnInstallCancel').textContent='Close';$('btnInstallClose').style.display='flex';installStopElapsed();installSetPhase('Cancelled','Install was cancelled','error');return;}installBackdrop.style.display='none';pkgApi.offInstallProgress();}

  // ── Context menu ──────────────────────────────────────────────────────────────
  const ctxMenu=$('ctxMenu');
  window.showCtxMenu=(x,y,fp)=>{ctxTarget=fp;ctxMenu.style.display='block';ctxMenu.style.left=Math.min(x,window.innerWidth-200)+'px';ctxMenu.style.top=Math.min(y,window.innerHeight-250)+'px';const item=allItems.find(i=>i.filePath===fp);if(item&&!selectedSet.has(fp)){selectedSet.clear();selectedSet.add(fp);viewMode==='grid'?renderGrid():renderTable();}};
  function hideCtxMenu(){ctxMenu.style.display='none';ctxTarget=null;}
  document.addEventListener('click',hideCtxMenu); ctxMenu.addEventListener('click',e=>e.stopPropagation());
  $('ctxInstall').addEventListener('click',()=>{if(!ctxTarget)return;hideCtxMenu();installOne(ctxTarget);});
  $('ctxShowFolder').addEventListener('click',()=>{if(!ctxTarget)return;hideCtxMenu();pkgApi.showInFolder(ctxTarget);});
  $('ctxCopyName').addEventListener('click',()=>{const item=ctxTarget&&allItems.find(i=>i.filePath===ctxTarget);if(item){pkgApi.copyToClipboard(item.fileName);toast('Filename copied');}hideCtxMenu();});
  $('ctxCopyId').addEventListener('click',()=>{const item=ctxTarget&&allItems.find(i=>i.filePath===ctxTarget);if(item&&item.titleId){pkgApi.copyToClipboard(item.titleId);toast('CUSA ID copied');}hideCtxMenu();});
  $('ctxRename').addEventListener('click',()=>{const item=ctxTarget&&allItems.find(i=>i.filePath===ctxTarget);if(item){hideCtxMenu();openRenameModal(item);}});
  $('ctxVerify').addEventListener('click',()=>{const fp=ctxTarget;hideCtxMenu();if(fp)verifyPkgItem(fp);}); // FIX 6
  $('ctxDelete').addEventListener('click',()=>{const fp=ctxTarget;hideCtxMenu();if(fp)deleteOne(fp);});

  // ── Feature 11: Keyboard shortcuts ───────────────────────────────────────────
  function openShortcuts(){ $('shortcutsBackdrop').style.display='flex'; }
  document.addEventListener('keydown',e=>{
    const tag=document.activeElement?.tagName,inInput=['INPUT','SELECT','TEXTAREA'].includes(tag);
    if((e.ctrlKey||e.metaKey)&&e.key==='a'&&!inInput){e.preventDefault();filteredItems.forEach(i=>selectedSet.add(i.filePath));renderTable();updateSelectionUI();return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='f'){e.preventDefault();$('searchInput').focus();$('searchInput').select();return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='/'){e.preventDefault();openShortcuts();return;}
    if(e.key==='?'&&!inInput){openShortcuts();return;}
    if(e.key==='Escape'&&!inInput){
      if($('shortcutsBackdrop').style.display==='flex'){$('shortcutsBackdrop').style.display='none';return;}
      if($('settingsBackdrop').style.display==='flex'){closeSettingsModal();return;}
      if(ctxMenu.style.display!=='none'){hideCtxMenu();return;}
      selectedSet.clear();renderTable();updateSelectionUI();return;
    }
    if((e.key==='Delete'||e.key==='Backspace')&&!inInput&&selectedSet.size>0){e.preventDefault();$('btnDeleteSelected').click();return;}
    if(e.key==='Enter'&&!inInput&&selectedSet.size>0){const sel=allItems.filter(i=>selectedSet.has(i.filePath)&&!i.isPartial);if(sel.length)openInstallModal(sel);}
  });

  // ── About modal ───────────────────────────────────────────────────────────────
  function openAboutModal(){const bl=$('brandLogo'),al=$('aboutLogo');if(bl&&al&&bl.src)al.src=bl.src;pkgApi.getLogPath().then(p=>{const el=$('aboutLogPath');if(el){el.textContent='📋 Log: '+p;el.title='Click to open log folder';}}).catch(()=>{});$('aboutModalBackdrop').style.display='flex';}
  function closeAboutModal(){$('aboutModalBackdrop').style.display='none';}
  $('btnAboutClose').addEventListener('click',closeAboutModal);
  $('btnAboutOk').addEventListener('click',closeAboutModal);
  $('btnAboutDiscord').addEventListener('click',()=>pkgApi.openExternal('https://discord.gg/nj45kDSBEd'));
  $('btnAboutViewLog').addEventListener('click',()=>pkgApi.openLog());
  $('aboutLogPath').addEventListener('click',()=>pkgApi.openLogFolder());
  $('aboutModalBackdrop').addEventListener('click',e=>{if(e.target===$('aboutModalBackdrop'))closeAboutModal();});

  // ── Auto-updater banner ───────────────────────────────────────────────────────
  let _pendingUpdateUrl = null;
  function showUpdateBanner(info) {
    const banner = $('updateBanner'), msg = $('updateMsg');
    if (!banner || !msg) return;
    _pendingUpdateUrl = info.downloadUrl;
    msg.innerHTML = `<strong>PS4 Vault v${info.latestVersion} available</strong> — you have v${info.currentVersion}`;
    $('btnUpdateDownload').style.display = 'inline-block';
    $('btnUpdateInstall').style.display  = 'none';
    $('updateProgress').textContent = '';
    banner.classList.add('show');
  }

  (function(){
    if (!pkgApi.onUpdateAvailable) return;

    pkgApi.onUpdateAvailable(showUpdateBanner);

    if (pkgApi.onUpdateDownloadProgress) {
      pkgApi.onUpdateDownloadProgress(({ pct, received, total }) => {
        const msg = $('updateMsg'), progress = $('updateProgress');
        if (msg) msg.innerHTML = '<strong>Downloading update…</strong>';
        if (progress) progress.textContent = `${pct}%  (${(received/1024/1024).toFixed(1)} / ${(total/1024/1024).toFixed(1)} MB)`;
        $('btnUpdateDownload').style.display = 'none';
        $('updateBanner').classList.add('show');
      });
    }

    const btnDl   = $('btnUpdateDownload');
    const btnDism = $('btnUpdateDismiss');

    if (btnDl) btnDl.addEventListener('click', async () => {
      if (!_pendingUpdateUrl) return;
      btnDl.disabled = true; btnDl.textContent = 'Downloading…';
      try {
        await pkgApi.downloadAndInstallUpdate(_pendingUpdateUrl);
        const msg = $('updateMsg');
        if (msg) msg.innerHTML = '<strong>Update downloaded — restarting…</strong>';
      } catch (e) {
        toast('Update failed: ' + (e.message || String(e)), 'err');
        btnDl.disabled = false; btnDl.textContent = '⬇ Download Update';
      }
    });

    if (btnDism) btnDism.addEventListener('click', () => $('updateBanner').classList.remove('show'));
  })();

  // ── Inject runtime CSS ────────────────────────────────────────────────────────
  const css=document.createElement('style');
  css.textContent=`.partial-badge{display:inline-block;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;letter-spacing:.04em;background:rgba(251,146,60,0.15);color:rgba(251,146,60,0.9);border:1px solid rgba(251,146,60,0.25);margin-left:4px;}.row-partial td{opacity:.8;}.row-partial .title-name{color:rgba(251,146,60,0.9)!important;}`;
  document.head.appendChild(css);

  // ── Init: load saved library + settings, then hide overlay ──────── Feature 19
  (async()=>{
    // Small delay so the splash screen paints and the progress bar animation
    // starts before the main thread gets busy loading the library.
    await new Promise(r => setTimeout(r, 120));
    try {
      setStartupMsg('Loading saved library…');
      const r = await pkgApi.loadLibrary?.();
      if (r?.ok && r.items?.length) {
        allItems = r.items;
        applyFilters(); updateCounts();
        setStartupMsg(`${r.items.length} items loaded`);

        // Background: stream covers back one-by-one as they're extracted
        // (items saved before icon-persistence fix have iconDataUrl: null)
        const missing = allItems
          .filter(i => !i.iconDataUrl && !i.isFtp && !i.isInstalled && i.filePath)
          .map(i => i.filePath);
        if (missing.length && pkgApi.refetchCovers) {
          setStartupMsg(`Recovering ${missing.length} cover${missing.length!==1?'s':''}…`);
          let coversDirty = false;

          // Listen for streamed cover-ready events — update each item as it arrives
          pkgApi.offCoverReady?.();
          pkgApi.onCoverReady?.(d => {
            if (d.filePath && d.iconDataUrl) {
              const item = allItems.find(x => x.filePath === d.filePath);
              if (item) { item.iconDataUrl = d.iconDataUrl; coversDirty = true; applyFiltersSoon(); }
            }
            if (d.progress) {
              setStartupMsg(`Covers: ${d.progress} / ${d.total}`);
            }
            if (d.done) {
              pkgApi.offCoverReady?.();
              setStartupMsg('');
              // Re-save library once with all covers populated
              if (coversDirty) pkgApi.saveLibrary?.(allItems).catch(() => {});
            }
          });

          // Fire-and-forget — returns immediately, results stream in via events
          pkgApi.refetchCovers(missing).catch(() => { pkgApi.offCoverReady?.(); });
        }
      }
    } catch(_) {}
    scanDepth    = settings.scanDepth    || 10;
    installDelay = settings.installDelay || 8000;
    ftpPool      = settings.ftpPool      || 3;
    if (settings.ftpPool) pkgApi.setSetting?.('ftpPool', settings.ftpPool);
    if(typeof updateFtpDestUI==='function') updateFtpDestUI();
    renderTable(); updateCounts();
    hideStartupOverlay();
  })();
})();
