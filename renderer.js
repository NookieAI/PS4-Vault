(function () {
  'use strict';

  // ── Storage keys ─────────────────────────────────────────────────────────────
  const K_LAST_SRC   = 'ps4pkgvault.lastSource';
  const K_LAST_DST   = 'ps4pkgvault.lastDest';
  const K_SETTINGS   = 'ps4pkgvault.settings';
  const K_RECENT_SRC = 'ps4pkgvault.recentSrc';
  const K_RECENT_DST = 'ps4pkgvault.recentDst';

  // ── State ─────────────────────────────────────────────────────────────────────
  let allItems      = [];
  let filteredItems = [];
  let selectedSet   = new Set();
  let sortBy        = 'title';
  let sortAsc       = true;
  let activeCat     = 'all';
  let searchText    = '';
  let renderPending = false;
  let viewMode      = 'table'; // 'table' | 'grid'
  let ctxTarget     = null;    // filePath of right-clicked item

  const $ = id => document.getElementById(id);

  // ── Settings ──────────────────────────────────────────────────────────────────
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem(K_SETTINGS) || '{}'); } catch {}
  function saveSetting(k, v) { settings[k] = v; localStorage.setItem(K_SETTINGS, JSON.stringify(settings)); }

  // ── Theme ─────────────────────────────────────────────────────────────────────
  function applyTheme(t) { document.body.dataset.theme = t; saveSetting('theme', t); }
  applyTheme(settings.theme || 'dark');
  $('madeBy').addEventListener('click', () =>
    applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'));

  // ── Recents ───────────────────────────────────────────────────────────────────
  const K_RECENT_FTP  = 'ps4pkgvault.recentFtp';
  function getRecent(k) { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } }
  function addRecent(k, v) {
    if (!v) return;
    const r = getRecent(k).filter(x => x !== v);
    r.unshift(v);
    localStorage.setItem(k, JSON.stringify(r.slice(0, 8)));
  }
  function refreshDatalist(dlId, k) {
    const dl = $(dlId); if (!dl) return;
    dl.innerHTML = '';
    getRecent(k).forEach(v => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); });
  }

  // Render recent path chips under an input
  function renderChips(containerId, storageKey, inputId) {
    const container = $(containerId); if (!container) return;
    const inp = $(inputId);
    const items = getRecent(storageKey);
    container.innerHTML = items.map(v => {
      const short = v.length > 38 ? '…' + v.slice(-36) : v;
      return `<button class="recent-chip" title="${escHtml(v)}" data-val="${escHtml(v)}">
        <span class="chip-icon">🕐</span>${escHtml(short)}
      </button>`;
    }).join('');
    container.querySelectorAll('.recent-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        if (inp) { inp.value = btn.dataset.val; inp.dispatchEvent(new Event('input')); }
      });
    });
  }

  function refreshAll() {
    refreshDatalist('sourceHistory', K_RECENT_SRC);
    refreshDatalist('destHistory',   K_RECENT_DST);
    renderChips('recentSrcChips', K_RECENT_SRC, 'sourcePath');
    renderChips('recentDstChips', K_RECENT_DST, 'destPath');
    // FTP recent hosts datalist
    const ftpDl = $('ftpHostHistory'); if (ftpDl) {
      ftpDl.innerHTML = '';
      getRecent(K_RECENT_FTP).forEach(v => {
        const o = document.createElement('option'); o.value = v; ftpDl.appendChild(o);
      });
    }
  }

  // ── Category / region helpers ─────────────────────────────────────────────────
  function categoryDisplay(cat) {
    const c = (cat || '').toLowerCase().trim();
    if (['gd','gde','gda','gdc','hg'].includes(c)) return 'Game';
    if (c === 'gp')              return 'Patch';
    if (c === 'ac')              return 'DLC';
    if (c === 'theme')           return 'Theme';
    if (c === 'app' || c === 'ap') return 'App';
    return c ? c.toUpperCase() : 'Other';
  }

  function regionDisplay(r) {
    const map = { UP: 'USA', EP: 'EUR', JP: 'JPN', HP: 'ASIA', KP: 'KOR', IP: 'INT' };
    return map[r] || r || '—';
  }

  function categoryColor(cat) {
    const d = categoryDisplay(cat);
    if (d === 'Game')  return 'cat-game';
    if (d === 'Patch') return 'cat-patch';
    if (d === 'DLC')   return 'cat-dlc';
    if (d === 'Theme') return 'cat-theme';
    if (d === 'App')   return 'cat-app';
    return 'cat-other';
  }

  function regionColor(r) {
    const d = regionDisplay(r);
    if (d === 'USA')  return 'reg-us';
    if (d === 'EUR')  return 'reg-eu';
    if (d === 'JPN')  return 'reg-jp';
    if (d === 'ASIA') return 'reg-asia';
    return 'reg-other';
  }

  function fmtSize(n) {
    if (!n) return '—';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + ' TB';
    if (n >= 1e9)  return (n / 1e9).toFixed(2)  + ' GB';
    if (n >= 1e6)  return (n / 1e6).toFixed(1)  + ' MB';
    if (n >= 1e3)  return (n / 1e3).toFixed(0)  + ' KB';
    return n + ' B';
  }

  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  // escAttr: safe for HTML attribute values (data-fp, title, etc.)
  function escAttr(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  }
  // escJs: safe for JS string literals inside inline onclick="fn('VALUE')"
  // Backslashes MUST be doubled, single-quotes MUST be escaped.
  // Windows paths like C:\Users\foo break without this.
  function escJs(s) {
    return String(s ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  }
  window.escHtml = escHtml;

  // ── Filter + sort ─────────────────────────────────────────────────────────────
  function applyFilters() {
    const s = searchText.toLowerCase();
    filteredItems = allItems.filter(item => {
      const d = categoryDisplay(item.category);
      if (activeCat !== 'all' && d !== activeCat) return false;
    if (s && !(item.title      || '').toLowerCase().includes(s) &&
             !(item.sfoTitle  || '').toLowerCase().includes(s) &&
             !(item.fnTitle   || '').toLowerCase().includes(s) &&
             !(item.titleId   || '').toLowerCase().includes(s) &&
             !(item.fileName  || '').toLowerCase().includes(s)) return false;
      return true;
    });
    sortItems();
    renderTable();
    updateCounts();
  }

  function applyFiltersSoon() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; applyFilters(); });
  }

  function sortItems() {
    filteredItems.sort((a, b) => {
      let av, bv;
      switch (sortBy) {
        case 'size':     av = a.fileSize || 0; bv = b.fileSize || 0; break;
        case 'titleId':  av = a.titleId  || ''; bv = b.titleId  || ''; break;
        case 'category': av = categoryDisplay(a.category); bv = categoryDisplay(b.category); break;
        case 'version':  av = a.appVer   || ''; bv = b.appVer   || ''; break;
        case 'region':   av = regionDisplay(a.region); bv = regionDisplay(b.region); break;
        default:         av = a.title    || ''; bv = b.title    || '';
      }
      if (typeof av === 'number') return sortAsc ? av - bv : bv - av;
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }

  // ── Placeholder SVG for PKGs without an extractable cover ────────────────────
  function makePlaceholderSvg() {
    return `<svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="72" height="72" rx="8" fill="rgba(255,255,255,0.03)"/>
      <rect x="14" y="18" width="44" height="5" rx="2.5" fill="rgba(255,255,255,0.1)"/>
      <rect x="14" y="28" width="32" height="4" rx="2" fill="rgba(255,255,255,0.06)"/>
      <rect x="14" y="36" width="38" height="4" rx="2" fill="rgba(255,255,255,0.06)"/>
      <rect x="14" y="44" width="24" height="4" rx="2" fill="rgba(255,255,255,0.04)"/>
      <text x="36" y="64" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.16)"
            font-family="ui-monospace,monospace" font-weight="600" letter-spacing="1">PKG</text>
    </svg>`;
  }

  // ── Table rendering ───────────────────────────────────────────────────────────
  const tbody = $('resultsBody');

  function renderTable() {
    if (viewMode === 'grid') { renderGrid(); updateStats(); return; }
    if (filteredItems.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-cell">
        ${allItems.length === 0
          ? 'No scan performed yet. Choose a source folder and click SCAN.'
          : 'No PKGs match the current filter.'
        }
      </td></tr>`;
      updateStats(); return;
    }

    const rows = filteredItems.map(item => {
      const checked  = selectedSet.has(item.filePath);
      const catDisp  = categoryDisplay(item.category);
      const catCls   = categoryColor(item.category);
      const regDisp  = regionDisplay(item.region);
      const regCls   = regionColor(item.region);

      // ── Cover thumbnail ──────────────────────────────────────────────────────
      // PS4-style: actual game cover on left, placeholder SVG if no icon extracted
      const iconHtml = item.iconDataUrl
        ? `<img class="thumb" src="${item.iconDataUrl}" alt="cover"
               loading="eager"
               onmouseover="showPreview(event,this.src)"
               onmouseout="hidePreview()">`
        : makePlaceholderSvg();

      // ── Title cell ───────────────────────────────────────────────────────────
      // Priority: SFO game name (from param.sfo inside PKG) → filename hint → CUSA ID
      // sfoTitle = raw extracted SFO TITLE field (most authoritative)
      // fnTitle  = name guessed from filename scene conventions
      const sfoTitle = item.sfoTitle || '';
      const fnTitle  = item.fnTitle  || '';

      // displayName: always prefer SFO title → filename guess → CUSA → raw filename
      let displayName;
      let titleQuality; // for subtle visual indicator
      if (sfoTitle) {
        displayName  = escHtml(sfoTitle);
        titleQuality = 'title-from-sfo';
      } else if (fnTitle) {
        displayName  = escHtml(fnTitle);
        titleQuality = 'title-from-fn';
      } else if (item.titleId) {
        displayName  = escHtml(item.titleId);
        titleQuality = 'title-fallback';
      } else {
        displayName  = escHtml(item.fileName || '—');
        titleQuality = 'title-fallback';
      }

      // CUSA ID — always shown beneath game name when we have one
      const cusaLine = item.titleId
        ? `<div class="title-cusa">${escHtml(item.titleId)}</div>`
        : '';

      // Full path — shown as third line in muted monospace
      const pathLine = item.dirPath
        ? `<div class="title-path" title="${escHtml(item.filePath)}">${escHtml(item.dirPath)}</div>`
        : '';

      const dupBadge = item.isDuplicate
        ? ` <span class="dup-badge" title="Duplicate content ID">DUP</span>` : '';
      const ftpBadge = item.isFtp
        ? ` <span class="ftp-badge" title="FTP source">FTP</span>` : '';

      const safeFn   = escHtml(item.fileName);
      const safePath = escHtml(item.filePath);

      return `<tr class="${checked ? 'row-selected' : ''}" data-fp="${escAttr(item.filePath)}">
        <td class="check">
          <input type="checkbox" ${checked ? 'checked' : ''} data-fp="${escAttr(item.filePath)}" />
        </td>
        <td class="cover">
          <div class="icon-wrap">${iconHtml}</div>
        </td>
        <td class="title-cell">
          <div class="title-main">
            <span class="title-name ${titleQuality}">${displayName}</span>${dupBadge}${ftpBadge}
          </div>
          ${cusaLine}
          ${pathLine}
          <div class="title-sub pkg-filename" title="${safePath}"
               onclick="startRenameInline(event,'${escJs(item.filePath)}')">${safeFn}</div>
        </td>
        <td><span class="cat-badge ${catCls}">${catDisp}</span></td>
        <td class="mono-col">${escHtml(item.appVer || '—')}</td>
        <td><span class="reg-badge ${regCls}">${regDisp}</span></td>
        <td class="mono-col">${escHtml(item.sysVer || '—')}</td>
        <td class="size">${fmtSize(item.fileSize)}</td>
        <td class="acts">
          <button class="row-btn" title="Show in folder"
            onclick="pkgApi.showInFolder('${escJs(item.filePath)}')">📂</button>
          <button class="row-btn" title="Copy filename"
            onclick="pkgApi.copyToClipboard('${escJs(item.fileName)}')">📋</button>
          <button class="row-btn row-btn--install" title="Install to PS4 remotely"
            onclick="installOne('${escJs(item.filePath)}')">📡</button>
          <button class="row-btn row-btn--danger" title="Delete this PKG"
            onclick="deleteOne('${escJs(item.filePath)}')">🗑</button>
        </td>
      </tr>`;
    });
    tbody.innerHTML = rows.join('');

    tbody.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', e => {
        const fp = e.target.dataset.fp;
        if (e.target.checked) selectedSet.add(fp); else selectedSet.delete(fp);
        e.target.closest('tr').classList.toggle('row-selected', e.target.checked);
        updateSelectionUI();
      });
    });

    // Double-click row → open install modal
    tbody.querySelectorAll('tr[data-fp]').forEach(tr => {
      tr.addEventListener('dblclick', () => {
        const item = allItems.find(i => i.filePath === tr.dataset.fp);
        if (item) openInstallModal([item]);
      });
      tr.addEventListener('contextmenu', e => {
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, tr.dataset.fp);
      });
    });

    updateStats();
  }

  // ── Grid rendering ────────────────────────────────────────────────────────────
  function renderGrid() {
    const grid = $('gridBody');
    if (!grid) return;
    if (filteredItems.length === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1;color:var(--muted);padding:32px;text-align:center;font-size:13px;">
        ${allItems.length === 0 ? 'No scan performed yet.' : 'No PKGs match the current filter.'}
      </div>`;
      updateStats(); return;
    }
    grid.innerHTML = filteredItems.map(item => {
      const sel = selectedSet.has(item.filePath);
      const sfoTitle = item.sfoTitle || item.fnTitle || item.titleId || item.fileName;
      const catDisp  = categoryDisplay(item.category);
      const catCls   = categoryColor(item.category);
      const coverHtml = item.iconDataUrl
        ? `<img src="${item.iconDataUrl}" alt="cover" loading="eager" onmouseover="showPreview(event,this.src)" onmouseout="hidePreview()">`
        : makePlaceholderSvg();
      return `<div class="grid-card${sel ? ' selected' : ''}" data-fp="${escAttr(item.filePath)}"
                   oncontextmenu="event.preventDefault();showCtxMenu(event.clientX,event.clientY,'${escJs(item.filePath)}')">
        <div class="gc-check"></div>
        <div class="gc-cover">${coverHtml}</div>
        <div class="gc-body">
          <div class="gc-title" title="${escHtml(sfoTitle)}">${escHtml(sfoTitle)}</div>
          <div class="gc-sub">${escHtml(item.titleId || '—')}</div>
          <div class="gc-badge-row">
            <span class="cat-badge ${catCls}" style="font-size:9.5px;padding:1px 5px">${catDisp}</span>
            ${item.appVer ? `<span style="font-size:9.5px;color:var(--muted);font-family:ui-monospace,monospace">v${escHtml(item.appVer)}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.grid-card').forEach(card => {
    let clickTimer = null;
    card.addEventListener('click', e => {
      if (e.target.closest('.gc-check')) return;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        const fp = card.dataset.fp;
        if (selectedSet.has(fp)) selectedSet.delete(fp);
        else selectedSet.add(fp);
        card.classList.toggle('selected', selectedSet.has(fp));
        updateSelectionUI();
      }, 200); // wait 200ms — if dblclick fires it cancels this
    });
    card.addEventListener('dblclick', e => {
      clearTimeout(clickTimer); // cancel the pending single-click
      installOne(card.dataset.fp);
    });
    card.querySelector('.gc-check')?.addEventListener('click', e => {
      e.stopPropagation();
      clearTimeout(clickTimer);
      const fp = card.dataset.fp;
      if (selectedSet.has(fp)) selectedSet.delete(fp);
      else selectedSet.add(fp);
      card.classList.toggle('selected', selectedSet.has(fp));
      updateSelectionUI();
    });
    });
    updateStats();
  }

  // ── Image preview popup ───────────────────────────────────────────────────────
  const preview = $('imgPreview');
  window.showPreview = (e, src) => {
    if (!src) return;
    preview.querySelector('img').src = src;
    preview.style.display = 'block';
    positionPreview(e);
  };
  window.hidePreview = () => { preview.style.display = 'none'; };
  document.addEventListener('mousemove', e => {
    if (preview.style.display === 'block') positionPreview(e);
  });
  function positionPreview(e) {
    const pw = preview.offsetWidth  || 220;
    const ph = preview.offsetHeight || 220;
    let x = e.clientX + 16, y = e.clientY + 16;
    if (x + pw > window.innerWidth)  x = e.clientX - pw - 8;
    if (y + ph > window.innerHeight) y = e.clientY - ph - 8;
    preview.style.left = x + 'px';
    preview.style.top  = y + 'px';
  }

  // ── Counts + selection UI ─────────────────────────────────────────────────────
  function updateCounts() {
    const total   = allItems.length;
    const shown   = filteredItems.length;
    const dupes   = allItems.filter(i => i.isDuplicate).length;
    const totalSz = allItems.reduce((s, i) => s + (i.fileSize || 0), 0);

    $('scanCount').textContent = total
      ? `${shown}${shown !== total ? ' / ' + total : ''} PKGs  ·  ${fmtSize(totalSz)}${dupes ? `  ·  ⚠ ${dupes} dupes` : ''}`
      : '';

    ['all','Game','Patch','DLC','App','Theme','Other'].forEach(c => {
      const btn = $(c === 'all' ? 'catAll' : 'cat' + c);
      if (!btn) return;
      const n = c === 'all' ? allItems.length
        : allItems.filter(i => categoryDisplay(i.category) === c).length;
      btn.querySelector('.cat-count').textContent = n;
    });

    updateSelectionUI();
  }

  function updateSelectionUI() {
    const n = selectedSet.size;
    $('selectedCount').textContent = n ? `${n} selected` : '';
    $('btnDeleteSelected').disabled  = n === 0;
    $('btnRenameSelected').disabled  = n === 0;
    $('btnGoSelected').disabled      = n === 0;
    $('btnInstallSelected').disabled = n === 0;
    $('chkHeader').indeterminate = n > 0 && n < filteredItems.length;
    $('chkHeader').checked       = filteredItems.length > 0 && n === filteredItems.length;
  }

  // ── Stats bar ─────────────────────────────────────────────────────────────────
  function updateStats() {
    const games   = allItems.filter(i => categoryDisplay(i.category) === 'Game').length;
    const patches = allItems.filter(i => categoryDisplay(i.category) === 'Patch').length;
    const dlc     = allItems.filter(i => categoryDisplay(i.category) === 'DLC').length;
    const totalSz = allItems.reduce((s, i) => s + (i.fileSize || 0), 0);

    // FW range
    const fws = allItems.map(i => i.sysVer).filter(v => v && /^\d+\.\d+$/.test(v))
      .map(v => parseFloat(v)).sort((a,b) => a-b);
    const fwRange = fws.length
      ? fws[0] === fws[fws.length-1]
        ? `FW ${fws[0].toFixed(2)}`
        : `FW ${fws[0].toFixed(2)} – ${fws[fws.length-1].toFixed(2)}`
      : '';

    $('statGames').textContent   = games   ? `${games} Game${games!==1?'s':''}` : '';
    $('statPatches').textContent = patches ? `${patches} Patch${patches!==1?'es':''}` : '';
    $('statDlc').textContent     = dlc     ? `${dlc} DLC` : '';
    $('statSize').textContent    = totalSz ? fmtSize(totalSz) + ' total' : '';
    $('statFw').textContent      = fwRange;
    if ($('statFwSep')) $('statFwSep').style.display = fwRange ? '' : 'none';

    // Hide separators if adjacent item is empty
    document.querySelectorAll('.stat-sep').forEach(sep => {
      const prev = sep.previousElementSibling;
      const next = sep.nextElementSibling;
      const hide = (!prev || !prev.textContent.trim()) || (!next || !next.textContent.trim());
      sep.style.display = hide ? 'none' : '';
    });
  }

  // ── Header checkbox ───────────────────────────────────────────────────────────
  $('chkHeader').addEventListener('change', e => {
    if (e.target.checked) filteredItems.forEach(i => selectedSet.add(i.filePath));
    else                  filteredItems.forEach(i => selectedSet.delete(i.filePath));
    renderTable();
    updateSelectionUI();
  });

  // ── Column sorting ────────────────────────────────────────────────────────────
  document.querySelectorAll('thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (sortBy === col) sortAsc = !sortAsc; else { sortBy = col; sortAsc = true; }
      document.querySelectorAll('thead th[data-sort]').forEach(t => t.classList.remove('sort-asc','sort-desc'));
      th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
      applyFilters();
    });
  });

  // ── Category filter tabs ──────────────────────────────────────────────────────
  document.querySelectorAll('.cat-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeCat = btn.dataset.cat;
      selectedSet.clear();
      applyFilters();
    });
  });

  // ── Search ────────────────────────────────────────────────────────────────────
  $('searchInput').addEventListener('input', e => {
    searchText = e.target.value;
    selectedSet.clear();
    applyFilters();
  });

  // ── Source / dest path ────────────────────────────────────────────────────────
  const srcInput = $('sourcePath');
  const dstInput = $('destPath');
  srcInput.value = localStorage.getItem(K_LAST_SRC) || '';
  dstInput.value = localStorage.getItem(K_LAST_DST) || '';
  refreshAll();

  $('btnPickSource').addEventListener('click', async () => {
    const p = await pkgApi.openDirectory();
    if (p) { srcInput.value = p; addRecent(K_RECENT_SRC, p); refreshAll(); }
  });
  $('btnPickDest').addEventListener('click', async () => {
    const p = await pkgApi.openDirectory();
    if (p) { dstInput.value = p; addRecent(K_RECENT_DST, p); refreshAll(); }
  });
  $('btnClearSource').addEventListener('click', () => { srcInput.value = ''; srcInput.focus(); });
  $('btnClearDest').addEventListener('click',   () => { dstInput.value = ''; dstInput.focus(); });

  $('btnScanAllDrives').addEventListener('click', async () => {
    const drives = await pkgApi.getAllDrives();
    if (!drives || drives.length === 0) {
      toast('No drives detected.', 'err');
      return;
    }
    srcInput.value = drives.join(', ');
    toast(`Found ${drives.length} drive${drives.length !== 1 ? 's' : ''}: ${drives.join(', ')} — scanning…`);
    startScan(drives, false);
  });

  // ── Scan ──────────────────────────────────────────────────────────────────────
  $('btnScan').addEventListener('click', () => {
    const src = srcInput.value.trim();
    if (!src) { toast('Choose a source folder first.', 'err'); return; }
    localStorage.setItem(K_LAST_SRC, src);
    addRecent(K_RECENT_SRC, src);
    refreshAll();
    startScan([src], false);
  });

  // ── FTP Scan ──────────────────────────────────────────────────────────────────
  function openFtpModal() {
    $('ftpHost').value  = localStorage.getItem('ps4pkgvault.ftpHost') || '';
    $('ftpPort').value  = localStorage.getItem('ps4pkgvault.ftpPort') || '21';
    $('ftpUser').value  = localStorage.getItem('ps4pkgvault.ftpUser') || 'anonymous';
    $('ftpPass').value  = localStorage.getItem('ps4pkgvault.ftpPass') || '';
    $('ftpPath').value  = localStorage.getItem('ps4pkgvault.ftpPath') || '/';
    $('ftpStatus').textContent = '';
    $('ftpStatus').style.color = '';
    refreshAll(); // refreshes ftpHostHistory datalist
    $('ftpModalBackdrop').style.display = 'flex';
    setTimeout(() => $('ftpHost').focus(), 80);
  }

  $('btnFtpScan').addEventListener('click', openFtpModal);
  $('btnFtpCancel').addEventListener('click', () => { $('ftpModalBackdrop').style.display = 'none'; });
  $('btnFtpClose').addEventListener('click',  () => { $('ftpModalBackdrop').style.display = 'none'; });
  $('ftpModalBackdrop').addEventListener('click', e => {
    if (e.target === $('ftpModalBackdrop')) $('ftpModalBackdrop').style.display = 'none';
  });

  $('btnFtpConnect').addEventListener('click', async () => {
    const cfg = ftpCfgFromForm();
    if (!cfg.host) { toast('Enter an FTP host.', 'err'); return; }
    $('ftpStatus').textContent = 'Testing connection…';
    $('ftpStatus').style.color = '';
    const res = await pkgApi.ftpTestConn(cfg);
    if (res.ok) {
      $('ftpStatus').textContent = `✓ Connected — ${res.entries} entries found at ${cfg.path}`;
      $('ftpStatus').style.color = '#4ade80';
    } else {
      $('ftpStatus').textContent = '✗ Failed: ' + res.error;
      $('ftpStatus').style.color = '#f87171';
    }
  });

  $('btnFtpScanStart').addEventListener('click', async () => {
    const cfg = ftpCfgFromForm();
    if (!cfg.host) { toast('Enter an FTP host.', 'err'); return; }
    localStorage.setItem('ps4pkgvault.ftpHost', cfg.host);
    localStorage.setItem('ps4pkgvault.ftpPort', cfg.port);
    localStorage.setItem('ps4pkgvault.ftpUser', cfg.user);
    localStorage.setItem('ps4pkgvault.ftpPass', cfg.pass);
    localStorage.setItem('ps4pkgvault.ftpPath', cfg.path);
    // Remember last PS4 IP (used by Scan PS4 quick button)
    if (cfg.port === '2121') localStorage.setItem('ps4pkgvault.lastPs4Ip', cfg.host);
    addRecent(K_RECENT_FTP, cfg.host);
    refreshAll();
    $('ftpModalBackdrop').style.display = 'none';
    startScan([cfg], true);
  });

  function ftpCfgFromForm() {
    return {
      host: $('ftpHost').value.trim(),
      port: $('ftpPort').value.trim() || '21',
      user: $('ftpUser').value.trim() || 'anonymous',
      pass: $('ftpPass').value,
      path: $('ftpPath').value.trim() || '/',
    };
  }

  $('btnCancelScan').addEventListener('click', () => {
    pkgApi.cancelOperation();
    setScanUI(false);
    toast('Scan cancelled.');
  });

  // ── View toggle (table ↔ grid) ────────────────────────────────────────────────
  viewMode = settings.viewMode || 'table';
  function applyViewMode() {
    const isGrid = viewMode === 'grid';
    $('tableView').style.display = isGrid ? 'none' : '';
    $('gridView').style.display  = isGrid ? ''     : 'none';
    $('btnViewToggle').textContent = isGrid ? '☰ Table' : '⊞ Grid';
    $('btnViewToggle').classList.toggle('active', isGrid);
    renderTable();
  }
  $('btnViewToggle').addEventListener('click', () => {
    viewMode = viewMode === 'table' ? 'grid' : 'table';
    saveSetting('viewMode', viewMode);
    applyViewMode();
  });
  applyViewMode();

  // ── Scan PS4 via FTP ─────────────────────────────────────────────────────────
  // Opens FTP modal pre-filled with PS4 defaults: port 2121, anonymous, path /
  $('btnScanPs4').addEventListener('click', () => {
    $('ftpHost').value  = localStorage.getItem('ps4pkgvault.lastPs4Ip') || '';
    $('ftpPort').value  = '2121';
    $('ftpUser').value  = 'anonymous';
    $('ftpPass').value  = '';
    $('ftpPath').value  = '/';
    $('ftpStatus').textContent = 'PS4 FTP defaults loaded — enter your PS4 IP and click Scan PKGs.';
    $('ftpStatus').style.color = 'var(--accent-2)';
    refreshAll();
    $('ftpModalBackdrop').style.display = 'flex';
    setTimeout(() => { $('ftpHost').focus(); $('ftpHost').select(); }, 80);
  });

  // ── Main scan orchestrator ────────────────────────────────────────────────────
  let lastScanErrorMsg = null;

  async function startScan(dirs, isFtp) {
    allItems      = [];
    filteredItems = [];
    selectedSet.clear();
    renderTable();
    updateCounts();
    setScanUI(true);

    const skippedDrives = [];

    pkgApi.offScanProgress();
    pkgApi.onScanProgress(handleScanProgress);

    for (const dir of dirs) {
      lastScanErrorMsg = null;
      let returned;
      if (isFtp) {
        returned = await pkgApi.ftpScanPkgs(dir);
      } else {
        returned = await pkgApi.scanPkgs(typeof dir === 'string' ? dir.trim() : dir);
      }
      if (Array.isArray(returned) && returned.length > 0) {
        const existingPaths = new Set(allItems.map(i => i.filePath));
        returned.forEach(item => {
          if (!existingPaths.has(item.filePath)) allItems.push(item);
        });
      } else if (lastScanErrorMsg) {
        // Drive was inaccessible — already toasted via handleScanProgress
        skippedDrives.push(typeof dir === 'string' ? dir : (dir.host || '?'));
      }
    }

    applyFilters();
    updateCounts();
    setScanUI(false);

    let summary = `Scan complete — ${allItems.length} PKG${allItems.length !== 1 ? 's' : ''} found`;
    if (skippedDrives.length) summary += ` · ${skippedDrives.length} drive${skippedDrives.length > 1 ? 's' : ''} skipped`;
    toast(summary + '.');
  }

  function handleScanProgress(d) {
    if (d.type === 'scan-start' || d.type === 'scan-discovering') {
      $('currentScanLabel').textContent = 'Discovering .pkg files…';
    } else if (d.type === 'scan-found') {
      $('currentScanLabel').textContent =
        `Found ${d.total} PKG${d.total !== 1 ? 's' : ''}. Parsing headers…`;
    } else if (d.type === 'scan-parsing') {
      $('currentScanLabel').textContent = `Parsing ${d.done} / ${d.total}  ·  ${d.file}`;
    } else if (d.type === 'scan-result') {
      const alreadyHave = allItems.some(i => i.filePath === d.item.filePath);
      if (!alreadyHave) {
        allItems.push(d.item);
        $('currentScanLabel').textContent = `Parsing… ${allItems.length} found so far`;
        applyFiltersSoon();
      }
    } else if (d.type === 'scan-done') {
      $('currentScanLabel').textContent = `Done — ${d.total} PKG${d.total !== 1 ? 's' : ''} from this source`;
    } else if (d.type === 'scan-error') {
      lastScanErrorMsg = d.message;
      toast('⚠ ' + d.message, 'err');
    }
  }

  function setScanUI(active) {
    $('btnScan').disabled          = active;
    $('btnScanAllDrives').disabled = active;
    $('btnFtpScan').disabled       = active;
    $('btnScanPs4').disabled       = active;
    $('btnCancelScan').style.display = active ? 'inline-flex' : 'none';
    $('scanDisplay').style.display   = active ? 'flex'        : 'none';
  }

  // ── Delete ────────────────────────────────────────────────────────────────────
  window.deleteOne = async (fp) => {
    const item = allItems.find(i => i.filePath === fp);
    if (!item) return;
    if (!confirm(`Delete ${item.fileName}?\n\nThis cannot be undone.`)) return;
    const results = await pkgApi.deletePkgs([item]);
    if (results[0]?.ok) {
      allItems = allItems.filter(i => i.filePath !== fp);
      selectedSet.delete(fp);
      applyFilters();
      toast(`Deleted ${item.fileName}`);
    } else {
      toast('Delete failed: ' + results[0]?.error, 'err');
    }
  };

  $('btnDeleteSelected').addEventListener('click', async () => {
    const sel = allItems.filter(i => selectedSet.has(i.filePath));
    if (sel.length === 0) return;
    if (!confirm(`Delete ${sel.length} PKG file${sel.length > 1 ? 's' : ''}?\n\nThis cannot be undone.`)) return;
    const results = await pkgApi.deletePkgs(sel);
    const ok   = results.filter(r => r.ok);
    const errs = results.filter(r => !r.ok);
    ok.forEach(r => { allItems = allItems.filter(i => i.filePath !== r.filePath); selectedSet.delete(r.filePath); });
    applyFilters();
    toast(`Deleted ${ok.length}${errs.length ? `, ${errs.length} failed` : ''}`);
  });

  // ── Rename modal ──────────────────────────────────────────────────────────────
  const renameBackdrop = $('renameModalBackdrop');
  const renamePreview  = $('renamePreview');
  const renameInput    = $('renameInput');
  const renamePreset   = $('renamePreset');
  let   renameTarget   = null;

  const RENAME_PRESETS = [
    { label: 'ID - Title [vVER] [CAT]',    fmt: '{TITLE_ID} - {TITLE} [v{VERSION}] [{CATEGORY}]' },
    { label: '[REGION] ID - Title (VER)',   fmt: '[{REGION}] {TITLE_ID} - {TITLE} ({VERSION})' },
    { label: 'Title [ID] [REGION] vVER',   fmt: '{TITLE} [{TITLE_ID}] [{REGION}] v{VERSION}' },
    { label: 'ID_VER_REGION (short)',       fmt: '{TITLE_ID}_{VERSION}_{REGION}' },
    { label: 'Custom…',                     fmt: '' },
  ];

  function populateRenamePresets() {
    renamePreset.innerHTML = '';
    RENAME_PRESETS.forEach(p => {
      const o = document.createElement('option');
      o.value = p.fmt; o.textContent = p.label;
      renamePreset.appendChild(o);
    });
  }
  populateRenamePresets();

  function openRenameModal(item) {
    renameTarget = item;
    const fmt = RENAME_PRESETS[0].fmt;
    renamePreset.value = fmt;
    renameInput.value  = item ? applyRenameFormat(fmt, item) : fmt;
    updateRenamePreview();
    renameBackdrop.style.display = 'flex';
    setTimeout(() => renameInput.focus(), 50);
  }

  function updateRenamePreview() {
    const val = renameInput.value.trim();
    if (renameTarget) {
      renamePreview.textContent = val.endsWith('.pkg') ? val : val + '.pkg';
    } else {
      const sample = allItems.find(i => selectedSet.has(i.filePath));
      if (sample) {
        renamePreview.textContent = applyRenameFormat(val, sample) + '.pkg' +
          (selectedSet.size > 1 ? `  (+${selectedSet.size - 1} more)` : '');
      } else {
        renamePreview.textContent = val;
      }
    }
  }

  function applyRenameFormat(fmt, item) {
    const cat = categoryDisplay(item.category);
    const reg = regionDisplay(item.region);
    return fmt
      .replace(/{TITLE_ID}/g,   san4(item.titleId   || 'UNKNOWN'))
      .replace(/{TITLE}/g,      san4(item.title     || 'Unknown'))
      .replace(/{VERSION}/g,    san4(item.appVer    || '00.00'))
      .replace(/{CATEGORY}/g,   san4(cat))
      .replace(/{REGION}/g,     san4(reg))
      .replace(/{CONTENT_ID}/g, san4(item.contentId || ''))
      .replace(/{REQ_FW}/g,     san4(item.sysVer    || ''))
      .trim();
  }

  function san4(s) {
    return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim();
  }

  renamePreset.addEventListener('change', () => {
    const fmt = renamePreset.value;
    if (fmt !== '') renameInput.value = renameTarget ? applyRenameFormat(fmt, renameTarget) : fmt;
    updateRenamePreview();
  });
  renameInput.addEventListener('input', updateRenamePreview);
  renameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btnRenameApply').click();
    if (e.key === 'Escape') closeRenameModal();
  });

  $('btnRenameApply').addEventListener('click', async () => {
    const val = renameInput.value.trim();
    if (!val) return;

    if (renameTarget) {
      const newName = val.endsWith('.pkg') ? val : val + '.pkg';
      const res = await pkgApi.renamePkg(renameTarget, newName);
      if (res.error) { toast('Rename failed: ' + res.error, 'err'); return; }
      renameTarget.filePath = res.newPath;
      renameTarget.fileName = res.newFileName;
      closeRenameModal();
      renderTable();
      toast(`Renamed to ${res.newFileName}`);
    } else {
      const sel = allItems.filter(i => selectedSet.has(i.filePath));
      let ok = 0, fail = 0;
      for (const item of sel) {
        const newName = applyRenameFormat(val, item) + '.pkg';
        const res = await pkgApi.renamePkg(item, newName);
        if (res.error) { fail++; } else { item.filePath = res.newPath; item.fileName = res.newFileName; ok++; }
      }
      closeRenameModal();
      renderTable();
      toast(`Renamed ${ok}${fail ? `, ${fail} failed` : ''}`);
    }
  });

  $('btnRenameCancel').addEventListener('click', closeRenameModal);
  renameBackdrop.addEventListener('click', e => { if (e.target === renameBackdrop) closeRenameModal(); });

  function closeRenameModal() { renameBackdrop.style.display = 'none'; renameTarget = null; }

  window.startRenameInline = (e, fp) => {
    e.stopPropagation();
    const item = allItems.find(i => i.filePath === fp);
    if (item) openRenameModal(item);
  };

  $('btnRenameSelected').addEventListener('click', () => {
    if (selectedSet.size === 0) return;
    if (selectedSet.size === 1) {
      const fp = [...selectedSet][0];
      openRenameModal(allItems.find(i => i.filePath === fp));
    } else {
      openRenameModal(null);
    }
  });

  // ── GO (copy / move) ──────────────────────────────────────────────────────────
  $('btnGoSelected').addEventListener('click', async () => {
    const sel = allItems.filter(i => selectedSet.has(i.filePath));
    if (sel.length === 0) { toast('Select PKGs first.', 'err'); return; }
    const dest = dstInput.value.trim();
    if (!dest) { toast('Choose a destination folder first.', 'err'); return; }

    const action    = $('actionSelect').value;
    const layout    = $('layoutSelect').value;
    const renameFmt = $('renameFmtInput').value.trim() || RENAME_PRESETS[0].fmt;

    const conflicts = await pkgApi.checkPkgConflicts(sel, dest, layout, renameFmt);
    if (conflicts.length > 0) {
      const names = conflicts.map(c => `  • ${c.item.fileName}`).join('\n');
      if (!confirm(`${conflicts.length} file${conflicts.length > 1 ? 's' : ''} already exist at destination:\n${names}\n\nOverwrite?`)) return;
    }

    localStorage.setItem(K_LAST_DST, dest);
    addRecent(K_RECENT_DST, dest);
    refreshAll();
    openGoModal(sel.length, action);
    pkgApi.offGoProgress();
    pkgApi.onGoProgress(handleGoProgress);
    await pkgApi.goPkgs(sel, dest, action, layout, renameFmt);
  });

  // ── Go progress modal ─────────────────────────────────────────────────────────
  const goBackdrop = $('goModalBackdrop');
  let goDone = false;

  function openGoModal(total, action) {
    goDone = false;
    $('goModal').classList.add('busy');
    $('goModalTitle').textContent    = action === 'move' ? 'Moving PKGs…' : 'Copying PKGs…';
    $('goModalFile').textContent     = '';
    $('goModalProgress').textContent = `0 / ${total}`;
    $('goFilebar').style.width       = '0%';
    $('goOverallbar').style.width    = '0%';
    $('goModalClose').style.display  = 'none';
    $('goModalCancel').style.display = 'inline-flex';
    goBackdrop.style.display         = 'flex';
  }

  function handleGoProgress(d) {
    if (d.type === 'go-file-start') {
      $('goModalFile').textContent     = d.file;
      $('goModalProgress').textContent = `${d.current} / ${d.total}`;
      $('goFilebar').style.width       = '0%';
      $('goOverallbar').style.width    = Math.round((d.current - 1) / d.total * 100) + '%';
    } else if (d.type === 'go-file-progress') {
      const pct = d.totalBytes ? Math.round(d.bytesCopied / d.totalBytes * 100) : 0;
      $('goFilebar').style.width = pct + '%';
    } else if (d.type === 'go-file-done') {
      $('goFilebar').style.width = '100%';
    } else if (d.type === 'go-file-error') {
      toast(`Failed: ${d.file}`, 'err');
    } else if (d.type === 'go-done') {
      goDone = true;
      $('goOverallbar').style.width    = '100%';
      $('goModalTitle').textContent    = 'Done!';
      $('goModalProgress').textContent = `${d.ok} ok${d.error ? ', ' + d.error + ' failed' : ''}${d.skipped ? ', ' + d.skipped + ' skipped' : ''}`;
      $('goModal').classList.remove('busy');
      $('goModalClose').style.display  = 'inline-flex';
      $('goModalCancel').style.display = 'none';
      if ($('actionSelect').value === 'move') {
        const moved = [...selectedSet];
        allItems = allItems.filter(i => !moved.includes(i.filePath));
        selectedSet.clear();
        applyFilters();
      }
    }
  }

  $('goModalCancel').addEventListener('click', () => pkgApi.cancelOperation());
  $('goModalClose').addEventListener('click', () => { goBackdrop.style.display = 'none'; });
  goBackdrop.addEventListener('click', e => { if (e.target === goBackdrop && goDone) goBackdrop.style.display = 'none'; });

  // ── Layout rename format visibility ───────────────────────────────────────────
  $('layoutSelect').addEventListener('change', e => {
    const showFmt = e.target.value === 'rename' || e.target.value === 'rename-organize';
    $('renameFmtRow').style.display = showFmt ? 'flex' : 'none';
  });

  // ── Menu ──────────────────────────────────────────────────────────────────────
  $('topMenu').addEventListener('change', e => {
    const v = e.target.value;
    e.target.value = '';
    if (v === 'clear') {
      if (!confirm('Clear all scan results?')) return;
      allItems = []; filteredItems = []; selectedSet.clear(); renderTable(); updateCounts();
    }
    if (v === 'selectAll')   { filteredItems.forEach(i => selectedSet.add(i.filePath)); renderTable(); updateSelectionUI(); }
    if (v === 'unselectAll') { selectedSet.clear(); renderTable(); updateSelectionUI(); }
    if (v === 'exportCsv')   exportCsv();
  });

  function exportCsv() {
    if (!allItems.length) { toast('Nothing to export.'); return; }
    const headers = ['Title','Title ID','Category','Version','Region','Req FW','Size (bytes)','Filename','Path','Content ID'];
    const rows = allItems.map(i => [
      i.title, i.titleId, categoryDisplay(i.category), i.appVer,
      regionDisplay(i.region), i.sysVer, i.fileSize, i.fileName, i.filePath, i.contentId,
    ].map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(','));
    const csv  = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `ps4-pkgs-${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
    toast(`Exported ${allItems.length} rows.`);
  }

  // ── Toast ──────────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, type = 'ok') {
    const el = $('toast');
    el.textContent = msg;
    el.className   = 'toast toast--' + type;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }

  // ── Remote Install ────────────────────────────────────────────────────────────
  const installBackdrop = $('installModalBackdrop');
  let   installActive   = false;

  // Row-level single install
  window.installOne = (fp) => {
    const item = allItems.find(i => i.filePath === fp);
    if (!item) return;
    openInstallModal([item]);
  };

  $('btnInstallSelected').addEventListener('click', () => {
    const sel = allItems.filter(i => selectedSet.has(i.filePath));
    if (!sel.length) return;
    openInstallModal(sel);
  });

  async function openInstallModal(items) {
    // Restore saved settings
    $('installPs4Ip').value   = localStorage.getItem('ps4vault.installPs4Ip')   || '';
    $('installPs4Port').value = localStorage.getItem('ps4vault.installPs4Port')  || '12800';
    $('installSrvPort').value = localStorage.getItem('ps4vault.installSrvPort')  || '8090';

    // Detect and show local IP
    try {
      const localIp = await pkgApi.getLocalIp();
      const srvPort = $('installSrvPort').value || '8090';
      $('installLocalIp').textContent  = localIp;
      $('installBaseUrl').textContent  = `http://${localIp}:${srvPort}/`;
      $('installLocalIpBox').style.display = 'block';
    } catch { $('installLocalIpBox').style.display = 'none'; }

    // Build per-item list
    renderInstallItems(items);

    // Clear warn + summary
    $('installWarnBox').style.display   = 'none';
    $('installSummary').style.display   = 'none';
    $('installWarnBox').textContent     = '';
    $('installSummary').textContent     = '';

    $('btnInstallStart').disabled     = false;
    $('btnInstallStart').textContent  = '📡 Send to PS4';
    $('btnInstallClose').style.display = 'flex';

    installBackdrop.dataset.items = JSON.stringify(items.map(i => i.filePath));
    installBackdrop.style.display = 'flex';
    setTimeout(() => $('installPs4Ip').focus(), 80);
  }

  function renderInstallItems(items, stateMap = {}) {
    const list = $('installItemsList');
    list.innerHTML = items.map(item => {
      const state   = stateMap[item.filePath] || {};
      const icon    = state.icon    || (item.isFtp ? '📡' : '📦');
      const statusText = state.status || (item.isFtp ? '⚠ FTP — will be skipped' : 'Waiting…');
      const pct     = state.percent ?? 0;
      const cls     = state.cls    || (item.isFtp ? 'ii-error' : '');
      return `<div class="install-item ${cls}" id="ii-${escAttr(item.filePath)}">
        <div class="ii-icon">${icon}</div>
        <div class="ii-info">
          <div class="ii-name" title="${escHtml(item.filePath)}">${escHtml(item.title || item.fileName)}</div>
          <div class="ii-status" id="ii-status-${escAttr(item.filePath)}">${statusText}</div>
          <div class="ii-bar-wrap" id="ii-bar-wrap-${escAttr(item.filePath)}" style="display:${state.showBar ? 'block' : 'none'}">
            <div class="ii-bar" id="ii-bar-${escAttr(item.filePath)}" style="width:${pct}%"></div>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // ── PS4 auto-discovery ──────────────────────────────────────────────────────
  let discoverAbort = false;

  $('btnDiscoverPs4').addEventListener('click', async () => {
    const btn = $('btnDiscoverPs4');
    const status = $('installDiscoverStatus');
    discoverAbort = false;
    btn.disabled = true;
    btn.textContent = '⏳ Scanning…';
    status.style.display = 'block';
    status.textContent = 'Scanning local network for PS4…';

    pkgApi.offDiscoverProgress();
    pkgApi.onDiscoverProgress(d => {
      if (d.type === 'found') {
        status.textContent = `✓ Found device at ${d.ip} (port ${d.port})${d.installerOpen ? ' — installer ready' : ' — installer NOT open on 12800'}`;
        if (d.installerOpen) {
          $('installPs4Ip').value   = d.ip;
          $('installPs4Port').value = '12800';
          localStorage.setItem('ps4vault.installPs4Ip', d.ip);
          // stop after first installer-ready PS4
          discoverAbort = true;
        }
      } else if (d.type === 'batch-done') {
        if (!d.found || d.found.length === 0) {
          status.textContent = `Scanning… ${d.scanned}/${d.total} hosts checked`;
        }
      } else if (d.type === 'done') {
        btn.disabled = false;
        btn.textContent = '🔍 Find PS4';
        if (!d.found || d.found.length === 0) {
          status.textContent = '✗ No PS4 found — make sure Remote PKG Installer is running and in focus';
        } else {
          const installerReady = d.found.filter(x => x.installerOpen);
          if (installerReady.length === 0) {
            status.textContent = `Found ${d.found.length} device(s) but none had port 12800 open — launch Remote PKG Installer`;
          }
        }
      }
    });

    await pkgApi.discoverPs4();
    btn.disabled = false;
    btn.textContent = '🔍 Find PS4';
    pkgApi.offDiscoverProgress();
  });

  // Update server port preview when port input changes
  $('installSrvPort').addEventListener('input', async () => {
    try {
      const localIp = await pkgApi.getLocalIp();
      $('installBaseUrl').textContent = `http://${localIp}:${$('installSrvPort').value || '8090'}/`;
    } catch {}
  });

  $('btnTestPs4Conn').addEventListener('click', async () => {
    const btn    = $('btnTestPs4Conn');
    const status = $('installDiscoverStatus');
    const ps4Ip  = $('installPs4Ip').value.trim();
    const ps4Port = parseInt($('installPs4Port').value) || 12800;
    if (!ps4Ip) { toast('Enter the PS4 IP address first.', 'err'); return; }
    btn.disabled = true;
    btn.textContent = '⏳ Testing…';
    status.style.display = 'block';
    status.style.color   = '';
    status.textContent   = `Testing ${ps4Ip}:${ps4Port}…`;
    const result = await pkgApi.testPs4Conn(ps4Ip, ps4Port);
    btn.disabled = false;
    btn.textContent = '🔌 Test Connection';
    if (result.ok) {
      status.style.color   = '#4ade80';
      status.textContent   = `✓ PS4 installer reachable at ${ps4Ip}:${ps4Port} — ready to install`;
      $('installWarnBox').style.display = 'none';
    } else {
      status.style.color   = '#f87171';
      status.textContent   = `✗ ${result.error}`;
      $('installWarnBox').textContent   = result.error;
      $('installWarnBox').style.display = 'block';
    }
  });

  $('btnInstallStart').addEventListener('click', async () => {
    const ps4Ip   = $('installPs4Ip').value.trim();
    const ps4Port = parseInt($('installPs4Port').value) || 12800;
    const srvPort = parseInt($('installSrvPort').value) || 8090;

    if (!ps4Ip) { toast('Enter the PS4 IP address.', 'err'); $('installPs4Ip').focus(); return; }

    // Save settings
    localStorage.setItem('ps4vault.installPs4Ip',   ps4Ip);
    localStorage.setItem('ps4vault.installPs4Port',  String(ps4Port));
    localStorage.setItem('ps4vault.installSrvPort',  String(srvPort));

    const fps   = JSON.parse(installBackdrop.dataset.items || '[]');
    const items = fps.map(fp => allItems.find(i => i.filePath === fp)).filter(Boolean);
    if (!items.length) return;

    installActive = true;
    $('btnInstallStart').disabled    = true;
    $('btnInstallStart').textContent = '⏳ Installing…';
    $('btnInstallClose').style.display = 'none';
    $('installWarnBox').style.display  = 'none';
    $('installSummary').style.display  = 'none';

    // Reset item visuals
    items.forEach(item => {
      const el = document.getElementById(`ii-${item.filePath}`);
      if (el) { el.className = 'install-item'; }
      const st = document.getElementById(`ii-status-${item.filePath}`);
      if (st) st.textContent = item.isFtp ? '⚠ FTP — will be skipped' : 'Queued…';
      const bw = document.getElementById(`ii-bar-wrap-${item.filePath}`);
      if (bw) bw.style.display = 'none';
    });

    pkgApi.offInstallProgress();
    pkgApi.onInstallProgress(handleInstallProgress);

    const result = await pkgApi.remoteInstall(items, ps4Ip, ps4Port, srvPort);

    installActive = false;
    $('btnInstallStart').disabled    = false;
    $('btnInstallStart').textContent = '📡 Send to PS4 Again';
    $('btnInstallClose').style.display = 'flex';

    if (result && !result.ok && result.error) {
      toast('Install error: ' + result.error, 'err');
      $('installWarnBox').textContent   = '✗ ' + result.error;
      $('installWarnBox').style.display = 'block';
    }
  });

  function handleInstallProgress(d) {
    if (d.type === 'install-connecting') {
      $('installDiscoverStatus').style.display = 'block';
      $('installDiscoverStatus').textContent = `🔌 Connecting to ${d.ps4Ip}:${d.ps4Port}…`;

    } else if (d.type === 'install-ps4-unreachable') {
      $('installDiscoverStatus').style.display = 'block';
      $('installDiscoverStatus').style.color = '#f87171';
      $('installDiscoverStatus').textContent = '✗ ' + d.message.split('\n')[0];
      $('installWarnBox').textContent   = d.message;
      $('installWarnBox').style.display = 'block';
      $('btnInstallStart').disabled     = false;
      $('btnInstallStart').textContent  = '📡 Send to PS4';
      $('btnInstallClose').style.display = 'flex';
      installActive = false;

    } else if (d.type === 'install-ps4-ok') {
      $('installDiscoverStatus').style.color = '';
      $('installDiscoverStatus').textContent = `✓ Connected to PS4 at ${d.ps4Ip}:${d.ps4Port}`;

    } else if (d.type === 'install-warn') {
      $('installWarnBox').textContent   = '⚠ ' + d.message;
      $('installWarnBox').style.display = 'block';

    } else if (d.type === 'install-server-ready') {
      $('installLocalIp').textContent  = d.localIp;
      $('installBaseUrl').textContent  = `http://${d.localIp}:${d.serverPort}/`;
      $('installLocalIpBox').style.display = 'block';

    } else if (d.type === 'install-file-start') {
      const el = document.getElementById(`ii-${d.file}`) ||
                 [...$('installItemsList').querySelectorAll('.install-item')]
                   .find(e => e.querySelector('.ii-name')?.textContent.includes(d.file));
      if (el) el.className = 'install-item ii-active';
      setItemStatus(d.file, '📡 Sending install command…');

    } else if (d.type === 'install-file-queued') {
      const tid = d.taskId !== null ? `Task #${d.taskId}` : 'queued (no task id)';
      setItemStatus(d.file, `✓ Accepted by PS4 — ${tid}. Waiting for download…`);
      setItemBar(d.file, 0, true);

    } else if (d.type === 'install-task-progress') {
      const pct   = d.percent ?? null;
      const secStr = d.rest ? ` · ${fmtSec(d.rest)} remaining` : '';
      const pctStr = pct !== null ? `${pct}%` : '';
      const status = d.status ? ` [${d.status}]` : '';
      const transferred = d.transferred ? ` · ${fmtSize(d.transferred)}` : '';
      setItemStatus(d.file, `⬇ Downloading… ${pctStr}${transferred}${secStr}${status}`);
      if (pct !== null) setItemBar(d.file, pct, true);

    } else if (d.type === 'install-file-done') {
      const el = findItemEl(d.file);
      if (el) el.className = 'install-item ii-done';
      setItemStatus(d.file, '✅ Install queued on PS4');
      setItemBar(d.file, 100, true);

    } else if (d.type === 'install-file-error') {
      const el = findItemEl(d.file);
      if (el) el.className = 'install-item ii-error';
      setItemStatus(d.file, '✗ ' + (d.error || 'Unknown error'));

    } else if (d.type === 'install-done') {
      const parts = [`${d.ok} sent`];
      if (d.failed)  parts.push(`${d.failed} failed`);
      if (d.skipped) parts.push(`${d.skipped} skipped`);
      $('installSummary').textContent   = parts.join(' · ');
      $('installSummary').style.display = 'block';
      if (d.failed === 0 && d.ok > 0) toast(`✅ ${d.ok} PKG${d.ok !== 1 ? 's' : ''} sent to PS4!`);
      else if (d.ok === 0) toast('Install failed — check the modal.', 'err');
    }
  }

  function findItemEl(fileNameOrPath) {
    return document.getElementById(`ii-${fileNameOrPath}`) ||
      [...($('installItemsList')?.querySelectorAll('.install-item') || [])]
        .find(el => el.querySelector('.ii-name')?.title?.includes(fileNameOrPath));
  }
  function setItemStatus(fp, text) {
    const el = document.getElementById(`ii-status-${fp}`) ||
      findItemEl(fp)?.querySelector('.ii-status');
    if (el) el.textContent = text;
  }
  function setItemBar(fp, pct, show) {
    const bw = document.getElementById(`ii-bar-wrap-${fp}`);
    const b  = document.getElementById(`ii-bar-${fp}`);
    if (bw) bw.style.display = show ? 'block' : 'none';
    if (b)  b.style.width = pct + '%';
  }
  function fmtSec(s) {
    if (!s || s < 0) return '';
    if (s < 60)  return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.floor(s/60)}m ${Math.round(s%60)}s`;
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
  }

  $('btnInstallCancel').addEventListener('click', closeInstallModal);
  $('btnInstallClose').addEventListener('click',  closeInstallModal);
  installBackdrop.addEventListener('click', e => {
    if (e.target === installBackdrop && !installActive) closeInstallModal();
  });

  function closeInstallModal() {
    if (installActive) return; // don't close during active install
    installBackdrop.style.display = 'none';
    pkgApi.offInstallProgress();
  }

  // ── Context menu ──────────────────────────────────────────────────────────────
  const ctxMenu = $('ctxMenu');

  window.showCtxMenu = (x, y, fp) => {
    ctxTarget = fp;
    const item = allItems.find(i => i.filePath === fp);
    ctxMenu.style.display = 'block';
    // Clamp to viewport
    const mw = 200, mh = 220;
    ctxMenu.style.left = Math.min(x, window.innerWidth  - mw) + 'px';
    ctxMenu.style.top  = Math.min(y, window.innerHeight - mh) + 'px';
    // Highlight the right-clicked item
    if (item && !selectedSet.has(fp)) {
      selectedSet.clear();
      selectedSet.add(fp);
      viewMode === 'grid' ? renderGrid() : renderTable();
    }
  };

  function hideCtxMenu() { ctxMenu.style.display = 'none'; ctxTarget = null; }
  document.addEventListener('click', hideCtxMenu);
  // NOTE: Escape is handled inside the unified keyboard shortcut handler below
  ctxMenu.addEventListener('click', e => e.stopPropagation());

  $('ctxInstall').addEventListener('click', () => {
    if (!ctxTarget) return; hideCtxMenu();
    installOne(ctxTarget);
  });
  $('ctxShowFolder').addEventListener('click', () => {
    if (!ctxTarget) return; hideCtxMenu();
    pkgApi.showInFolder(ctxTarget);
  });
  $('ctxCopyName').addEventListener('click', () => {
    const item = ctxTarget && allItems.find(i => i.filePath === ctxTarget);
    if (item) { pkgApi.copyToClipboard(item.fileName); toast('Filename copied'); }
    hideCtxMenu();
  });
  $('ctxCopyId').addEventListener('click', () => {
    const item = ctxTarget && allItems.find(i => i.filePath === ctxTarget);
    if (item && item.titleId) { pkgApi.copyToClipboard(item.titleId); toast('CUSA ID copied'); }
    hideCtxMenu();
  });
  $('ctxRename').addEventListener('click', () => {
    const item = ctxTarget && allItems.find(i => i.filePath === ctxTarget);
    if (item) { hideCtxMenu(); openRenameModal(item); }
  });
  $('ctxDelete').addEventListener('click', () => {
    const fp = ctxTarget; hideCtxMenu();
    if (fp) deleteOne(fp);
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    const inInput = ['INPUT','SELECT','TEXTAREA'].includes(tag);

    // Ctrl/Cmd+A — select all visible
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !inInput) {
      e.preventDefault();
      filteredItems.forEach(i => selectedSet.add(i.filePath));
      renderTable(); updateSelectionUI();
      return;
    }
    // Ctrl/Cmd+F — focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      $('searchInput').focus(); $('searchInput').select();
      return;
    }
    // Escape — hide ctx menu first; if none open, clear selection
    if (e.key === 'Escape' && !inInput) {
      if (ctxMenu.style.display !== 'none') { hideCtxMenu(); return; }
      selectedSet.clear(); renderTable(); updateSelectionUI();
      return;
    }
    // Delete / Backspace — delete selected (if not in input)
    if ((e.key === 'Delete' || e.key === 'Backspace') && !inInput && selectedSet.size > 0) {
      e.preventDefault();
      $('btnDeleteSelected').click();
      return;
    }
    // Enter — install selected
    if (e.key === 'Enter' && !inInput && selectedSet.size > 0) {
      const sel = allItems.filter(i => selectedSet.has(i.filePath));
      if (sel.length) openInstallModal(sel);
    }
  });

  // ── Init ───────────────────────────────────────────────────────────────────────
  renderTable();
  updateCounts();
})();
