import type { AdbClient } from '../core/adb';

/** 文件区：上传 (push) / 下载 (pull) + 进度条 + 速率 / 大小 / 用时 */

export function initFiles(client: AdbClient): void {
  const remoteInput = document.getElementById('file-remote') as HTMLInputElement;
  const uploadBtn = document.getElementById('btn-upload') as HTMLButtonElement;
  const downloadBtn = document.getElementById('btn-download') as HTMLButtonElement;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const progress = document.getElementById('file-progress') as HTMLDivElement;
  const progressBar = progress.querySelector('.progress-bar') as HTMLDivElement;
  const progressText = document.getElementById('file-progress-text') as HTMLDivElement;
  const log = document.getElementById('file-log') as HTMLDivElement;

  let busy = false;

  client.onStateChange((connected) => {
    const enabled = connected && !busy;
    remoteInput.disabled = !connected;
    uploadBtn.disabled = !enabled;
    downloadBtn.disabled = !enabled;
  });

  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;

    const remotePath = remoteInput.value.trim();
    if (!remotePath) {
      setLog(log, '请先填写远程路径', 'err');
      return;
    }

    const meter = createMeter(progress, progressBar, progressText);
    setBusy(true);
    meter.reset();
    setLog(log, `正在上传 ${file.name} → ${remotePath} …`, '');
    try {
      await client.pushFile(file, remotePath, meter.update);
      setLog(
        log,
        `上传完成：${file.name}（${formatBytes(file.size)}，用时 ${meter.elapsed()}s）`,
        'ok',
      );
    } catch (e) {
      setLog(log, toChinese(e), 'err');
    } finally {
      setBusy(false);
    }
  });

  downloadBtn.addEventListener('click', async () => {
    const remotePath = remoteInput.value.trim();
    if (!remotePath) {
      setLog(log, '请先填写远程路径', 'err');
      return;
    }

    const meter = createMeter(progress, progressBar, progressText);
    setBusy(true);
    meter.reset();
    setLog(log, `正在下载 ${remotePath} …`, '');
    try {
      const blob = await client.pullFile(remotePath, meter.update);
      const filename = remotePath.split('/').filter(Boolean).pop() ?? 'download';
      downloadBlob(blob, filename);
      setLog(
        log,
        `下载完成：${filename}（${formatBytes(blob.size)}，用时 ${meter.elapsed()}s）`,
        'ok',
      );
    } catch (e) {
      setLog(log, toChinese(e), 'err');
    } finally {
      setBusy(false);
    }
  });

  function setBusy(value: boolean): void {
    busy = value;
    const enabled = client.connected && !busy;
    uploadBtn.disabled = !enabled;
    downloadBtn.disabled = !enabled;
  }
}

/** 进度跟踪器：记录起始/上次时间与字节，实时算出速率、百分比并驱动 UI */
function createMeter(
  progress: HTMLDivElement,
  progressBar: HTMLDivElement,
  progressText: HTMLDivElement,
): { update(done: number, total: number): void; elapsed(): string; reset(): void } {
  let start = 0;
  let lastDone = 0;
  let lastTime = 0;

  return {
    reset() {
      start = performance.now();
      lastDone = 0;
      lastTime = start;
      progress.classList.remove('visible');
      progressBar.style.width = '0%';
      progressText.textContent = '';
    },
    update(done, total) {
      const now = performance.now();
      const percent = total > 0 ? (done / total) * 100 : 0;
      progress.classList.add('visible');
      progressBar.style.width = `${Math.min(100, Math.max(0, percent)).toFixed(1)}%`;

      // 用相邻两次回调的增量算瞬时速率（bytes/s），避免把总耗时平摊进来
      const dt = now - lastTime;
      const speed = dt > 0 ? ((done - lastDone) / dt) * 1000 : 0;
      lastDone = done;
      lastTime = now;

      const totalText = total > 0 ? formatBytes(total) : '未知';
      progressText.textContent =
        `${formatBytes(done)} / ${totalText} · ${formatBytes(speed)}/s · ${percent.toFixed(1)}%`;
    },
    elapsed() {
      return ((performance.now() - start) / 1000).toFixed(1);
    },
  };
}

function setLog(el: HTMLDivElement, text: string, cls: 'ok' | 'err' | ''): void {
  el.textContent = text;
  el.className = 'file-log' + (cls ? ` ${cls}` : '');
}

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

/** 字节数 → 人类可读（B / KB / MB / GB） */
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

function toChinese(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/is a directory/i.test(msg)) {
    return '目标路径是目录，请填写完整文件路径（如 /tmp/foo.txt）';
  }
  if (/no such file|not found/i.test(msg)) {
    return '远端文件不存在，请检查路径';
  }
  if (/permission denied/i.test(msg)) {
    return '无权限，请确认目标目录可写';
  }
  return msg || '操作失败';
}
