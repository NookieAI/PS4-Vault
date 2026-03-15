(function () {
  'use strict';

  // ── Storage keys ─────────────────────────────────────────────────────────────
  const K_LAST_SRC   = 'ps4pkgvault.lastSource';
  const K_LAST_DST   = 'ps4pkgvault.lastDest';
  const K_SETTINGS   = 'ps4pkgvault.settings';
  const K_RECENT_SRC = 'ps4pkgvault.recentSrc';
  const K_RECENT_DST = 'ps4pkgvault.recentDst';
  const K_RECENT_FTP = 'ps4pkgvault.recentFtp';

  // ── State ─────────────────────────────────────────────────────────────────────
  let allItems      = [];
  let filteredItems = [];
  let selectedSet   = new Set();
  let sortBy        = 'title';
  let sortAsc       = true;
  let activeCat     = 'all';
  let searchText    = '';
  let renderPending = false;
  let viewMode          = 'table';
  let ctxTarget         = null;
  let discoveredConsole = null;
  let activeFtpDest     = null;

  const $ = id => document.getElementById(id);

  // ── Settings ──────────────────────────────────────────────────────────────────
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem(K_SETTINGS) || '{}'); } catch {}
  function saveSetting(k, v) { settings[k] = v; localStorage.setItem(K_SETTINGS, JSON.stringify(settings)); }

  // ── Logo ──────────────────────────────────────────────────────────────────────
  (async () => {
    for (let i = 0; i < 5; i++) {
      try {
        const p = await pkgApi.getAppPath();
        const logo = $('brandLogo');
        if (logo && p) logo.src = 'file:///' + p.replace(/\\/g, '/') + '/logo.jpg';
        break;
      } catch (_) { await new Promise(r => setTimeout(r, 500)); }
    }
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
    r.unshift(v);
    localStorage.setItem(k, JSON.stringify(r.slice(0, 8)));
  }
  function refreshDatalist(dlId, k) {
    const dl = $(dlId); if (!dl) return;
    dl.innerHTML = '';
    getRecent(k).forEach(v => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); });
  }
  function renderChips(containerId, storageKey, inputId) {
    const container = $(containerId); if (!container) return;
    const inp = $(inputId);
    container.innerHTML = getRecent(storageKey).map(v => {
      const short = v.length > 36 ? '…' + v.slice(-34) : v;
      return `<button class="recent-chip" title="${escHtml(v)}" data-val="${escHtml(v)}"><span class="chip-icon">🕐</span>${escHtml(short)}</button>`;
    }).join('');
    container.querySelectorAll('.recent-chip').forEach(btn =>
      btn.addEventListener('click', () => { if (inp) { inp.value = btn.dataset.val; inp.dispatchEvent(new Event('input')); } }));
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
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function categoryDisplay(cat) {
    const c = (cat || '').toLowerCase().trim();
    if (['gd','gde','gda','gdc','hg'].includes(c)) return 'Game';
    if (c === 'gp')  return 'Patch';
    if (c === 'ac')  return 'DLC';
    if (c === 'theme') return 'Theme';
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
    filteredItems.sort((a,b) => {
      let av, bv;
      switch (sortBy) {
        case 'size':     av=a.fileSize||0;           bv=b.fileSize||0;           break;
        case 'titleId':  av=a.titleId||'';           bv=b.titleId||'';           break;
        case 'category': av=categoryDisplay(a.category); bv=categoryDisplay(b.category); break;
        case 'version':  av=a.appVer||'';            bv=b.appVer||'';            break;
        case 'region':   av=regionDisplay(a.region); bv=regionDisplay(b.region); break;
        default:         av=a.title||'';             bv=b.title||'';
      }
      if (typeof av==='number') return sortAsc ? av-bv : bv-av;
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }

  // ── Placeholder SVGs ──────────────────────────────────────────────────────────
  function makeInstalledPlaceholderSvg() {
    return `<svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="72" height="72" rx="8" fill="rgba(34,197,94,0.08)"/>
      <rect x="18" y="18" width="36" height="4" rx="2" fill="rgba(34,197,94,0.3)"/>
      <rect x="18" y="27" width="28" height="3" rx="1.5" fill="rgba(34,197,94,0.18)"/>
      <rect x="18" y="34" width="32" height="3" rx="1.5" fill="rgba(34,197,94,0.14)"/>
      <rect x="18" y="41" width="20" height="3" rx="1.5" fill="rgba(34,197,94,0.1)"/>
      <text x="36" y="62" text-anchor="middle" font-size="8" fill="rgba(34,197,94,0.5)" font-family="JetBrains Mono,ui-monospace,monospace" font-weight="700">ON CONSOLE</text>
    </svg>`;
  }
  function makePlaceholderSvg() {
    return `<svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="72" height="72" rx="8" fill="rgba(255,255,255,0.03)"/>
      <rect x="14" y="18" width="44" height="5" rx="2.5" fill="rgba(255,255,255,0.1)"/>
      <rect x="14" y="28" width="32" height="4" rx="2" fill="rgba(255,255,255,0.06)"/>
      <rect x="14" y="36" width="38" height="4" rx="2" fill="rgba(255,255,255,0.06)"/>
      <rect x="14" y="44" width="24" height="4" rx="2" fill="rgba(255,255,255,0.04)"/>
      <text x="36" y="64" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.16)" font-family="JetBrains Mono,ui-monospace,monospace" font-weight="600" letter-spacing="1">PKG</text>
    </svg>`;
  }

  // ── Table rendering ───────────────────────────────────────────────────────────
  const tbody = $('resultsBody');
  function renderTable() {
    if (viewMode === 'grid') { renderGrid(); updateStats(); return; }
    if (!filteredItems.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-cell">${allItems.length===0?'No scan performed yet. Choose a source folder and click SCAN.':'No PKGs match the current filter.'}</td></tr>`;
      updateStats(); return;
    }
    tbody.innerHTML = filteredItems.map(item => {
      const checked  = selectedSet.has(item.filePath);
      const catDisp  = categoryDisplay(item.category);
      const catCls   = categoryColor(item.category);
      const regDisp  = regionDisplay(item.region);
      const regCls   = regionColor(item.region);
      const iconHtml = item.iconDataUrl
        ? `<img class="thumb" src="${item.iconDataUrl}" alt="cover" loading="eager" onmouseover="showPreview(event,this.src,'${escJs(item.filePath)}')" onmouseout="hidePreview()">`
        : item.isInstalled ? makeInstalledPlaceholderSvg() : makePlaceholderSvg();
      let displayName, titleQuality;
      if (item.sfoTitle)       { displayName=escHtml(item.sfoTitle); titleQuality='title-from-sfo'; }
      else if (item.fnTitle)   { displayName=escHtml(item.fnTitle);  titleQuality='title-from-fn'; }
      else if (item.titleId)   { displayName=escHtml(item.titleId);  titleQuality='title-fallback'; }
      else                     { displayName=escHtml(item.fileName||'—'); titleQuality='title-fallback'; }
      const cusaLine  = item.titleId ? `<div class="title-cusa">${escHtml(item.titleId)}</div>` : '';
      const pathLine  = item.dirPath ? `<div class="title-path" title="${escHtml(item.filePath)}">${escHtml(item.dirPath)}</div>` : '';
      const dupBadge  = item.isDuplicate ? ` <span class="dup-badge">DUP</span>` : '';
      const ftpBadge  = item.isFtp&&!item.isInstalled ? ` <span class="ftp-badge">FTP</span>` : '';
      const instBadge = item.isInstalled ? ` <span class="installed-badge">INSTALLED</span>` : '';
      const actionsHtml = item.isInstalled
        ? `<button class="row-btn row-btn--install" title="Install to PS4/PS5" onclick="installOne('${escJs(item.filePath)}')">📡</button>`
        : `<button class="row-btn" title="Show in folder" onclick="pkgApi.showInFolder('${escJs(item.filePath)}')">📂</button>
           <button class="row-btn" title="Copy filename" onclick="pkgApi.copyToClipboard('${escJs(item.fileName)}')">📋</button>
           <button class="row-btn row-btn--install" title="Install to PS4/PS5" onclick="installOne('${escJs(item.filePath)}')">📡</button>
           <button class="row-btn row-btn--danger" title="Delete" onclick="deleteOne('${escJs(item.filePath)}')">🗑</button>`;
      const sizeDisp = (item.isInstalled && !item.fileSize)
        ? '<span style="color:var(--muted);font-size:11px">on console</span>' : fmtSize(item.fileSize);
      return `<tr class="${checked?'row-selected':''}${item.isInstalled?' row-installed':''}" data-fp="${escAttr(item.filePath)}">
        <td class="check"><input type="checkbox" ${checked?'checked':''} data-fp="${escAttr(item.filePath)}"/></td>
        <td class="cover"><div class="icon-wrap">${iconHtml}</div></td>
        <td class="title-cell">
          <div class="title-main"><span class="title-name ${titleQuality}">${displayName}</span>${dupBadge}${ftpBadge}${instBadge}</div>
          ${cusaLine}${pathLine}
          ${item.isInstalled?'':`<div class="title-sub pkg-filename" title="${escHtml(item.filePath)}" onclick="startRenameInline(event,'${escJs(item.filePath)}')">${escHtml(item.fileName)}</div>`}
        </td>
        <td><span class="cat-badge ${catCls}">${catDisp}</span></td>
        <td class="mono-col">${escHtml(item.appVer||'—')}</td>
        <td><span class="reg-badge ${regCls}">${regDisp}</span></td>
        <td class="mono-col">${escHtml(item.sysVer||'—')}</td>
        <td class="size">${sizeDisp}</td>
        <td class="acts">${actionsHtml}</td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('input[type=checkbox]').forEach(cb =>
      cb.addEventListener('change', e => {
        const fp = e.target.dataset.fp;
        if (e.target.checked) selectedSet.add(fp); else selectedSet.delete(fp);
        e.target.closest('tr').classList.toggle('row-selected', e.target.checked);
        updateSelectionUI();
      }));
    tbody.querySelectorAll('tr[data-fp]').forEach(tr => {
      tr.addEventListener('dblclick', () => { const item=allItems.find(i=>i.filePath===tr.dataset.fp); if(item) openInstallModal([item]); });
      tr.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e.clientX,e.clientY,tr.dataset.fp); });
    });
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
      const sel = selectedSet.has(item.filePath);
      const title = item.sfoTitle||item.fnTitle||item.titleId||item.fileName;
      const catCls = categoryColor(item.category);
      const cover  = item.iconDataUrl
        ? `<img src="${item.iconDataUrl}" alt="cover" loading="eager" onmouseover="showPreview(event,this.src,this.closest('.grid-card').dataset.fp)" onmouseout="hidePreview()">`
        : makePlaceholderSvg();
      return `<div class="grid-card${sel?' selected':''}" data-fp="${escAttr(item.filePath)}" oncontextmenu="event.preventDefault();showCtxMenu(event.clientX,event.clientY,'${escJs(item.filePath)}')">
        <div class="gc-check"></div>
        <div class="gc-cover">${cover}</div>
        <div class="gc-body">
          <div class="gc-title" title="${escHtml(title)}">${escHtml(title)}</div>
          <div class="gc-sub">${escHtml(item.titleId||'—')}</div>
          <div class="gc-badge-row">
            <span class="cat-badge ${catCls}" style="font-size:9.5px;padding:1px 5px">${categoryDisplay(item.category)}</span>
            ${item.appVer?`<span style="font-size:9.5px;color:var(--muted);font-family:'JetBrains Mono',ui-monospace,monospace">v${escHtml(item.appVer)}</span>`:''}
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
      card.addEventListener('dblclick', () => { clearTimeout(t); installOne(card.dataset.fp); });
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
  const PREVIEW_W=368;
  function placePreview() {
    requestAnimationFrame(() => {
      const W=window.innerWidth, H=window.innerHeight, ph=preview.offsetHeight||300;
      let x=previewMx+20; if(x+PREVIEW_W>W) x=previewMx-PREVIEW_W-12; if(x<4) x=4;
      let y=previewMy+20; if(y+ph>H-4) y=previewMy-ph-12; if(y<4) y=4;
      preview.style.left=x+'px'; preview.style.top=y+'px';
    });
  }
  window.showPreview = (e,src,fp) => {
    if (!src) return;
    previewMx=e.clientX; previewMy=e.clientY;
    const item = fp&&allItems.find(i=>i.filePath===fp);
    if (item) {
      const title=item.sfoTitle||item.fnTitle||item.titleId||item.fileName||'';
      const sub=[item.titleId,item.appVer?'v'+item.appVer:'',item.sysVer?'FW '+item.sysVer:''].filter(Boolean).join('  ·  ');
      $('imgPreviewTitle').textContent=title; $('imgPreviewSub').textContent=sub;
      $('imgPreviewMeta').style.display=(title||sub)?'':'none';
    } else { $('imgPreviewMeta').style.display='none'; }
    if (previewImg.getAttribute('data-current')!==src) {
      previewImg.setAttribute('data-current',src);
      previewImg.onload=()=>{ if(preview.style.display!=='none') placePreview(); };
      previewImg.src=src;
    }
    preview.style.display='block'; placePreview();
  };
  window.hidePreview = () => { preview.style.display='none'; };
  document.addEventListener('mousemove', e => {
    if (preview.style.display!=='none') { previewMx=e.clientX; previewMy=e.clientY; placePreview(); }
  });

  // ── Counts + selection ────────────────────────────────────────────────────────
  function updateCounts() {
    const total=allItems.length, shown=filteredItems.length;
    const dupes=allItems.filter(i=>i.isDuplicate).length;
    const totalSz=allItems.reduce((s,i)=>s+(i.fileSize||0),0);
    $('scanCount').textContent = total
      ? `${shown}${shown!==total?' / '+total:''} PKGs  ·  ${fmtSize(totalSz)}${dupes?`  ·  ⚠ ${dupes} dupes`:''}`
      : '';
    ['all','Game','Patch','DLC','App','Theme','Other'].forEach(c => {
      const btn=$(c==='all'?'catAll':'cat'+c); if(!btn) return;
      const n=c==='all'?allItems.filter(i=>!i.isInstalled).length:allItems.filter(i=>!i.isInstalled&&categoryDisplay(i.category)===c).length;
      btn.querySelector('.cat-count').textContent=n;
    });
    const ib=$('catInstalled');
    if(ib) ib.querySelector('.cat-count').textContent=allItems.filter(i=>i.isInstalled).length;
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
  $('btnPickSource').addEventListener('click', async()=>{ const p=await pkgApi.openDirectory(); if(p){srcInput.value=p;addRecent(K_RECENT_SRC,p);refreshAll();}});
  $('btnPickDest').addEventListener('click',   async()=>{ const p=await pkgApi.openDirectory(); if(p){dstInput.value=p;addRecent(K_RECENT_DST,p);refreshAll();}});
  $('btnClearSource').addEventListener('click',()=>{ srcInput.value=''; srcInput.focus(); });
  $('btnClearDest').addEventListener('click',  ()=>{ activeFtpDest=null; updateFtpDestUI(); dstInput.value=''; dstInput.disabled=false; $('btnPickDest').disabled=false; dstInput.focus(); });
  $('btnScanAllDrives').addEventListener('click', async()=>{
    const drives=await pkgApi.getAllDrives();
    if(!drives||!drives.length){toast('No drives detected.','err');return;}
    srcInput.value=drives.join(', ');
    toast(`Found ${drives.length} drive${drives.length!==1?'s':''}: ${drives.join(', ')} — scanning…`);
    startScan(drives,false);
  });

  // ── Scan ──────────────────────────────────────────────────────────────────────
  $('btnScan').addEventListener('click',()=>{
    const src=srcInput.value.trim(); if(!src){toast('Choose a source folder first.','err');return;}
    localStorage.setItem(K_LAST_SRC,src); addRecent(K_RECENT_SRC,src); refreshAll(); startScan([src],false);
  });

  // ── Console scan modal ────────────────────────────────────────────────────────
  function csStatus(msg,color){const el=$('csScanStatus');if(!el)return;el.textContent=msg;el.style.color=color||'';}
  function csCfgFromForm(){return{host:$('csHost').value.trim(),port:$('csFtpPort').value.trim()||'2121',user:$('csUser').value.trim()||'anonymous',pass:$('csPass').value||'',path:$('csPkgPath').value.trim()||'/'};}
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
      } else if(d.type==='batch-done'){csStatus(`Scanning… ${d.scanned}/${d.total} hosts`,'');}
      else if(d.type==='done'&&(!d.found||!d.found.length)){csStatus('No console found — make sure FTP is running on your PS4/PS5','#f87171');}
    });
    await pkgApi.discoverPs4(); btn.disabled=false; btn.textContent='🔍 Find'; pkgApi.offDiscoverProgress();
  });
  $('btnConsoleScanPkgs').addEventListener('click',async()=>{
    const cfg=csCfgFromForm(); if(!cfg.host){csStatus('Enter the console IP address first.','#f87171');return;}
    saveCsSettings(cfg); closeConsoleScanModal(); startScan([cfg],true);
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
    addRecent(K_RECENT_FTP,cfg.host);
    const csHostEl=$('csHost'); if(csHostEl&&!csHostEl.value) csHostEl.value=cfg.host;
    const csFtpEl=$('csFtpPort'); if(csFtpEl) csFtpEl.value=String(cfg.port||2121);
    const ipEl=$('installPs4Ip'); if(ipEl&&!ipEl.value) ipEl.value=cfg.host;
    refreshAll();
  }
  function saveCsSettings(cfg){saveConsoleCfg(cfg);}

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
    if(st){
      st.style.display='block'; st.style.color=d.installerOpen?'#4ade80':'#facc15';
      st.textContent=d.installerOpen?`${d.consoleType||'Console'} at ${d.ip} — Remote PKG Installer ready (port 12800)`:`${d.consoleType||'Console'} at ${d.ip} on FTP :${ftpPort} — open Remote PKG Installer on console to send PKGs`;
    }
  }
  function hideDiscoveredChip(){$('discoveredChip').style.display='none';discoveredConsole=null;activeFtpDest=null;updateFtpDestUI();}
  $('discoveredChipDismiss').addEventListener('click',hideDiscoveredChip);
  $('discoveredChipScan').addEventListener('click',()=>{
    if(!discoveredConsole)return;
    const cfg={host:discoveredConsole.ip,port:String(discoveredConsole.ftpPort||2121),user:'anonymous',pass:'',path:'/'};
    saveConsoleCfg(cfg);startScan([cfg],true);
  });
  $('discoveredChipInstalled').addEventListener('click',()=>{
    if(!discoveredConsole)return;
    const cfg={host:discoveredConsole.ip,port:String(discoveredConsole.ftpPort||2121),user:'anonymous',pass:'',path:'/'};
    saveConsoleCfg(cfg);startInstalledScan(cfg);
  });
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
    const allTab=$('catAll');if(allTab)allTab.classList.add('active');
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
    }
    toast(`Found ${returned?.length||0} installed game${returned?.length!==1?'s':''}.`);
  }

  $('btnCancelScan').addEventListener('click',()=>{ pkgApi.cancelOperation(); setScanUI(false); toast('Scan cancelled.'); });

  // ── View toggle ───────────────────────────────────────────────────────────────
  viewMode=settings.viewMode||'table';
  function applyViewMode(){
    const isGrid=viewMode==='grid';
    $('tableView').style.display=isGrid?'none':''; $('gridView').style.display=isGrid?'':'none';
    $('btnViewToggle').textContent=isGrid?'☰ Table':'⊞ Grid';
    $('btnViewToggle').classList.toggle('active',isGrid); renderTable();
  }
  $('btnViewToggle').addEventListener('click',()=>{ viewMode=viewMode==='table'?'grid':'table'; saveSetting('viewMode',viewMode); applyViewMode(); });
  applyViewMode();

  // ── Main scan ─────────────────────────────────────────────────────────────────
  let lastScanErrorMsg=null;
  async function startScan(dirs,isFtp){
    allItems=[];filteredItems=[];selectedSet.clear();activeCat='all';
    document.querySelectorAll('.cat-tab').forEach(b=>b.classList.remove('active'));
    const allTab=$('catAll');if(allTab)allTab.classList.add('active');
    renderTable();updateCounts();setScanUI(true);
    if(isFtp&&dirs.length>0&&typeof dirs[0]==='object'){
      const cfg=dirs[0]; srcInput.value=`ftp://${cfg.host}:${cfg.port||2121}${cfg.path||'/'}`;
    }
    const skippedDrives=[];
    pkgApi.offScanProgress(); pkgApi.onScanProgress(handleScanProgress);
    for(const dir of dirs){
      lastScanErrorMsg=null;
      let returned=isFtp?await pkgApi.ftpScanPkgs(dir):await pkgApi.scanPkgs(typeof dir==='string'?dir.trim():dir);
      if(Array.isArray(returned)&&returned.length>0){
        const existing=new Set(allItems.map(i=>i.filePath));
        returned.forEach(item=>{if(!existing.has(item.filePath))allItems.push(item);});
      } else if(lastScanErrorMsg){
        skippedDrives.push(typeof dir==='string'?dir:(dir.host||'?'));
      }
    }
    applyFilters();updateCounts();setScanUI(false);
    const totalSzAfter=allItems.reduce((s,i)=>s+(i.fileSize||0),0);
    let summary=`Scan complete — ${allItems.length} PKG${allItems.length!==1?'s':''} found (${fmtSize(totalSzAfter)})`;
    if(skippedDrives.length) summary+=` · ${skippedDrives.length} drive${skippedDrives.length>1?'s':''} skipped`;
    toast(summary+'.');
  }
  function handleScanProgress(d){
    if(d.type==='scan-start'||d.type==='scan-discovering'){$('currentScanLabel').textContent='Discovering .pkg files…';}
    else if(d.type==='scan-found'){$('currentScanLabel').textContent=`Found ${d.total} PKG${d.total!==1?'s':''}. Parsing headers…`;}
    else if(d.type==='scan-parsing'){$('currentScanLabel').textContent=`Parsing ${d.done} / ${d.total}  ·  ${d.file}`;}
    else if(d.type==='scan-result'){
      const alreadyHave=allItems.some(i=>i.filePath===d.item.filePath);
      if(!alreadyHave){allItems.push(d.item);$('currentScanLabel').textContent=`Parsing… ${allItems.length} found so far`;applyFiltersSoon();}
    }
    else if(d.type==='scan-result-update'){
      const item=allItems.find(i=>i.filePath===d.filePath);
      if(item){if(d.fileSize!==undefined)item.fileSize=d.fileSize;applyFiltersSoon();}
    }
    else if(d.type==='scan-done'){$('currentScanLabel').textContent=`Done — ${d.total} PKG${d.total!==1?'s':''} from this source`;}
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
    if(!confirm(`Delete ${item.fileName}?\n\nThis cannot be undone.`))return;
    const results=await pkgApi.deletePkgs([item]);
    if(results[0]?.ok){allItems=allItems.filter(i=>i.filePath!==fp);selectedSet.delete(fp);applyFilters();toast(`Deleted ${item.fileName}`);}
    else toast('Delete failed: '+results[0]?.error,'err');
  };
  $('btnDeleteSelected').addEventListener('click',async()=>{
    const sel=allItems.filter(i=>selectedSet.has(i.filePath)); if(!sel.length)return;
    if(!confirm(`Delete ${sel.length} PKG file${sel.length>1?'s':''}?\n\nThis cannot be undone.`))return;
    const results=await pkgApi.deletePkgs(sel);
    const ok=results.filter(r=>r.ok), errs=results.filter(r=>!r.ok);
    ok.forEach(r=>{allItems=allItems.filter(i=>i.filePath!==r.filePath);selectedSet.delete(r.filePath);});
    applyFilters(); toast(`Deleted ${ok.length}${errs.length?`, ${errs.length} failed`:''}`);
  });

  // ── Rename modal ──────────────────────────────────────────────────────────────
  const renameBackdrop=$('renameModalBackdrop'), renameInput=$('renameInput'), renamePreset=$('renamePreset');
  let renameTarget=null;
  const RENAME_PRESETS=[
    {label:'ID - Title [vVER] [CAT]',   fmt:'{TITLE_ID} - {TITLE} [v{VERSION}] [{CATEGORY}]'},
    {label:'[REGION] ID - Title (VER)', fmt:'[{REGION}] {TITLE_ID} - {TITLE} ({VERSION})'},
    {label:'Title [ID] [REGION] vVER',  fmt:'{TITLE} [{TITLE_ID}] [{REGION}] v{VERSION}'},
    {label:'ID_VER_REGION (short)',      fmt:'{TITLE_ID}_{VERSION}_{REGION}'},
    {label:'Custom…',                    fmt:''},
  ];
  function populateRenamePresets(){
    renamePreset.innerHTML='';
    RENAME_PRESETS.forEach(p=>{const o=document.createElement('option');o.value=p.fmt;o.textContent=p.label;renamePreset.appendChild(o);});
  }
  populateRenamePresets();
  function openRenameModal(item){
    renameTarget=item; const fmt=RENAME_PRESETS[0].fmt;
    renamePreset.value=fmt; renameInput.value=item?applyRenameFormat(fmt,item):fmt;
    updateRenamePreview(); renameBackdrop.style.display='flex';
    setTimeout(()=>renameInput.focus(),50);
  }
  function updateRenamePreview(){
    const val=renameInput.value.trim();
    if(renameTarget){$('renamePreview').textContent=val.endsWith('.pkg')?val:val+'.pkg';}
    else{
      const sample=allItems.find(i=>selectedSet.has(i.filePath));
      if(sample){$('renamePreview').textContent=applyRenameFormat(val,sample)+'.pkg'+(selectedSet.size>1?`  (+${selectedSet.size-1} more)`:'')}
      else $('renamePreview').textContent=val;
    }
  }
  function applyRenameFormat(fmt,item){
    const cat=categoryDisplay(item.category), reg=regionDisplay(item.region);
    return fmt.replace(/{TITLE_ID}/g,san4(item.titleId||'UNKNOWN')).replace(/{TITLE}/g,san4(item.title||'Unknown'))
      .replace(/{VERSION}/g,san4(item.appVer||'00.00')).replace(/{CATEGORY}/g,san4(cat)).replace(/{REGION}/g,san4(reg))
      .replace(/{CONTENT_ID}/g,san4(item.contentId||'')).replace(/{REQ_FW}/g,san4(item.sysVer||'')).trim();
  }
  function san4(s){return String(s||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim();}
  renamePreset.addEventListener('change',()=>{const fmt=renamePreset.value;if(fmt!=='')renameInput.value=renameTarget?applyRenameFormat(fmt,renameTarget):fmt;updateRenamePreview();});
  renameInput.addEventListener('input',updateRenamePreview);
  renameInput.addEventListener('keydown',e=>{if(e.key==='Enter')$('btnRenameApply').click();if(e.key==='Escape')closeRenameModal();});
  $('btnRenameApply').addEventListener('click',async()=>{
    const val=renameInput.value.trim(); if(!val)return;
    if(renameTarget){
      const newName=val.endsWith('.pkg')?val:val+'.pkg';
      const res=await pkgApi.renamePkg(renameTarget,newName);
      if(res.error){toast('Rename failed: '+res.error,'err');return;}
      renameTarget.filePath=res.newPath;renameTarget.fileName=res.newFileName;
      closeRenameModal();renderTable();toast(`Renamed to ${res.newFileName}`);
    } else {
      const sel=allItems.filter(i=>selectedSet.has(i.filePath));
      let ok=0,fail=0;
      for(const item of sel){
        const newName=applyRenameFormat(val,item)+'.pkg';
        const res=await pkgApi.renamePkg(item,newName);
        if(res.error)fail++;else{item.filePath=res.newPath;item.fileName=res.newFileName;ok++;}
      }
      closeRenameModal();renderTable();toast(`Renamed ${ok}${fail?`, ${fail} failed`:''}`);
    }
  });
  $('btnRenameCancel').addEventListener('click',closeRenameModal);
  $('btnRenameClose')?.addEventListener('click',closeRenameModal);
  renameBackdrop.addEventListener('click',e=>{if(e.target===renameBackdrop)closeRenameModal();});
  function closeRenameModal(){renameBackdrop.style.display='none';renameTarget=null;}
  window.startRenameInline=(e,fp)=>{e.stopPropagation();const item=allItems.find(i=>i.filePath===fp);if(item)openRenameModal(item);};
  $('btnRenameSelected').addEventListener('click',()=>{
    if(!selectedSet.size)return;
    if(selectedSet.size===1)openRenameModal(allItems.find(i=>i.filePath===[...selectedSet][0]));
    else openRenameModal(null);
  });

  // ── GO (copy/move) ────────────────────────────────────────────────────────────
  $('btnGoSelected').addEventListener('click',async()=>{
    const sel=allItems.filter(i=>selectedSet.has(i.filePath));
    if(!sel.length){toast('Select PKGs first.','err');return;}
    const action=$('actionSelect').value, layout=$('layoutSelect').value;
    const renameFmt=$('renameFmtInput').value.trim()||RENAME_PRESETS[0].fmt;
    if(activeFtpDest){
      openGoModal(sel.length,action); pkgApi.offGoProgress(); pkgApi.onGoProgress(handleGoProgress);
      await pkgApi.goPkgs(sel,activeFtpDest.path||'/',action,layout,renameFmt,activeFtpDest); return;
    }
    const dest=dstInput.value.trim(); if(!dest){toast('Choose a destination folder first.','err');return;}
    const conflicts=await pkgApi.checkPkgConflicts(sel,dest,layout,renameFmt);
    if(conflicts.length>0){
      const names=conflicts.map(c=>`  • ${c.item.fileName}`).join('\n');
      if(!confirm(`${conflicts.length} file${conflicts.length>1?'s':''} already exist at destination:\n${names}\n\nOverwrite?`))return;
    }
    localStorage.setItem(K_LAST_DST,dest);addRecent(K_RECENT_DST,dest);refreshAll();
    openGoModal(sel.length,action); pkgApi.offGoProgress(); pkgApi.onGoProgress(handleGoProgress);
    await pkgApi.goPkgs(sel,dest,action,layout,renameFmt,null);
  });

  // ── Go modal ──────────────────────────────────────────────────────────────────
  const goBackdrop=$('goModalBackdrop');
  let goDone=false;
  function openGoModal(total,action){
    goDone=false; $('goModal').classList.add('busy');
    $('goModalTitle').textContent=action==='move'?`Moving ${total} PKG${total!==1?'s':''}…`:`Copying ${total} PKG${total!==1?'s':''}…`;
    $('goModalFile').textContent=''; $('goModalProgress').textContent=`0 / ${total}`;
    $('goFilebar').style.width=$('goOverallbar').style.width='0%';
    $('goModalClose').style.display='none'; $('goModalCancel').style.display='inline-flex';
    goBackdrop.style.display='flex';
  }
  // ── Transfer speed tracking: sliding-window rate + EWMA smoothing ────────────
  // Uses source timestamps (from main.js) so IPC delay doesn't skew measurements.
  const goState = { buf: [], ewmaSpeed: 0, totalFiles: 1, curFile: 0 };
  // α = 0.25: new sample gets 25% weight — responsive but not jumpy
  const EWMA_ALPHA = 0.25;

  function goSpeedEta(bytesCopied, totalBytes, ts) {
    const now = ts || Date.now();
    goState.buf.push({ t: now, b: bytesCopied });

    // Keep only samples within the last 4 seconds
    const cutoff = now - 4000;
    while (goState.buf.length > 1 && goState.buf[0].t < cutoff) goState.buf.shift();

    // Instantaneous rate over the 3-second window
    let instSpeed = 0;
    if (goState.buf.length >= 2) {
      const win = goState.buf.filter(s => s.t >= now - 3000);
      if (win.length >= 2) {
        const dt = (win[win.length-1].t - win[0].t) / 1000;
        const db = win[win.length-1].b - win[0].b;
        if (dt > 0.15 && db > 0) instSpeed = db / dt;
      }
    }

    // EWMA smoothing: dampens spikes without lagging too far behind reality
    if (instSpeed > 0) {
      goState.ewmaSpeed = goState.ewmaSpeed > 0
        ? EWMA_ALPHA * instSpeed + (1 - EWMA_ALPHA) * goState.ewmaSpeed
        : instSpeed; // seed with first real measurement
    }

    const speed = goState.ewmaSpeed;
    const remaining = totalBytes - bytesCopied;
    // ETA: use smoothed speed, clamp to 24h max, null if speed too low to be meaningful
    const eta = speed > 1024 && remaining > 0
      ? Math.min(Math.round(remaining / speed), 86400) : null;

    return { speed, eta };
  }
  function handleGoProgress(d){
    if(d.type==='go-file-start'){
      goState.buf=[];goState.ewmaSpeed=0;goState.totalFiles=d.total;goState.curFile=d.current;
      $('goModalFile').textContent=d.title||d.file; $('goModalProgress').textContent=`${d.current} / ${d.total}`;
      $('goFilebar').style.width='0%'; $('goFileSpeed').textContent=$('goFileEta').textContent=$('goFileBytes').textContent='';
      $('goOverallbar').style.width=Math.round((d.current-1)/d.total*100)+'%';
      $('goOverallPct').textContent=Math.round((d.current-1)/d.total*100)+'%';
      $('goOverallDone').textContent=`${d.current-1} of ${d.total} files`;
    } else if(d.type==='go-file-progress'){
      const pct=d.totalBytes?Math.round(d.bytesCopied/d.totalBytes*100):0;
      $('goFilebar').style.width=pct+'%'; $('goModalProgress').textContent=pct+'%';
      const{speed,eta}=goSpeedEta(d.bytesCopied,d.totalBytes,d.ts);
      $('goFileSpeed').innerHTML=speed>0?`<span class="hi">${fmtSpeed(speed)}</span>`:'';
      $('goFileEta').innerHTML=eta!==null?`ETA <span class="hi">${fmtSec(eta)}</span>`:'';
      $('goFileBytes').innerHTML=d.totalBytes?`<span class="hi">${fmtSize(d.bytesCopied)}</span> / ${fmtSize(d.totalBytes)}`:'';
    } else if(d.type==='go-file-done'){
      $('goFilebar').style.width='100%'; $('goModalProgress').textContent='100%'; $('goFileEta').textContent='✓ Done';
      const overall=Math.round(goState.curFile/goState.totalFiles*100);
      $('goOverallbar').style.width=overall+'%'; $('goOverallPct').textContent=overall+'%';
      $('goOverallDone').textContent=`${goState.curFile} of ${goState.totalFiles} files`;
    } else if(d.type==='go-file-error'){toast(`Failed: ${d.file}`,'err');}
    else if(d.type==='go-done'){
      goDone=true; $('goOverallbar').style.width='100%'; $('goOverallPct').textContent='100%';
      $('goModalTitle').textContent='Done!'; $('goModalProgress').textContent='';
      $('goModalFile').textContent=`${d.ok} transferred${d.error?', '+d.error+' failed':''}${d.skipped?', '+d.skipped+' skipped':''}`;
      $('goFileSpeed').textContent=$('goFileEta').textContent=$('goFileBytes').textContent='';
      $('goModal').classList.remove('busy'); $('goModalClose').style.display='inline-flex'; $('goModalCancel').style.display='none';
      if($('actionSelect').value==='move'){
        const moved=[...selectedSet]; allItems=allItems.filter(i=>!moved.includes(i.filePath)); selectedSet.clear(); applyFilters();
      }
    }
  }
  $('goModalCancel').addEventListener('click',()=>pkgApi.cancelOperation());
  $('goModalClose').addEventListener('click',()=>{goBackdrop.style.display='none';});
  goBackdrop.addEventListener('click',e=>{if(e.target===goBackdrop&&goDone)goBackdrop.style.display='none';});

  // ── Layout format visibility ──────────────────────────────────────────────────
  $('layoutSelect').addEventListener('change',e=>{
    const showFmt=e.target.value==='rename'||e.target.value==='rename-organize';
    $('renameFmtRow').style.display=showFmt?'flex':'none';
  });

  // ── Menu ──────────────────────────────────────────────────────────────────────
  $('topMenu').addEventListener('change',e=>{
    const v=e.target.value; e.target.value='';
    if(v==='clear'){if(!confirm('Clear all scan results?'))return;allItems=[];filteredItems=[];selectedSet.clear();renderTable();updateCounts();}
    if(v==='selectAll'){filteredItems.forEach(i=>selectedSet.add(i.filePath));renderTable();updateSelectionUI();}
    if(v==='unselectAll'){selectedSet.clear();renderTable();updateSelectionUI();}
    if(v==='exportCsv')  exportCsv();
    if(v==='checkUpdate'){pkgApi.checkForUpdates?.();toast('Checking for updates…');}
    if(v==='openLog')    pkgApi.openLog();
    if(v==='openLogFolder') pkgApi.openLogFolder();
    if(v==='about')      openAboutModal();
  });
  function exportCsv(){
    if(!allItems.length){toast('Nothing to export.');return;}
    const headers=['Title','Title ID','Category','Version','Region','Req FW','Size (bytes)','Filename','Path','Content ID'];
    const rows=allItems.map(i=>[i.title,i.titleId,categoryDisplay(i.category),i.appVer,regionDisplay(i.region),i.sysVer,i.fileSize,i.fileName,i.filePath,i.contentId].map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(','));
    const csv=[headers.join(','),...rows].join('\n');
    const blob=new Blob([csv],{type:'text/csv'}), url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url;a.download=`ps4-pkgs-${Date.now()}.csv`;a.click();URL.revokeObjectURL(url);
    toast(`Exported ${allItems.length} rows.`);
  }

  // ── Toast ──────────────────────────────────────────────────────────────────────
  let toastTimer=null;
  function toast(msg,type='ok'){
    const el=$('toast');el.textContent=msg;el.className='toast toast--'+type;el.style.display='block';
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.style.display='none';},3500);
  }

  // ── Remote install modal ──────────────────────────────────────────────────────
  const installBackdrop=$('installModalBackdrop');
  let installActive=false;
  window.installOne=(fp)=>{ const item=allItems.find(i=>i.filePath===fp); if(item)openInstallModal([item]); };
  $('btnInstallSelected').addEventListener('click',()=>{ const sel=allItems.filter(i=>selectedSet.has(i.filePath)); if(sel.length)openInstallModal(sel); });

  async function openInstallModal(items){
    const savedIp=localStorage.getItem('ps4vault.installPs4Ip')||localStorage.getItem('ps4pkgvault.csHost')||(discoveredConsole?.ip)||'';
    let savedPort=localStorage.getItem('ps4vault.installPs4Port')||'12800';
    if(['2121','21','1337','9090'].includes(savedPort)){savedPort='12800';localStorage.setItem('ps4vault.installPs4Port','12800');}
    let savedSrvPort=localStorage.getItem('ps4vault.installSrvPort')||'8090';
    if(['2121','21','1337','9090','12800'].includes(savedSrvPort)){savedSrvPort='8090';localStorage.setItem('ps4vault.installSrvPort','8090');}
    $('installPs4Ip').value=savedIp; $('installPs4Port').value=savedPort; $('installSrvPort').value=savedSrvPort;
    try{
      const localIp=await pkgApi.getLocalIp();
      $('installLocalIp').textContent=localIp; $('installBaseUrl').textContent=`http://${localIp}:${savedSrvPort}/`;
      $('installLocalIpBox').style.display='block';
    } catch{$('installLocalIpBox').style.display='none';}
    renderInstallItems(items);
    $('installDiscoverStatus').style.display='none'; $('installDiscoverStatus').textContent='';
    $('installPhaseBar').style.display='none'; $('installXferWrap').style.display='none';
    $('installWarnBox').style.display=$('installSummary').style.display='none';
    $('installWarnBox').textContent=$('installSummary').textContent='';
    $('btnInstallStart').disabled=false; $('btnInstallStart').textContent='📡 Send to PS4 / PS5';
    $('btnInstallCancel').textContent='Close'; $('btnInstallClose').style.display='flex';
    installBackdrop.dataset.items=JSON.stringify(items.map(i=>i.filePath));
    installBackdrop.style.display='flex'; setTimeout(()=>$('installPs4Ip').focus(),80);
  }

  function renderInstallItems(items,stateMap={}){
    $('installItemsList').innerHTML=items.map(item=>{
      const state=stateMap[item.filePath]||{};
      const icon=state.icon||(item.isFtp?'📡':'📦');
      const statusText=state.status||(item.isFtp?'⚠ FTP — will be skipped':'Waiting…');
      const pct=state.percent??0, cls=state.cls||(item.isFtp?'ii-error':'');
      return `<div class="install-item ${cls}" id="ii-${escAttr(item.filePath)}">
        <div class="ii-icon">${icon}</div>
        <div class="ii-info">
          <div class="ii-name" title="${escHtml(item.filePath)}">${escHtml(item.title||item.fileName)}</div>
          <div class="ii-status" id="ii-status-${escAttr(item.filePath)}">${statusText}</div>
          <div class="ii-bar-wrap" id="ii-bar-wrap-${escAttr(item.filePath)}" style="display:${state.showBar?'block':'none'}">
            <div class="ii-bar" id="ii-bar-${escAttr(item.filePath)}" style="width:${pct}%"></div>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // ── Install: discover PS4 ─────────────────────────────────────────────────────
  $('btnDiscoverPs4').addEventListener('click',async()=>{
    const btn=$('btnDiscoverPs4'), status=$('installDiscoverStatus');
    btn.disabled=true; btn.textContent='⏳ Scanning…'; status.style.display='block'; status.textContent='Scanning local network for PS4/PS5…';
    pkgApi.offDiscoverProgress(); pkgApi.onDiscoverProgress(d=>{
      if(d.type==='found'){
        const note=d.installerOpen?' — Remote PKG Installer ready ✓':` — found on FTP:${d.ftpPort||2121} (open Remote PKG Installer on console)`;
        status.style.color=d.installerOpen?'#4ade80':'#facc15'; status.textContent=`${d.consoleType||'Console'} at ${d.ip}${note}`;
        showDiscoveredChip(d);
      } else if(d.type==='batch-done'){if(status.textContent.startsWith('Scanning'))status.textContent=`Scanning… ${d.scanned}/${d.total} hosts`;}
      else if(d.type==='done'){
        btn.disabled=false; btn.textContent='🔍 Find IP';
        if(!d.found||!d.found.length){status.style.color='#f87171';status.textContent='✗ No console found — ensure PS4/PS5 FTP or Remote PKG Installer is running';}
      }
    });
    await pkgApi.discoverPs4(); btn.disabled=false; btn.textContent='🔍 Find IP'; pkgApi.offDiscoverProgress();
  });
  $('installSrvPort').addEventListener('input',async()=>{
    try{const ip=await pkgApi.getLocalIp();$('installBaseUrl').textContent=`http://${ip}:${$('installSrvPort').value||'8090'}/`;}catch{}
  });
  $('btnTestPs4Conn').addEventListener('click',async()=>{
    const btn=$('btnTestPs4Conn'), status=$('installDiscoverStatus');
    const ps4Ip=$('installPs4Ip').value.trim(), ps4Port=parseInt($('installPs4Port').value)||12800;
    if(!ps4Ip){toast('Enter the PS4/PS5 IP address first.','err');return;}
    if([2121,21,1337,9090].includes(ps4Port)){toast(`⚠ Port ${ps4Port} is an FTP port — installer uses port 12800.`,'err');$('installPs4Port').value='12800';return;}
    btn.disabled=true; btn.textContent='⏳ Testing…'; status.style.display='block'; status.style.color=''; status.textContent=`Testing ${ps4Ip}:${ps4Port}…`;
    const result=await pkgApi.testPs4Conn(ps4Ip,ps4Port);
    btn.disabled=false; btn.textContent='🔌 Test Connection';
    if(result.ok){status.style.color='#4ade80';status.textContent=`✓ PS4 installer reachable at ${ps4Ip}:${ps4Port} — ready to install`;$('installWarnBox').style.display='none';}
    else{status.style.color='#f87171';status.textContent=`✗ ${result.error}`;$('installWarnBox').textContent=result.error;$('installWarnBox').style.display='block';}
  });

  $('btnInstallStart').addEventListener('click',async()=>{
    const ps4Ip=$('installPs4Ip').value.trim(), ps4Port=parseInt($('installPs4Port').value)||12800, srvPort=parseInt($('installSrvPort').value)||8090;
    if(!ps4Ip){toast('Enter the PS4/PS5 IP address.','err');$('installPs4Ip').focus();return;}
    if([2121,21,1337,9090].includes(ps4Port)){toast(`⚠ Port ${ps4Port} is an FTP port — installer uses port 12800.`,'err');$('installPs4Port').value='12800';$('installPs4Port').focus();return;}
    if([2121,21,9090,12800,1337].includes(srvPort)){toast(`⚠ Server port ${srvPort} conflicts with a console port.`,'err');$('installSrvPort').value='8090';$('installSrvPort').focus();return;}
    localStorage.setItem('ps4vault.installPs4Ip',ps4Ip); localStorage.setItem('ps4vault.installPs4Port',String(ps4Port));
    localStorage.setItem('ps4vault.installSrvPort',String(srvPort)); localStorage.setItem('ps4pkgvault.csHost',ps4Ip);
    const fps=JSON.parse(installBackdrop.dataset.items||'[]'), items=fps.map(fp=>allItems.find(i=>i.filePath===fp)).filter(Boolean);
    if(!items.length)return;
    installActive=true; $('btnInstallStart').disabled=true; $('btnInstallStart').textContent='⏳ Installing…';
    $('btnInstallCancel').textContent='Cancel'; $('btnInstallClose').style.display='none';
    $('installWarnBox').style.display=$('installSummary').style.display='none';
    $('installPhaseBar').style.display=$('installXferWrap').style.display='none';
    $('installElapsed').textContent=''; $('installXferBar').style.width='0%';
    items.forEach(item=>{
      const el=document.getElementById(`ii-${item.filePath}`); if(el)el.className='install-item';
      const st=document.getElementById(`ii-status-${item.filePath}`); if(st)st.textContent=item.isFtp?'⚠ FTP — will be skipped':'Queued…';
      const bw=document.getElementById(`ii-bar-wrap-${item.filePath}`); if(bw)bw.style.display='none';
    });
    pkgApi.offInstallProgress(); pkgApi.onInstallProgress(handleInstallProgress);
    const result=await pkgApi.remoteInstall(items,ps4Ip,ps4Port,srvPort);
    installActive=false; $('btnInstallStart').disabled=false; $('btnInstallStart').textContent='📡 Send to PS4 / PS5 Again';
    $('btnInstallCancel').textContent='Close'; $('btnInstallClose').style.display='flex';
    if(result&&!result.ok&&result.error){toast('Install error: '+result.error,'err');$('installWarnBox').textContent='✗ '+result.error;$('installWarnBox').style.display='block';}
  });

  // ── Install phase tracking ────────────────────────────────────────────────────
  let installStartTime=null, installElapsedTimer=null;
  let installXferSamples=[], installXferLastBytes=0, installXferLastTime=0;

  function installSetPhase(label,detail,state){
    $('installPhaseBar').style.display='block';
    $('installPhaseLabel').textContent=label; $('installPhaseDetail').textContent=detail||'';
    $('installPhaseSpinner').className='phase-spinner'+(state==='done'?' done':state==='error'?' error':'');
  }
  function installStartElapsed(){
    installStartTime=Date.now(); clearInterval(installElapsedTimer);
    installElapsedTimer=setInterval(()=>{
      if(!installActive){clearInterval(installElapsedTimer);return;}
      const sec=Math.floor((Date.now()-installStartTime)/1000);
      const hh=Math.floor(sec/3600), mm=Math.floor((sec%3600)/60), ss=sec%60;
      const str=hh?`${hh}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`:`${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
      const el=$('installElapsed'); if(el)el.textContent=str;
    },1000);
  }
  function installStopElapsed(){clearInterval(installElapsedTimer);}
  function installResetXfer(){installXferSamples=[];installXferLastBytes=0;installXferLastTime=0;_installEwmaSpeed=0;}
  let _installEwmaSpeed = 0;
  function installUpdateXfer(bytesSent,totalBytes,preCalcSpeed){
    // Single EWMA pass on the server's pre-calculated speed — no double-smoothing
    if (preCalcSpeed > 1024) {
      _installEwmaSpeed = _installEwmaSpeed > 0
        ? 0.3 * preCalcSpeed + 0.7 * _installEwmaSpeed
        : preCalcSpeed;
    }
    const speed = _installEwmaSpeed;
    const pct = totalBytes > 0 ? Math.round(bytesSent / totalBytes * 100) : null;
    const remaining = totalBytes - bytesSent;
    const eta = speed > 1024 && remaining > 0
      ? Math.min(Math.round(remaining / speed), 86400) : null;
    $('installXferWrap').style.display='block';
    $('installXferBar').style.width=(pct??0)+'%';
    $('installXferSpeed').innerHTML=speed>0?`<span class="hi">${fmtSpeed(speed)}</span>`:'';
    $('installXferEta').innerHTML=eta!==null?`ETA <span class="hi">${fmtSec(eta)}</span>`:'';
    $('installXferBytes').innerHTML=totalBytes?`<span class="hi">${fmtSize(bytesSent)}</span> / <span style="color:var(--muted)">${fmtSize(totalBytes)}</span>`:'';
    return pct;
  }

  function handleInstallProgress(d){
    if(d.type==='install-connecting'){
      installStartElapsed(); installSetPhase('Connecting…',`Reaching ${d.ps4Ip}:${d.ps4Port}`,'active');
      $('installDiscoverStatus').style.display='none';
    } else if(d.type==='install-ps4-unreachable'){
      installStopElapsed(); installSetPhase('Connection failed',d.message.split('\n')[0],'error');
      $('installWarnBox').innerHTML=d.message.replace(/\n/g,'<br>'); $('installWarnBox').style.display='block';
      $('btnInstallStart').disabled=false; $('btnInstallStart').textContent='📡 Send to PS4 / PS5';
      $('btnInstallCancel').textContent='Close'; $('btnInstallClose').style.display='flex'; installActive=false;
    } else if(d.type==='install-ps4-ok'){
      installSetPhase('Connected ✓',`${d.ps4Ip}:${d.ps4Port} — detecting installer type…`,'active');
    } else if(d.type==='install-warn'){
      const msg=d.message||'';
      if(msg.startsWith('📡 Installer:')) installSetPhase('Connected ✓',msg,'active');
      else if(!msg.includes('Firewall')&&!msg.includes('port rule')){
        $('installWarnBox').innerHTML=msg.replace(/\n/g,'<br>'); $('installWarnBox').style.display='block';
      }
    } else if(d.type==='install-server-ready'){
      installSetPhase('File server ready',`http://${d.localIp}:${d.serverPort}/ — waiting for PS4/PS5…`,'active');
      $('installLocalIp').textContent=d.localIp; $('installBaseUrl').textContent=`http://${d.localIp}:${d.serverPort}/`;
      $('installLocalIpBox').style.display='block';
    } else if(d.type==='install-file-start'){
      installResetXfer(); const el=findItemEl(d.file); if(el)el.className='install-item ii-active';
      setItemPhase(d.file,'sending'); setItemStatus(d.file,'Sending install command to PS4/PS5…');
      installSetPhase('Sending command',d.title||d.file,'active');
    } else if(d.type==='install-file-queued'){
      setItemPhase(d.file,'dl'); const tid=d.taskId!==null?` (task #${d.taskId})`:'';
      setItemStatus(d.file,`Command accepted${tid} — waiting for PS4/PS5 to start download…`);
      setItemBar(d.file,0,true); installSetPhase('Command accepted','Waiting for PS4/PS5 to connect and start download…','active');
    } else if(d.type==='install-xfer-progress'){
      const pct=installUpdateXfer(d.bytesSent,d.totalBytes,d.speed);
      const speed=installXferSamples.length?fmtSpeed(installXferSamples.reduce((a,b)=>a+b,0)/installXferSamples.length):'';
      const eta=d.eta!==null?fmtSec(d.eta):'', bytes=d.totalBytes?`${fmtSize(d.bytesSent)} / ${fmtSize(d.totalBytes)}`:'';
      setItemTitle(d.file,d.title||d.file); setItemPhase(d.file,'dl');
      setItemStatus(d.file,pct!==null?`Downloading — ${pct}%`:'Downloading…');
      setItemStats(d.file,speed,eta,bytes); if(pct!==null)setItemBar(d.file,pct,true);
      installSetPhase('PS4/PS5 downloading',[pct!==null?pct+'%':'',speed,eta?'ETA '+eta:'',bytes].filter(Boolean).join('  ·  '),'active');
    } else if(d.type==='install-task-progress'){
      const pct=d.percent??null, eta=d.rest?fmtSec(d.rest):'', bytes=d.transferred?fmtSize(d.transferred):'';
      const status=(d.status&&d.status!=='null')?d.status:'';
      setItemPhase(d.file,'dl'); setItemStatus(d.file,status||(pct!==null?`Installing — ${pct}%`:'Installing…'));
      setItemStats(d.file,'',eta,bytes); if(pct!==null)setItemBar(d.file,pct,true);
    } else if(d.type==='install-file-done'){
      const el=findItemEl(d.file); if(el)el.className='install-item ii-done';
      setItemPhase(d.file,'done'); setItemStatus(d.file,'Install queued on PS4/PS5 — check console notifications');
      setItemStats(d.file,'','',''); setItemBar(d.file,100,true);
      installSetPhase('Complete ✓','Check PS4/PS5 notifications for install progress','done');
    } else if(d.type==='install-file-error'){
      const el=findItemEl(d.file); if(el)el.className='install-item ii-error';
      setItemPhase(d.file,'error'); setItemStatus(d.file,d.error||'Unknown error');
      installSetPhase('Failed',(d.error||'').split('\n')[0],'error');
    } else if(d.type==='install-done'){
      installStopElapsed();
      const parts=[`${d.ok} sent`]; if(d.failed)parts.push(`${d.failed} failed`); if(d.skipped)parts.push(`${d.skipped} skipped`);
      $('installSummary').textContent=parts.join(' · '); $('installSummary').style.display='block';
      if(d.failed===0&&d.ok>0)toast(`✅ ${d.ok} PKG${d.ok!==1?'s':''} sent to PS4/PS5!`);
      else if(d.ok===0)toast('Install failed — check the modal for details.','err');
    }
  }

  function findItemEl(fp){
    return document.getElementById(`ii-${fp}`)||
      [...($('installItemsList')?.querySelectorAll('.install-item')||[])].find(el=>el.querySelector('.ii-name')?.title?.includes(fp));
  }
  function setItemStatus(fp,text){const el=document.getElementById(`ii-status-${fp}`)||findItemEl(fp)?.querySelector('.ii-status');if(el)el.textContent=text;}
  function setItemTitle(fp,title){const el=findItemEl(fp)?.querySelector('.ii-name');if(el&&title)el.textContent=title;}
  function setItemPhase(fp,phase){
    const el=findItemEl(fp); if(!el)return;
    let badge=el.querySelector('.ii-phase');
    if(!badge){badge=document.createElement('span');badge.className='ii-phase';el.querySelector('.ii-name')?.prepend(badge);}
    const labels={wait:'Waiting',sending:'Sending',dl:'Downloading',done:'Done',error:'Failed'};
    badge.className=`ii-phase ii-phase-${phase}`; badge.textContent=labels[phase]||phase;
  }
  function setItemStats(fp,speed,eta,bytes){
    let el=findItemEl(fp)?.querySelector('.ii-stats');
    if(!el){
      const wrap=findItemEl(fp); if(wrap){el=document.createElement('div');el.className='ii-stats';wrap.querySelector('.ii-status')?.insertAdjacentElement('afterend',el);}
    }
    if(!el)return;
    const parts=[];
    if(speed)parts.push(`<span class="hi">${speed}</span>`);
    if(eta)parts.push(`ETA <span class="hi">${eta}</span>`);
    if(bytes)parts.push(`<span class="hi">${bytes}</span>`);
    el.innerHTML=parts.join('<span style="opacity:.3">·</span>');
  }
  function setItemBar(fp,pct,show){
    const bw=document.getElementById(`ii-bar-wrap-${fp}`), b=document.getElementById(`ii-bar-${fp}`);
    if(bw)bw.style.display=show?'block':'none'; if(b)b.style.width=pct+'%';
  }

  $('btnInstallCancel').addEventListener('click',closeInstallModal);
  $('btnInstallClose').addEventListener('click', closeInstallModal);
  installBackdrop.addEventListener('click',e=>{if(e.target===installBackdrop&&!installActive)closeInstallModal();});
  function closeInstallModal(){
    if(installActive){
      pkgApi.cancelOperation(); installActive=false;
      $('btnInstallStart').disabled=false; $('btnInstallStart').textContent='📡 Send to PS4 / PS5';
      $('btnInstallCancel').textContent='Close'; $('btnInstallClose').style.display='flex';
      installStopElapsed(); installSetPhase('Cancelled','Install was cancelled','error');
      return;
    }
    installBackdrop.style.display='none'; pkgApi.offInstallProgress();
  }

  // ── Context menu ──────────────────────────────────────────────────────────────
  const ctxMenu=$('ctxMenu');
  window.showCtxMenu=(x,y,fp)=>{
    ctxTarget=fp; const item=allItems.find(i=>i.filePath===fp);
    ctxMenu.style.display='block'; ctxMenu.style.left=Math.min(x,window.innerWidth-200)+'px'; ctxMenu.style.top=Math.min(y,window.innerHeight-220)+'px';
    if(item&&!selectedSet.has(fp)){selectedSet.clear();selectedSet.add(fp);viewMode==='grid'?renderGrid():renderTable();}
  };
  function hideCtxMenu(){ctxMenu.style.display='none';ctxTarget=null;}
  document.addEventListener('click',hideCtxMenu);
  ctxMenu.addEventListener('click',e=>e.stopPropagation());
  $('ctxInstall').addEventListener('click',()=>{if(!ctxTarget)return;hideCtxMenu();installOne(ctxTarget);});
  $('ctxShowFolder').addEventListener('click',()=>{if(!ctxTarget)return;hideCtxMenu();pkgApi.showInFolder(ctxTarget);});
  $('ctxCopyName').addEventListener('click',()=>{const item=ctxTarget&&allItems.find(i=>i.filePath===ctxTarget);if(item){pkgApi.copyToClipboard(item.fileName);toast('Filename copied');}hideCtxMenu();});
  $('ctxCopyId').addEventListener('click',()=>{const item=ctxTarget&&allItems.find(i=>i.filePath===ctxTarget);if(item&&item.titleId){pkgApi.copyToClipboard(item.titleId);toast('CUSA ID copied');}hideCtxMenu();});
  $('ctxRename').addEventListener('click',()=>{const item=ctxTarget&&allItems.find(i=>i.filePath===ctxTarget);if(item){hideCtxMenu();openRenameModal(item);}});
  $('ctxDelete').addEventListener('click',()=>{const fp=ctxTarget;hideCtxMenu();if(fp)deleteOne(fp);});

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  document.addEventListener('keydown',e=>{
    const tag=document.activeElement?.tagName, inInput=['INPUT','SELECT','TEXTAREA'].includes(tag);
    if((e.ctrlKey||e.metaKey)&&e.key==='a'&&!inInput){e.preventDefault();filteredItems.forEach(i=>selectedSet.add(i.filePath));renderTable();updateSelectionUI();return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='f'){e.preventDefault();$('searchInput').focus();$('searchInput').select();return;}
    if(e.key==='Escape'&&!inInput){if(ctxMenu.style.display!=='none'){hideCtxMenu();return;}selectedSet.clear();renderTable();updateSelectionUI();return;}
    if((e.key==='Delete'||e.key==='Backspace')&&!inInput&&selectedSet.size>0){e.preventDefault();$('btnDeleteSelected').click();return;}
    if(e.key==='Enter'&&!inInput&&selectedSet.size>0){const sel=allItems.filter(i=>selectedSet.has(i.filePath));if(sel.length)openInstallModal(sel);}
  });

  // ── About modal ───────────────────────────────────────────────────────────────
  function openAboutModal(){
    const bl=$('brandLogo'), al=$('aboutLogo'); if(bl&&al&&bl.src)al.src=bl.src;
    pkgApi.getLogPath().then(p=>{const el=$('aboutLogPath');if(el){el.textContent='📋 Log: '+p;el.title='Click to open log folder';}}).catch(()=>{});
    $('aboutModalBackdrop').style.display='flex';
  }
  function closeAboutModal(){$('aboutModalBackdrop').style.display='none';}
  $('btnAboutClose').addEventListener('click',closeAboutModal);
  $('btnAboutOk').addEventListener('click',closeAboutModal);
  $('btnAboutDiscord').addEventListener('click',()=>pkgApi.openExternal('https://discord.gg/nj45kDSBEd'));
  $('btnAboutViewLog').addEventListener('click',()=>pkgApi.openLog());
  $('aboutLogPath').addEventListener('click',()=>pkgApi.openLogFolder());
  $('aboutModalBackdrop').addEventListener('click',e=>{if(e.target===$('aboutModalBackdrop'))closeAboutModal();});

  // ── Auto-updater banner ───────────────────────────────────────────────────────
  (function(){
    if(!pkgApi.onUpdateStatus) return;
    const banner=$('updateBanner'), msg=$('updateMsg'), progress=$('updateProgress');
    const btnDl=$('btnUpdateDownload'), btnInst=$('btnUpdateInstall'), btnDism=$('btnUpdateDismiss');
    if(!banner) return;
    pkgApi.onUpdateStatus(d=>{
      if(d.type==='available'){
        msg.innerHTML=`<strong>Update available — PS4 Vault v${d.version}</strong>  A new version is ready to download.`;
        progress.textContent=''; btnDl.style.display='inline-block'; btnInst.style.display='none'; banner.classList.add('show');
      } else if(d.type==='downloading'){
        msg.innerHTML='<strong>Downloading update…</strong>'; progress.textContent=`${d.percent}%  ${fmtSpeed(d.speed)}`;
        btnDl.style.display='none'; banner.classList.add('show');
      } else if(d.type==='downloaded'){
        msg.innerHTML=`<strong>Update ready — v${d.version}</strong>  Restart PS4 Vault to install.`;
        progress.textContent=''; btnDl.style.display='none'; btnInst.style.display='inline-block'; banner.classList.add('show');
        toast('✅ Update ready — click Restart & Install in the banner.');
      } else if(d.type==='error'){console.warn('[updater]',d.message);}
    });
    if(btnDl) btnDl.addEventListener('click',()=>pkgApi.downloadUpdate?.());
    if(btnInst) btnInst.addEventListener('click',()=>pkgApi.installUpdate?.());
    if(btnDism) btnDism.addEventListener('click',()=>{banner.classList.remove('show');});
  })();

  // ── Init ──────────────────────────────────────────────────────────────────────
  if(typeof updateFtpDestUI==='function') updateFtpDestUI();
  renderTable(); updateCounts();
})();
