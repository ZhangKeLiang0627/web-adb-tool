import type { AdbClient } from '../core/adb';

/** Shell 区：命令输入 + 输出回显 */

export function initShell(client: AdbClient): void {
  const form = document.getElementById('shell-form') as HTMLFormElement;
  const input = document.getElementById('shell-input') as HTMLInputElement;
  const output = document.getElementById('shell-output') as HTMLDivElement;
  const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement;

  let busy = false;

  client.onStateChange((connected) => {
    input.disabled = !connected || busy;
    submitBtn.disabled = !connected || busy;
    if (!connected) {
      // 保持历史输出，仅清空占位提示
      input.placeholder = '连接设备后可输入命令';
    } else {
      input.placeholder = '输入命令，回车执行，例如：ls -la';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const command = input.value.trim();
    if (!command || busy || !client.connected) return;

    busy = true;
    input.disabled = true;
    submitBtn.disabled = true;

    append(output, `\n$ ${command}\n`, 'prompt');

    try {
      const code = await client.shell(
        command,
        (text) => append(output, text, 'cmd'),
        (text) => append(output, text, 'err'),
      );
      if (code !== null && code !== 0) {
        append(output, `\n[exit ${code}]\n`, 'err');
      }
    } catch (err) {
      append(output, `\n${err instanceof Error ? err.message : String(err)}\n`, 'err');
    } finally {
      input.value = '';
      busy = false;
      input.disabled = false;
      submitBtn.disabled = false;
      input.focus();
      output.scrollTop = output.scrollHeight;
    }
  });
}

function append(container: HTMLDivElement, text: string, cls: 'prompt' | 'cmd' | 'err'): void {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  container.appendChild(span);
  container.scrollTop = container.scrollHeight;
}
