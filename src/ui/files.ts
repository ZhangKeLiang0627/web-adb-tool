import type { AdbClient, PushItem, RemoteEntry } from '../core/adb';

/**
 * 文件管理器：目录浏览（readdir）+ 多选操作台（上传/下载/新建/改名/权限）+ 批量传输。
 * 注：删除不在 UI 提供——adbd 对非交互 shell 会话支持不全，删除请直接在 Shell 栏用 rm。
 * 与 Shell 面板共用同一个 AdbClient；断开连接时所有控件自动禁用。
 */

interface LogLine {
  text: string;
  cls: 'ok' | 'err' | '';
}

export function initFiles(client: AdbClient): void {
  const body = document.querySelector('.panel-files') as HTMLElement;
  const pathInput = document.getElementById('fm-path') as HTMLInputElement;
  const goBtn = document.getElementById('fm-go') as HTMLButtonElement;
  const crumbs = document.getElementById('fm-crumbs') as HTMLDivElement;
  const upBtn = document.getElementById('fm-up') as HTMLButtonElement;
  const refreshBtn = document.getElementById('fm-refresh') as HTMLButtonElement;
  const checkAll = document.getElementById('fm-check-all') as HTMLInputElement;
  const listEl = document.getElementById('fm-list') as HTMLDivElement;

  const uploadBtn = document.getElementById('fm-upload-files') as HTMLButtonElement;
  const uploadDirBtn = document.getElementById('fm-upload-dir') as HTMLButtonElement;
  const mkdirBtn = document.getElementById('fm-mkdir') as HTMLButtonElement;
  const downloadBtn = document.getElementById('fm-download') as HTMLButtonElement;
  const renameBtn = document.getElementById('fm-rename') as HTMLButtonElement;
  const chmodBtn = document.getElementById('fm-chmod') as HTMLButtonElement;

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dirInput = document.getElementById('dir-input') as HTMLInputElement;
  const progress = document.getElementById('file-progress') as HTMLDivElement;
  const progressBar = progress.querySelector('.progress-bar') as HTMLDivElement;
  const progressText = document.getElementById('file-progress-text') as HTMLDivElement;
  const logEl = document.getElementById('file-log') as HTMLDivElement;

  // ---------- 状态 ----------
  let path = '/';
  let entries: RemoteEntry[] = [];
  const selected = new Set<string>();
  let busy = false;
  const logs: LogLine[] = [];

  // ---------- 控件可用态 ----------
  function refreshControlState(): void {
    const connected = client.connected;
    const hasSel = selected.size > 0;
    const busyDisabled = connected && !busy;
    for (const el of [goBtn, upBtn, refreshBtn, mkdirBtn, uploadBtn, uploadDirBtn]) {
      el.disabled = !busyDisabled;
    }
    downloadBtn.disabled = !(busyDisabled && hasSel);
    renameBtn.disabled = !(busyDisabled && hasSel);
    chmodBtn.disabled = !(busyDisabled && hasSel);
    pathInput.disabled = !connected;
    updateOpLabels();
  }

  function updateOpLabels(): void {
    downloadBtn.textContent = selected.size ? `下载选中(${selected.size})` : '下载选中';
  }

  client.onStateChange((connected) => {
    if (!connected) {
      entries = [];
      selected.clear();
      path = '/';
      renderList();
      renderCrumbs();
      logs.length = 0;
      renderLogs();
    }
    refreshControlState();
    if (connected) {
      void refresh();
    }
  });

  // ---------- 日志 / 进度 ----------
  function log(text: string, cls: 'ok' | 'err' | '' = ''): void {
    logs.push({ text, cls });
    if (logs.length > 60) logs.shift();
    renderLogs();
  }

  function renderLogs(): void {
    logEl.textContent = logs.map((l) => l.text).join('\n');
    const last = logs[logs.length - 1];
    logEl.className = 'file-log' + (last && last.cls ? ` ${last.cls}` : '');
  }

  /** 进度跟踪器：累计字节/瞬时速率 */
  function createMeter() {
    let start = 0;
    let lastDone = 0;
    let lastTime = 0;
    return {
      reset(): void {
        start = performance.now();
        lastDone = 0;
        lastTime = start;
        progress.classList.remove('visible');
        progressBar.style.width = '0%';
        progressText.textContent = '';
      },
      update(done: number, total: number): void {
        const now = performance.now();
        const percent = total > 0 ? (done / total) * 100 : 0;
        progress.classList.add('visible');
        progressBar.style.width = `${Math.min(100, Math.max(0, percent)).toFixed(1)}%`;
        const dt = now - lastTime;
        const speed = dt > 0 ? ((done - lastDone) / dt) * 1000 : 0;
        lastDone = done;
        lastTime = now;
        progressText.textContent =
          `${formatBytes(done)} / ${total > 0 ? formatBytes(total) : '未知'}` +
          ` · ${formatBytes(speed)}/s · ${percent.toFixed(1)}%`;
      },
      setLabel(text: string): void {
        progressText.textContent = text;
      },
      elapsed(): string {
        return ((performance.now() - start) / 1000).toFixed(1);
      },
    };
  }

  // ---------- 路径与目录浏览 ----------
  function normalizePath(raw: string): string | null {
    let p = raw.trim();
    if (!p) return null;
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/\/{2,}/g, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p;
  }

  function joinPath(parent: string, name: string): string {
    return parent === '/' ? parent + name : `${parent}/${name}`;
  }

  function parentOf(p: string): string {
    const i = p.lastIndexOf('/');
    if (i <= 0) return '/';
    return p.slice(0, i);
  }

  async function go(raw: string): Promise<void> {
    const p = normalizePath(raw);
    if (!p) return;
    try {
      const list = await client.listDir(p);
      path = p;
      entries = list;
      selected.clear();
      pathInput.value = p;
      localStorage.setItem('fm:lastPath', p);
      renderCrumbs();
      renderList();
      refreshControlState();
    } catch (e) {
      log(`无法打开 ${raw}：${toChinese(e)}`, 'err');
    }
  }

  async function refresh(): Promise<void> {
    await go(path || '/');
  }

  function renderCrumbs(): void {
    crumbs.textContent = '';
    const parts = path.split('/').filter(Boolean);
    const pushSeg = (label: string, target: string, first = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost fm-crumb' + (first ? ' fm-crumb-root' : '');
      b.textContent = label;
      b.addEventListener('click', () => void go(target));
      crumbs.appendChild(b);
    };
    pushSeg('/', '/', true);
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      pushSeg(part, acc);
    }
    upBtn.disabled = path === '/' || busy;
  }

  // ---------- 列表渲染 ----------
  function renderList(): void {
    listEl.textContent = '';
    if (!client.connected) {
      listEl.appendChild(emptyRow('连接设备后可浏览文件系统'));
      return;
    }
    if (entries.length === 0) {
      listEl.appendChild(emptyRow('（空目录）'));
      return;
    }

    // 表头全选态
    const visible = entries.map((e) => e.path);
    const allChecked = visible.length > 0 && visible.every((p) => selected.has(p));
    checkAll.checked = allChecked;
    checkAll.indeterminate = !allChecked && visible.some((p) => selected.has(p));

    for (const entry of entries) {
      listEl.appendChild(renderRow(entry));
    }
  }

  function emptyRow(text: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'fm-empty';
    row.textContent = text;
    return row;
  }

  function renderRow(entry: RemoteEntry): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'fm-row' + (selected.has(entry.path) ? ' selected' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'fm-cb';
    cb.checked = selected.has(entry.path);
    cb.addEventListener('change', (ev) => {
      ev.stopPropagation();
      toggleSelect(entry.path);
    });

    const bullet = document.createElement('span');
    bullet.className = 'fm-bullet' + (entry.isDir ? ' dir' : '');

    const name = document.createElement('span');
    name.className = 'fm-name' + (entry.isDir ? ' is-dir' : '');
    const nameText = document.createElement('span');
    nameText.className = 'fm-name-text';
    nameText.textContent = entry.isDir ? entry.name + '/' : entry.name;
    name.append(bullet, nameText);
    name.title = `${entry.path}\n${formatBytes(entry.size)} · ${octal(entry.permission)} · ${fmtTime(entry.mtime)}`;

    const size = document.createElement('span');
    size.className = 'fm-meta';
    size.textContent = entry.isDir ? '—' : formatBytes(entry.size);

    // 行内恰好 3 个元素 = 表头 3 列：复选框 | 名称(含目录小方块) | 大小
    row.append(cb, name, size);

    // 单击 = 选中/取消；双击 = 目录进入 / 文件直接下载
    row.addEventListener('click', () => toggleSelect(entry.path));
    row.addEventListener('dblclick', () => {
      if (busy) return;
      if (entry.isDir) void go(entry.path);
      else void downloadSingle(entry);
    });
    return row;
  }

  function toggleSelect(p: string): void {
    if (busy) return;
    if (selected.has(p)) selected.delete(p);
    else selected.add(p);
    renderList();
    refreshControlState();
  }

  checkAll.addEventListener('change', () => {
    if (busy) return;
    if (checkAll.checked) {
      for (const e of entries) selected.add(e.path);
    } else {
      for (const e of entries) selected.delete(e.path);
    }
    renderList();
    refreshControlState();
  });

  // ---------- 传输（上传 / 下载 / 目录打包） ----------
  function collectUploadItems(files: FileList | File[]): PushItem[] {
    const items: PushItem[] = [];
    for (const file of Array.from(files)) {
      const rel = file.webkitRelativePath || file.name;
      items.push({ file, targetPath: joinPath(path, rel) });
    }
    return items;
  }

  async function doUpload(items: PushItem[]): Promise<void> {
    if (items.length === 0) return;
    const meter = createMeter();
    setBusy(true);
    meter.reset();
    log(`开始上传 ${items.length} 个文件 → ${path}`, '');
    try {
      await client.pushFiles(items, (label, idx, total) => {
        log(`[${idx}/${total}] ${label}`, '');
        meter.setLabel(`正在上传 ${label}`);
      }, meter.update);
      const bytes = items.reduce((s, it) => s + it.file.size, 0);
      log(`上传完成：${items.length} 个文件（${formatBytes(bytes)}，用时 ${meter.elapsed()}s）`, 'ok');
      void refresh();
    } catch (e) {
      log(`上传失败：${toChinese(e)}`, 'err');
    } finally {
      setBusy(false);
      meter.reset();
    }
  }

  /** 把选中项展开为扁平文件列表（目录递归），返回 zip 内相对路径 */
  async function collectForDownload(): Promise<
    { rel: string; path: string; size: number }[] | null
  > {
    const out: { rel: string; path: string; size: number }[] = [];
    for (const p of Array.from(selected)) {
      const entry = entries.find((e) => e.path === p);
      if (!entry) continue;
      if (!entry.isDir) {
        out.push({ rel: entry.name, path: entry.path, size: entry.size });
      } else {
        log(`正在扫描目录 ${entry.path} …`, '');
        const refs = await client.listTree(entry.path);
        for (const r of refs) {
          // zip 内相对路径取「选中目录名/…」层级，避免多个目录重名冲突
          out.push({ rel: joinPath(entry.name, stripPrefix(r.path, entry.path)), path: r.path, size: r.size });
        }
      }
    }
    if (out.length === 0) {
      log('没有可下载的文件（目录可能为空或只含符号链接）', 'err');
      return null;
    }
    return out;
  }

  function stripPrefix(full: string, dir: string): string {
    const p = dir.endsWith('/') ? dir : dir + '/';
    return full.startsWith(p) ? full.slice(p.length) : full;
  }

  /** 下载完成后清空勾选并复位按钮态（避免残留选中导致按钮仍可点/显示旧计数） */
  function clearSelection(): void {
    if (selected.size === 0) return;
    selected.clear();
    renderList();
    refreshControlState();
  }

  /** 单选一个普通文件：直接下载原名 */
  async function downloadSingle(entry: RemoteEntry): Promise<void> {
    if (busy) return;
    const meter = createMeter();
    setBusy(true);
    meter.reset();
    log(`正在下载 ${entry.path} …`, '');
    try {
      const blob = await client.pullFile(entry.path, meter.update);
      downloadBlob(blob, entry.name);
      log(`下载完成：${entry.name}（${formatBytes(blob.size)}，用时 ${meter.elapsed()}s）`, 'ok');
      clearSelection();
    } catch (e) {
      log(`下载失败：${toChinese(e)}`, 'err');
    } finally {
      setBusy(false);
      meter.reset();
    }
  }

  /** 选中多文件/目录：单文件直下，其余打成 zip 一次性下载 */
  async function downloadSelection(): Promise<void> {
    if (selected.size === 0) return;
    // 仅选了一个普通文件 → 直接下载（downloadSingle 自行管理 busy，
    // 不能在此先 setBusy，否则它的 busy 守卫会直接 return）
    if (selected.size === 1) {
      const entry = entries.find((e) => e.path === Array.from(selected)[0]);
      if (entry && !entry.isDir) {
        await downloadSingle(entry);
        return;
      }
    }
    const meter = createMeter();
    setBusy(true);
    meter.reset();
    try {
      const list = await collectForDownload();
      if (!list) return;

      const total = list.reduce((s, it) => s + it.size, 0);
      // 按需加载 jszip（仅打包下载时才引入，避免拖慢首屏）
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        meter.setLabel(`正在下载 [${i + 1}/${list.length}] ${it.path}`);
        log(`[${i + 1}/${list.length}] ${it.path}`, '');
        const blob = await client.pullFile(it.path, meter.update);
        zip.file(it.rel, blob);
      }
      meter.setLabel('正在打包 zip …');
      const baseName = zipBaseName();
      const content = await zip.generateAsync({
        type: 'blob',
        compression: 'STORE', // 设备文件多为已压缩媒体/二进制，STORE 更快
      });
      downloadBlob(content, baseName + '.zip');
      log(
        `打包完成：${baseName}.zip（${list.length} 个文件，${formatBytes(total)}，用时 ${meter.elapsed()}s）`,
        'ok',
      );
      clearSelection();
    } catch (e) {
      log(`下载失败：${toChinese(e)}`, 'err');
    } finally {
      setBusy(false);
      meter.reset();
    }
  }

  function zipBaseName(): string {
    const dirs = Array.from(selected).filter((p) => entries.find((e) => e.path === p)?.isDir);
    if (dirs.length === 1) {
      const name = dirs[0].split('/').filter(Boolean).pop() || 'folder';
      return name;
    }
    return selected.size === 1 ? 'download' : `selected-${selected.size}`;
  }

  // ---------- 文件操作（新建 / 改名 / 权限） ----------
  async function mkdirAction(): Promise<void> {
    const name = window.prompt('新建目录名称（仅名称，不含 /）', 'newdir');
    if (!name) return;
    if (name.includes('/')) {
      log('目录名不能包含 /', 'err');
      return;
    }
    try {
      await client.makeRemoteDir(joinPath(path, name.trim()));
      log(`已创建目录 ${joinPath(path, name.trim())}`, 'ok');
      void refresh();
    } catch (e) {
      log(`创建目录失败：${toChinese(e)}`, 'err');
    }
  }

  async function renameAction(): Promise<void> {
    if (selected.size !== 1) {
      log('改名每次只能针对一个条目', 'err');
      return;
    }
    const p = Array.from(selected)[0];
    const entry = entries.find((e) => e.path === p);
    if (!entry) return;
    const name = window.prompt('重命名（仅名称，不含 /）', entry.name);
    if (!name || name === entry.name) return;
    const target = joinPath(parentOf(entry.path), name.trim());
    if (name.includes('/')) {
      log('名称不能包含 /', 'err');
      return;
    }
    try {
      await client.renameRemote(entry.path, target);
      log(`已改名 ${entry.name} → ${name.trim()}`, 'ok');
      void refresh();
    } catch (e) {
      log(`改名失败：${toChinese(e)}`, 'err');
    }
  }

  async function chmodAction(): Promise<void> {
    const first = entries.find((e) => selected.has(e.path));
    if (!first) return;
    const def = octal(first.permission).replace(/^0/, '') || '644';
    const mode = window.prompt('权限模式（八进制，如 755 / 644 / 4755）', def);
    if (!mode) return;
    if (!/^[0-7]{3,4}$/.test(mode.trim())) {
      log('权限模式格式不正确（应为 3-4 位八进制）', 'err');
      return;
    }
    try {
      const paths = entries.filter((e) => selected.has(e.path)).map((e) => e.path);
      await client.chmodRemote(paths[0], mode.trim());
      if (paths.length > 1) {
        for (let i = 1; i < paths.length; i++) await client.chmodRemote(paths[i], mode.trim());
      }
      log(`已设置 ${paths.length} 个条目权限为 ${mode.trim()}`, 'ok');
      void refresh();
    } catch (e) {
      log(`设置权限失败：${toChinese(e)}`, 'err');
    }
  }

  // ---------- 事件绑定 ----------

  function setBusy(v: boolean): void {
    busy = v;
    pathInput.disabled = !client.connected || v;
    renderCrumbs();
    refreshControlState();
  }

  goBtn.addEventListener('click', () => void go(pathInput.value));
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void go(pathInput.value);
  });
  upBtn.addEventListener('click', () => void go(parentOf(path)));
  refreshBtn.addEventListener('click', () => void refresh());

  uploadBtn.addEventListener('click', () => fileInput.click());
  uploadDirBtn.addEventListener('click', () => dirInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) void doUpload(collectUploadItems(fileInput.files));
    fileInput.value = '';
  });
  dirInput.addEventListener('change', () => {
    if (dirInput.files) void doUpload(collectUploadItems(dirInput.files));
    dirInput.value = '';
  });
  mkdirBtn.addEventListener('click', () => void mkdirAction());
  downloadBtn.addEventListener('click', () => void downloadSelection());
  renameBtn.addEventListener('click', () => void renameAction());
  chmodBtn.addEventListener('click', () => void chmodAction());

  // 拖拽上传：把文件/文件夹拖到文件面板即可传到当前目录
  for (const ev of ['dragenter', 'dragover']) {
    body.addEventListener(ev, (e) => {
      e.preventDefault();
      if (client.connected && !busy) body.classList.add('fm-dragover');
    });
  }
  body.addEventListener('dragleave', () => body.classList.remove('fm-dragover'));
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    body.classList.remove('fm-dragover');
    if (busy || !client.connected) return;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void doUpload(collectUploadItems(files));
  });

  // 记忆上次浏览目录（跨刷新）；初始默认 '/'
  const last = localStorage.getItem('fm:lastPath');
  refreshControlState();
  if (client.connected) {
    void go(last && normalizePath(last) ? last : '/');
  }
}

// ---------- 工具函数 ----------
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

function octal(perm: number): string {
  if (!perm) return '?';
  return '0' + perm.toString(8);
}

function fmtTime(sec: number): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toChinese(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/is a directory/i.test(msg)) {
    return '目标是目录，请用「下载选中」打包下载，或直接点文件名下载';
  }
  if (/no such file|not found|ENOENT/i.test(msg)) {
    return '路径不存在，请检查是否输入正确';
  }
  if (/permission denied|EACCES/i.test(msg)) {
    return '无权限访问（可能是设备节点或受保护路径）';
  }
  if (/not a directory|ENOTDIR/i.test(msg)) {
    return '不是目录，无法进入';
  }
  if (/input\/output|EIO|device or resource busy/i.test(msg)) {
    return '设备节点无法读写（如 /proc、/sys 下的虚拟文件）';
  }
  if (/argument list too long|E2BIG/i.test(msg)) {
    return '参数过长，请分批操作';
  }
  if (/socket open failed/i.test(msg)) {
    return '设备端拒绝新建会话（已自动重试仍失败）。若 Shell 栏正在跑命令请先中断，或断开重连后再试';
  }
  return msg || '操作失败';
}
