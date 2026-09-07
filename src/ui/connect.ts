import type { AdbClient, DeviceInfo } from '../core/adb';

/** 连接区：连接按钮 + 头部连接状态 + 设备信息展示 */

type ConnState = 'disconnected' | 'connecting' | 'connected' | 'error';

export function initConnect(client: AdbClient): void {
  const btn = document.getElementById('btn-connect') as HTMLButtonElement;
  const status = document.getElementById('conn-status') as HTMLDivElement;
  const hint = document.getElementById('hint-browser') as HTMLParagraphElement;
  const info = document.getElementById('device-info') as HTMLDivElement;

  // WebUSB 支持检测（浏览器 UA 提示）
  const supported = typeof navigator !== 'undefined' && 'usb' in navigator;
  if (!supported) {
    hint.textContent = '当前浏览器不支持 WebUSB，请使用 Chrome / Edge';
    btn.disabled = true;
  }

  btn.addEventListener('click', async () => {
    if (client.connected) {
      await client.disconnect();
      return;
    }
    btn.disabled = true;
    setStatus(status, 'connecting', '连接中…');
    try {
      await client.connect();
      setStatus(status, 'connected', '已连接');
      renderDeviceInfo(info, await client.getDeviceInfo());
    } catch (e) {
      setStatus(status, 'error', '连接失败');
      hint.textContent = toChineseHint(e);
    } finally {
      btn.disabled = supported ? false : true;
    }
  });

  client.onStateChange((connected) => {
    btn.textContent = connected ? '断开连接' : '连接设备';
    if (!connected) {
      setStatus(status, 'disconnected', '未连接');
      info.innerHTML = '';
    }
  });
}

function setStatus(el: HTMLDivElement, state: ConnState, text: string): void {
  el.classList.remove('status-connected', 'status-error');
  if (state === 'connected') el.classList.add('status-connected');
  if (state === 'error') el.classList.add('status-error');
  const label = el.querySelector('.status-text');
  if (label) label.textContent = text;
}

function renderDeviceInfo(el: HTMLDivElement, d: DeviceInfo): void {
  const rows: Array<[string, string]> = [
    ['序列号', d.serial || '—'],
    ['型号', d.model || '—'],
    ['设备', d.device || '—'],
    ['产品名', d.product || '—'],
    ['系统版本', d.androidVersion || '—'],
    ['SDK', d.sdk || '—'],
    ['Build ID', d.buildId || '—'],
  ];
  el.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="info-row"><span class="info-key">${k}</span><span class="info-val">${escapeHtml(v)}</span></div>`,
    )
    .join('');
}

function toChineseHint(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/claim interface/i.test(msg)) {
    return '接口被占用：请关闭本机其他 ADB 工具（执行 adb kill-server）后重试';
  }
  if (/WebUSB/i.test(msg) || /not supported/i.test(msg)) {
    return '当前浏览器不支持 WebUSB，请使用 Chrome / Edge';
  }
  return msg || '连接失败，请重试';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
