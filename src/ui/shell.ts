import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { AdbClient, ShellSession } from '../core/adb';

/**
 * Shell 区 —— 用 xterm.js 渲染真正的交互式终端：
 * 键盘直接输入、实时回显、方向键 / Ctrl+C / 清屏（clear）都像 SSH 一样原生可用。
 */

export function initShell(client: AdbClient): void {
  const host = document.getElementById('shell-terminal') as HTMLDivElement;
  const newBtn = document.getElementById('btn-shell-new') as HTMLButtonElement;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    lineHeight: 1.4,
    scrollback: 3000,
    convertEol: false,
    fontFamily: readVar('--font-mono') || 'ui-monospace, Menlo, Consolas, monospace',
    theme: buildTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();

  const encoder = new TextEncoder();
  let session: ShellSession | null = null;

  const writePrompt = (text: string): void => {
    term.write(`\x1b[90m${text}\x1b[0m`);
  };

  /** 打开一条持久 PTY 会话，接到终端输入输出 */
  const openSession = async (): Promise<void> => {
    if (!client.connected) return;
    term.reset();
    writePrompt('正在连接终端…\r\n');
    try {
      session = await client.openShell(
        (data) => term.write(data),
        (code) => {
          // 会话结束：清理引用，给用户提示（可能是进程退出或设备断开）
          if (session && !client.connected) {
            session = null;
            return; // 设备断开时由 onStateChange 统一提示，避免重复
          }
          session = null;
          writePrompt(`\r\n[进程已退出，code=${code ?? '?'}]\r\n`);
          writePrompt('点击右上角「新终端」可重新打开，或重新连接设备。\r\n');
        },
      );
      writePrompt('终端已就绪（sh）。直接输入命令即可。\r\n');
      term.focus();
    } catch (err) {
      writePrompt(`\r\n打开终端失败：${err instanceof Error ? err.message : String(err)}\r\n`);
    }
  };

  // 键盘输入 → 设备 stdin（UTF-8 编码）
  term.onData((data) => {
    if (session) {
      session.write(encoder.encode(data)).catch(() => {});
    }
  });

  // 终端窗口尺寸变化 → 同步 PTY（shell 协议支持，none 协议为 no-op）
  const resizeObserver = new ResizeObserver(() => {
    if (session) {
      try {
        fit.fit();
      } catch {
        // 某些隐藏态下 fit 可能抛错，忽略
      }
      session.resize(term.rows, term.cols).catch(() => {});
    }
  });
  resizeObserver.observe(host);

  // 连接状态：连接成功自动开终端；断开则杀掉会话、保留终端画面
  client.onStateChange((connected) => {
    newBtn.disabled = !connected;
    if (connected) {
      void openSession();
    } else {
      if (session) {
        const s = session;
        session = null;
        s.kill().catch(() => {});
      }
      term.reset();
      writePrompt('设备未连接。点击左上角「连接设备」后会自动打开终端。\r\n');
    }
  });

  // 手动重开一条新终端
  newBtn.addEventListener('click', () => {
    if (session) {
      const s = session;
      session = null;
      s.kill().catch(() => {});
    }
    void openSession();
  });

  // 主题切换时同步终端配色（跟随 <html data-theme="...">）
  const themeObserver = new MutationObserver(() => {
    term.options.theme = buildTheme();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

function readVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 从设计 token 构建 xterm 主题，终端背景/前景/光标色随换肤联动 */
function buildTheme(): ITheme {
  const bg = readVar('--bg-code') || '#0d1117';
  const fg = readVar('--text-code') || '#e6edf3';
  const accent = readVar('--accent') || '#58a6ff';
  const danger = readVar('--danger') || '#f85149';
  const success = readVar('--success') || '#3fb950';

  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: 'rgba(88, 166, 255, 0.32)',
    black: '#1f2328',
    red: danger,
    green: success,
    yellow: '#d29922',
    blue: accent,
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: fg,
    brightBlack: '#8b949e',
    brightRed: '#ff7b72',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#ffffff',
  };
}
