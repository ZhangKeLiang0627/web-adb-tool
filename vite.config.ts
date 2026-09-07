import { defineConfig } from 'vite';

// `base: './'` 让构建产物使用相对路径，可部署到任意子路径（GitHub Pages 项目站点）
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    sourcemap: false,
  },
});
