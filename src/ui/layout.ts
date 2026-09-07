/**
 * 布局（layout）—— 三栏可拖拽分隔条。
 *
 * 结构：连接栏 | 分隔条① | Shell(自动占满) | 分隔条② | 文件栏
 * 拖①调连接栏宽，拖②调文件栏宽；Shell 不直接拖，始终吸收剩余空间。
 * 宽度经 CSS 变量 --w-connect / --w-files 生效，并持久化到 localStorage。
 */

const LS_CONNECT = 'layout:w-connect';
const LS_FILES = 'layout:w-files';

/** 各面板宽度约束（px） */
const LIMITS = {
  connect: { min: 200, max: 520 },
  files: { min: 320, max: 1200 },
  // 拖拽时始终给中间 Shell 保留的最小宽度
  shellMin: 300,
} as const;

/** 可调宽度面板的 key（对应 data-resizer 与 CSS 变量名） */
type PaneKey = 'connect' | 'files';

export function initPaneResizers(): void {
  const main = document.querySelector('.app-main') as HTMLElement | null;
  if (!main) return;

  // 应用持久化的宽度（存在且落在容器允许范围内才生效）
  applyStored(main);

  const resizers = Array.from(document.querySelectorAll<HTMLElement>('.pane-resizer'));
  for (const resizer of resizers) {
    const key = resizer.dataset.resizer as PaneKey | undefined;
    if (key !== 'connect' && key !== 'files') continue;
    resizer.addEventListener('mousedown', (ev) => startDrag(main, resizer, key, ev));
  }

  // 窗口尺寸变化：若当前宽度超出可视范围则收敛一次
  window.addEventListener('resize', () => {
    applyStored(main);
  });
}

function applyStored(main: HTMLElement): void {
  const rect = main.getBoundingClientRect();
  if (rect.width < 700) return; // 窄屏（堆叠布局）不应用侧栏宽度
  for (const key of ['connect', 'files'] as PaneKey[]) {
    const raw = localStorage.getItem(key === 'connect' ? LS_CONNECT : LS_FILES);
    if (!raw) continue;
    const w = Number(raw);
    if (!Number.isFinite(w)) continue;
    const limit = LIMITS[key];
    // 超出可视范围时收敛到最大可用宽度
    const room = rect.width - LIMITS.shellMin - 60;
    const max = Math.min(limit.max, room);
    if (w >= limit.min && w <= max) {
      main.style.setProperty(key === 'connect' ? '--w-connect' : '--w-files', `${w}px`);
    }
  }
}

function startDrag(
  main: HTMLElement,
  resizer: HTMLElement,
  key: PaneKey,
  ev: MouseEvent,
): void {
  if (ev.button !== 0) return;
  ev.preventDefault();
  resizer.classList.add('dragging');
  document.body.classList.add('pane-resizing');

  const startX = ev.clientX;
  // 当前该栏宽度：flex-basis 由 .app-main 上的 CSS 变量驱动，从 computed style 读取
  const varName = key === 'connect' ? '--w-connect' : '--w-files';
  const startW = parseFloat(getComputedStyle(main).getPropertyValue(varName)) || 240;

  const limit = LIMITS[key];
  const viewport = main.clientWidth;

  // 该栏可用的最大宽度：容器扣掉另一栏（对面可调栏的当前宽）与 Shell 保留宽
  const otherVar = key === 'connect' ? '--w-files' : '--w-connect';
  const otherW = parseFloat(getComputedStyle(main).getPropertyValue(otherVar)) || 0;
  const maxW = Math.min(limit.max, viewport - otherW - LIMITS.shellMin - 48);
  const minW = Math.min(limit.min, maxW - 20);

  const onMove = (e: MouseEvent): void => {
    const dx = e.clientX - startX;
    // 拖 connect 条：往右→变宽；拖 files 条：往右→文件栏变窄
    const next = key === 'connect' ? startW + dx : startW - dx;
    const clamped = Math.min(maxW, Math.max(minW, next));
    main.style.setProperty(varName, `${clamped}px`);
  };

  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    resizer.classList.remove('dragging');
    document.body.classList.remove('pane-resizing');
    const finalW = parseFloat(getComputedStyle(main).getPropertyValue(varName)) || 0;
    if (finalW > 0) {
      localStorage.setItem(key === 'connect' ? LS_CONNECT : LS_FILES, String(Math.round(finalW)));
    }
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}
