/** 主题切换：通过 <html data-theme="..."> 换肤，偏好持久化到 localStorage */

const KEY = 'web-adb-tool:theme';

export function initTheme(): void {
  const btn = document.getElementById('theme-toggle') as HTMLButtonElement | null;
  if (!btn) return;

  const root = document.documentElement;

  // 恢复已保存的主题
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') {
      root.dataset.theme = saved;
    }
  } catch {
    // localStorage 不可用时忽略
  }

  const updateLabel = () => {
    btn.textContent = root.dataset.theme === 'dark' ? '浅色' : '深色';
  };
  updateLabel();

  btn.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // ignore
    }
    updateLabel();
  });
}
