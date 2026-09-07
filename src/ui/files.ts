import type { AdbClient } from '../core/adb';

/** 文件区：上传 (push) / 下载 (pull) + 进度条 */

export function initFiles(client: AdbClient): void {
  const remoteInput = document.getElementById('file-remote') as HTMLInputElement;
  const uploadBtn = document.getElementById('btn-upload') as HTMLButtonElement;
  const downloadBtn = document.getElementById('btn-download') as HTMLButtonElement;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const progress = document.getElementById('file-progress') as HTMLDivElement;
  const progressBar = progress.querySelector('.progress-bar') as HTMLDivElement;
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

    setBusy(true);
    setProgress(progress, progressBar, 0);
    setLog(log, `正在上传 ${file.name} → ${remotePath} …`, '');
    try {
      await client.pushFile(file, remotePath, (done, total) =>
        setProgress(progress, progressBar, total > 0 ? (done / total) * 100 : 0),
      );
      setLog(log, `上传完成：${file.name}`, 'ok');
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

    setBusy(true);
    setProgress(progress, progressBar, 0);
    setLog(log, `正在下载 ${remotePath} …`, '');
    try {
      const blob = await client.pullFile(remotePath, (done, total) =>
        setProgress(progress, progressBar, total > 0 ? (done / total) * 100 : 0),
      );
      const filename = remotePath.split('/').filter(Boolean).pop() ?? 'download';
      downloadBlob(blob, filename);
      setLog(log, `下载完成：${filename}`, 'ok');
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

function setProgress(container: HTMLDivElement, bar: HTMLDivElement, percent: number): void {
  container.classList.add('visible');
  bar.style.width = `${Math.min(100, Math.max(0, percent)).toFixed(1)}%`;
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

function toChinese(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg || '操作失败';
}
