import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { AdbClient, ShellSession } from '../core/adb';

/**
 * Shell 区 —— 用 xterm.js 渲染真正的交互式终端。
 *
 * 按 shell 能力分两种输入路径：
 * - bash：完整 readline（方向键历史 / tab 补全 / 行编辑），前端原样透传即可。
 * - busybox sh：通常无行编辑，前端做「轻量 readline」兜底——raw 模式下
 *   缓存输入 + 自回显 + 方向键历史 + 回车整条提交，让体验接近 bash。
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
  const decoder = new TextDecoder();
  let session: ShellSession | null = null;

  // ---- 前端 readline 状态（仅 sh 兜底场景使用）----
  const rl = {
    mode: 'prompt' as 'prompt' | 'running',
    line: '', // 当前输入行（前端缓存）
    history: [] as string[],
    histIdx: -1, // -1 = 未在历史导航中
    draft: '', // 导航前暂存的未提交输入
    tailBuf: '', // shell 输出尾缓冲，用于识别提示符
  };

  const writePrompt = (text: string): void => {
    term.write(`\x1b[90m${text}\x1b[0m`);
  };

  /** 打开一条持久 PTY 会话，接到终端输入输出 */
  const openSession = async (): Promise<void> => {
    if (!client.connected) return;
    term.reset();
    writePrompt('正在连接终端…\r\n');
    // 重置 readline 状态
    rl.mode = 'prompt';
    rl.line = '';
    rl.history = [];
    rl.histIdx = -1;
    rl.draft = '';
    rl.tailBuf = '';
    try {
      const s = await client.openShell(
        (data) => {
          term.write(data);
          detectPrompt(data);
        },
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
      session = s;
      if (s.shellType === 'bash') {
        writePrompt('终端已就绪（bash）。直接输入命令，支持 Tab 补全。\r\n');
      } else {
        writePrompt('终端已就绪（sh）。直接输入命令，支持 ↑/↓ 历史。（设备未安装 bash，Tab 补全不可用）\r\n');
      }
      term.focus();
    } catch (err) {
      writePrompt(`\r\n打开终端失败：${err instanceof Error ? err.message : String(err)}\r\n`);
    }
  };

  // ---- 键盘输入 → 设备 stdin ----
  term.onData((data) => {
    if (!session) return;
    if (session.shellType === 'bash') {
      // bash 自己处理行编辑，原样透传
      session.write(encoder.encode(data)).catch(() => {});
      return;
    }
    handleShInput(data);
  });

  // ---- 方向键历史 / 拦截（仅 sh 场景）----
  term.attachCustomKeyEventHandler((event) => {
    if (session?.shellType !== 'sh' || rl.mode !== 'prompt') return true;
    if (event.type !== 'keydown') return true;
    if (event.key === 'ArrowUp') {
      historyPrev();
      return false;
    }
    if (event.key === 'ArrowDown') {
      historyNext();
      return false;
    }
    // 左/右/Home/End 暂不做光标移动，但也要拦下，避免 ESC 序列混入命令
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      return false;
    }
    return true;
  });

  // ---- sh 场景：前端 readline 输入处理 ----
  function handleShInput(data: string): void {
    if (!session) return;
    if (rl.mode === 'running') {
      // 命令执行中（或交互式程序等待输入）：原样透传
      session.write(encoder.encode(data)).catch(() => {});
      return;
    }
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '\r' || ch === '\n') {
        submitLine();
      } else if (ch === '\x7f' || ch === '\b') {
        backspace();
      } else if (ch === '\x03') {
        // Ctrl+C：清空当前行，发送中断，等待新提示符
        rl.line = '';
        rl.histIdx = -1;
        rl.draft = '';
        term.write('^C\r\n');
        session.write(encoder.encode('\x03')).catch(() => {});
        rl.mode = 'running';
      } else if (ch === '\x1b') {
        // 方向键已被 attachCustomKeyEventHandler 拦截，此处是其他 ESC 序列，透传
        session.write(encoder.encode('\x1b')).catch(() => {});
      } else if (ch === '\t') {
        // sh 无补全能力，忽略 Tab（避免混入 \t 乱码）
      } else if (ch >= ' ') {
        rl.line += ch;
        term.write(ch); // 自回显
      }
      // 其余不可打印控制字符（如 \x04 Ctrl+D）原样透传
    }
  }

  function submitLine(): void {
    if (!session) return;
    const cmd = rl.line;
    if (cmd.trim() !== '') rl.history.push(cmd);
    rl.histIdx = -1;
    rl.draft = '';
    rl.line = '';
    rl.mode = 'running';
    session.write(encoder.encode(cmd + '\n')).catch(() => {});
    term.write('\r\n'); // 自回显换行
  }

  function backspace(): void {
    if (rl.line.length > 0) {
      rl.line = rl.line.slice(0, -1);
      term.write('\b \b'); // 退格 + 空格覆盖 + 退格
    }
  }

  function historyPrev(): void {
    if (rl.history.length === 0) return;
    if (rl.histIdx === -1) {
      rl.draft = rl.line;
      rl.histIdx = rl.history.length - 1;
    } else if (rl.histIdx > 0) {
      rl.histIdx--;
    }
    rl.line = rl.history[rl.histIdx];
    redrawLine(rl.line);
  }

  function historyNext(): void {
    if (rl.histIdx === -1) return;
    if (rl.histIdx < rl.history.length - 1) {
      rl.histIdx++;
      rl.line = rl.history[rl.histIdx];
    } else {
      rl.histIdx = -1;
      rl.line = rl.draft;
      rl.draft = '';
    }
    redrawLine(rl.line);
  }

  /** 读当前行纯文本、保留提示符前缀，重绘为「提示符 + 新内容」 */
  function redrawLine(newLine: string): void {
    const y = term.buffer.active.cursorY;
    const rawLine = term.buffer.active.getLine(y)?.translateToString() ?? '';
    // 提示符以 "# " 或 "$ " 结尾（root 为 #，普通用户为 $），据此截取提示符前缀
    let prompt = '';
    for (let i = rawLine.length - 1; i >= 0; i--) {
      const c = rawLine[i];
      if ((c === '#' || c === '$') && rawLine[i + 1] === ' ') {
        prompt = rawLine.slice(0, i + 2);
        break;
      }
    }
    term.write('\r\x1b[2K' + prompt + newLine);
  }

  /** 从 shell 输出里识别「命令执行完、回到提示符」，切回 readline 模式 */
  function detectPrompt(data: Uint8Array): void {
    if (rl.mode !== 'running') return;
    rl.tailBuf += decoder.decode(data);
    if (rl.tailBuf.length > 128) rl.tailBuf = rl.tailBuf.slice(-128);
    // 提示符尾部：复位转义 + "# " 或 "$ "
    if (rl.tailBuf.includes('\x1b[0m# ') || rl.tailBuf.includes('\x1b[0m$ ')) {
      rl.mode = 'prompt';
      rl.tailBuf = '';
    }
  }

  // ---- 终端窗口尺寸变化 → 同步 PTY ----
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

  // ---- 连接状态 ----
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

  // ---- 手动重开一条新终端 ----
  newBtn.addEventListener('click', () => {
    if (session) {
      const s = session;
      session = null;
      s.kill().catch(() => {});
    }
    void openSession();
  });

  // ---- 主题切换时同步终端配色 ----
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
