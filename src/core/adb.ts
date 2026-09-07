import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';

/**
 * ADB 连接封装 —— 所有与 @yume-chan/adb 的交互都集中在这里，
 * UI 层只调用 AdbClient，方便后续替换底层实现或扩展无线连接。
 */

export interface DeviceInfo {
  serial: string;
  model: string;
  device: string;
  product: string;
  androidVersion: string;
  sdk: string;
  buildId: string;
}

/** 设备端目录中的一个条目（来自 adb sync LIST/readdir 协议） */
export interface RemoteEntry {
  name: string;
  /** 完整绝对路径 */
  path: string;
  isDir: boolean;
  /** 字节大小（目录通常为 0/4096） */
  size: number;
  /** 修改时间（Unix 秒） */
  mtime: number;
  /** 权限模式（如 0o755） */
  permission: number;
}

/** 递归收集到的远端文件引用（供目录打包下载） */
export interface RemoteFileRef {
  path: string;
  size: number;
}

/** 待批量上传的本地文件 + 目标路径 */
export interface PushItem {
  file: File;
  targetPath: string;
}

/**
 * 交互式终端会话句柄 —— 由 openShell 创建，
 * UI 层拿到后把键盘输入 write 进去、把窗口尺寸 resize 过去，即可获得真终端体验。
 */
export interface ShellSession {
  write(data: Uint8Array): Promise<void>;
  resize(rows: number, cols: number): Promise<void>;
  sigint(): Promise<void>;
  kill(): Promise<void>;
  /** 实际使用的 shell：bash 支持 tab 补全 + 完整 PS1，busybox sh 仅基础体验 */
  shellType: 'bash' | 'sh';
}

type StateListener = (connected: boolean) => void;

export class AdbClient {
  private adb: Adb | null = null;
  private readonly credentialStore = new AdbWebCredentialStore('web-adb-tool');
  private readonly listeners = new Set<StateListener>();
  /** bash 探测结果缓存：null = 尚未探测；避免每次「新终端」都重探一次 */
  private bashChecked: boolean | null = null;

  get connected(): boolean {
    return this.adb !== null;
  }

  get serial(): string {
    return this.adb?.serial ?? '';
  }

  /** 订阅连接状态变化（供 UI 更新按钮/输入框可用态） */
  onStateChange(fn: StateListener): void {
    this.listeners.add(fn);
  }

  private emit(connected: boolean): void {
    for (const fn of this.listeners) fn(connected);
  }

  /** 连接设备（需用户手势触发 WebUSB 选择） */
  async connect(): Promise<void> {
    if (this.adb) return;

    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!manager) {
      throw new Error('当前浏览器不支持 WebUSB，请使用 Chrome / Edge');
    }

    const device = await manager.requestDevice();
    if (!device) {
      throw new Error('未选择设备');
    }

    const connection = await device.connect();
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore: this.credentialStore,
    });

    this.adb = new Adb(transport);
    this.emit(true);
  }

  async disconnect(): Promise<void> {
    if (!this.adb) return;
    try {
      await this.adb.close();
    } finally {
      this.adb = null;
      this.bashChecked = null; // 换设备后重新探测 bash
      this.emit(false);
    }
  }

  /** 读取设备基本信息（banner + getProp，逐项容错） */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const adb = this.requireAdb();
    const banner = adb.banner;
    const get = (key: string) => adb.getProp(key).catch(() => '');

    const [androidVersion, sdk, buildId] = await Promise.all([
      get('ro.build.version.release'),
      get('ro.build.version.sdk'),
      get('ro.build.id'),
    ]);

    return {
      serial: adb.serial,
      model: banner.model ?? '',
      device: banner.device ?? '',
      product: banner.product ?? '',
      androidVersion,
      sdk,
      buildId,
    };
  }

  /**
   * 执行一条 shell 命令，流式回显输出。
   * @returns 退出码；fallback 到 none 协议时返回 null
   */
  async shell(
    command: string,
    onStdout: (text: string) => void,
    onStderr: (text: string) => void,
  ): Promise<number | null> {
    const adb = this.requireAdb();

    const shellProto = adb.subprocess.shellProtocol;
    if (shellProto) {
      const proc = await shellProto.spawn(command);
      const exited = proc.exited;
      await Promise.all([
        pump(proc.stdout, onStdout),
        pump(proc.stderr, onStderr),
        exited,
      ]);
      return await exited;
    }

    // 设备不支持 shell 协议时的兜底
    const proc = await adb.subprocess.noneProtocol.pty(command);
    await pump(proc.output, onStdout);
    return null;
  }

  /**
   * 探测设备是否安装了 bash。
   * 不依赖退出码（shell 协议 non-PTY spawn 的 exited 在部分设备恒为 null），
   * 改为读 `command -v bash` 的 stdout——只要输出含 bash 路径即视为已安装。
   * 结果缓存到实例字段，避免重复探测。
   */
  private async detectBash(): Promise<boolean> {
    if (this.bashChecked !== null) return this.bashChecked;
    let useBash = false;
    try {
      let out = '';
      await this.shell(
        'command -v bash',
        (t) => {
          out += t;
        },
        () => {},
      );
      useBash = /\bbash\b/.test(out);
    } catch {
      useBash = false;
    }
    this.bashChecked = useBash;
    return useBash;
  }

  /**
   * 打开一个持久的交互式 PTY 会话（默认 sh），用于真终端体验。
   * - onData：设备输出的原始字节（含 ANSI 转义序列），UI 层直接喂给终端渲染。
   * - onExit：会话结束（进程退出 / 连接断开）时回调退出码；fallback 到 none 协议时无退出码，传 null。
   */
  async openShell(
    onData: (data: Uint8Array) => void,
    onExit: (code: number | null) => void,
  ): Promise<ShellSession> {
    const adb = this.requireAdb();
    const shellProto = adb.subprocess.shellProtocol;

    // 探测设备是否有 bash：有则用它（tab 补全 + 完整彩色 PS1 + 路径显示），
    // 否则退回 busybox sh（仅基础体验）。busybox sh 不识别 \e 且常不展开 \u \h \w，
    // 导致上一版提示符乱码，故此处按 shell 能力分两套初始化脚本。
    // 关键坑：@yume-chan/adb 的 shell 协议 non-PTY spawn 在不少设备上 `exited` 返回 null
    // （而非真实退出码），若用 `退出码 === 0` 判断会把有 bash 的设备误判成没有。
    // 故改为读 stdout 内容判断——`command -v bash` 输出里出现 bash 路径即认定已安装。
    // 注意 spawn() 用 splitCommand 按空格拆 argv，不认 shell 操作符，所以这里只放单个命令，
    // 不能写 `||` / `&&` / `>/dev/null` 等重定向。
    const useBash = await this.detectBash();

    const encoder = new TextEncoder();
    const command = useBash ? 'bash' : 'sh';
    const init = useBash ? BASH_INIT : SH_INIT;

    if (shellProto) {
      // shell 协议：支持 resize / sigint，是完整终端体验的首选路径
      const proc = (await shellProto.pty({
        command,
        terminalType: 'xterm-256color',
      })) as unknown as PtyLike;

      const writer = proc.input.getWriter();
      void pumpThenExit(proc, onData, onExit);

      const session: ShellSession = {
        write: (data) => writer.write(data),
        resize: (rows, cols) => proc.resize?.(rows, cols) ?? Promise.resolve(),
        sigint: () => proc.sigint?.() ?? Promise.resolve(),
        kill: async () => {
          await proc.kill?.();
        },
        shellType: command,
      };
      // 注入终端环境（彩色 PS1 + ls 颜色），让提示符显示当前路径
      await session.write(encoder.encode(init));
      return session;
    }

    // 设备不支持 shell 协议时，退回 none 协议（无 resize，退出码为 null）
    const proc = (await adb.subprocess.noneProtocol.pty(command)) as unknown as PtyLike;
    const writer = proc.input.getWriter();
    void pumpThenExit(proc, onData, onExit);

    const session: ShellSession = {
      write: (data) => writer.write(data),
      resize: () => Promise.resolve(),
      sigint: () => proc.sigint?.() ?? Promise.resolve(),
      kill: async () => {
        await proc.kill?.();
      },
      shellType: command,
    };
    await session.write(encoder.encode(init));
    return session;
  }

  /** 上传本地文件到设备（push），带进度回调（单文件便捷封装） */
  async pushFile(
    file: File,
    remotePath: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<void> {
    const adb = this.requireAdb();
    const sync = await adb.sync();
    try {
      // 目标路径若指向已存在的目录，自动拼上文件名（用户填目录名上传更符合直觉，
      // 否则 sync.write 会在 SEND 阶段被 adbd 以 "Is a directory" 拒绝，进度条也动不了）
      if (await sync.isDirectory(remotePath)) {
        remotePath = remotePath.replace(/\/+$/, '') + '/' + file.name;
      }
      // RK/T113 等 Linux 板没有 Android 的 /data 目录，push 前先确保父目录存在
      await this.ensureParentDir(remotePath);
      const total = file.size;
      await this.writeOne(sync, file, remotePath, (done) => onProgress(done, total));
    } finally {
      await sync.dispose();
    }
  }

  /**
   * 批量上传多个文件到设备（共享同一条 sync 连接）。
   * 自动为每个目标路径创建父目录；进度按字节汇总（onProgress(done, total)）。
   */
  async pushFiles(
    items: PushItem[],
    onFileStart: (label: string, index: number, total: number) => void,
    onProgress: (done: number, total: number) => void,
  ): Promise<void> {
    if (items.length === 0) return;
    const adb = this.requireAdb();
    const sync = await adb.sync();

    // 先为所有涉及到的父目录执行 mkdir -p（去重）
    const parents = new Set<string>();
    for (const it of items) {
      const p = parentOf(it.targetPath);
      if (p) parents.add(p);
    }

    const grandTotal = items.reduce((s, it) => s + it.file.size, 0);
    let overallDone = 0;
    try {
      for (const p of parents) {
        await this.ensureDir(p);
      }
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        onFileStart(it.file.name, i + 1, items.length);
        const base = overallDone;
        await this.writeOne(sync, it.file, it.targetPath, (done) => {
          onProgress(base + done, grandTotal);
        });
        overallDone += it.file.size;
      }
    } finally {
      await sync.dispose();
    }
  }

  /** 通过 sync.write 流式写单个文件（按 64KB 分块读本地文件） */
  private async writeOne(
    sync: import('@yume-chan/adb').AdbSync,
    file: File,
    targetPath: string,
    onProgress: (done: number) => void,
  ): Promise<void> {
    const total = file.size;
    const CHUNK = 64 * 1024;
    let done = 0;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (done >= total) {
          controller.close();
          return;
        }
        const end = Math.min(done + CHUNK, total);
        const buf = new Uint8Array(await file.slice(done, end).arrayBuffer());
        done += buf.byteLength;
        onProgress(done);
        controller.enqueue(buf);
      },
    });

    // @yume-chan 的流类型（ArrayBufferLike）与 DOM 的 ReadableStream 类型
    // 在 TS 上不兼容，但运行时二者均为原生 ReadableStream，此处安全断言。
    await sync.write({
      filename: targetPath,
      file: stream as unknown as import('@yume-chan/stream-extra').ReadableStream<
        import('@yume-chan/stream-extra').MaybeConsumable<Uint8Array>
      >,
    });
  }

  /** 从设备下载文件（pull），返回 Blob，带进度回调 */
  async pullFile(
    remotePath: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<Blob> {
    const adb = this.requireAdb();
    const sync = await adb.sync();

    let total = 0;
    try {
      const stat = await sync.stat(remotePath);
      total = Number(stat.size);
    } catch {
      // 某些 adbd 不支持 stat，此时仅显示已下载字节数
    }

    try {
      const reader = sync.read(remotePath).getReader();
      const chunks: Uint8Array[] = [];
      let done = 0;
      for (;;) {
        const { value, done: isDone } = await reader.read();
        if (isDone) break;
        chunks.push(value);
        done += value.byteLength;
        onProgress(done, total);
      }
      // 运行时 chunk 均为普通 ArrayBuffer（非 SharedArrayBuffer），安全断言。
      return new Blob(chunks as unknown as BlobPart[]);
    } finally {
      await sync.dispose();
    }
  }

  /**
   * 列出设备目录内容（adb sync readdir 协议，v1/v2 由库自动协商）。
   * 返回按「目录在前、按名称排序」的条目；不递归。
   */
  async listDir(path: string): Promise<RemoteEntry[]> {
    const adb = this.requireAdb();
    const sync = await adb.sync();
    try {
      const list = await sync.readdir(path);
      const base = path.endsWith('/') ? path : path + '/';
      return list
        .filter((entry) => entry && !!entry.name && entry.name !== '.' && entry.name !== '..')
        .map((entry) => ({
          name: entry.name,
          path: base + entry.name,
          // type 为 4=Directory / 8=File / 10=Link 等；这里只把真正的目录当目录。
          // 符号链接不跟随（避免误入循环/设备节点），当作普通条目展示。
          isDir: entry.type === 4,
          size: Number(entry.size),
          mtime: Number(entry.mtime),
          permission: entry.permission ?? 0,
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
    } finally {
      await sync.dispose();
    }
  }

  /**
   * 递归收集某目录下所有普通文件（供「整目录打包下载」）。
   * 只下钻真正的目录；符号链接与设备节点不跟随、不计入。
   */
  async listTree(root: string): Promise<RemoteFileRef[]> {
    const out: RemoteFileRef[] = [];
    await this.walk(root, out);
    return out;
  }

  private async walk(dir: string, out: RemoteFileRef[]): Promise<void> {
    const entries = await this.listDir(dir);
    for (const entry of entries) {
      if (entry.isDir) {
        await this.walk(entry.path, out);
      } else {
        out.push({ path: entry.path, size: entry.size });
      }
    }
  }

  /** 在设备上创建目录（mkdir -p，已存在不报错） */
  async makeRemoteDir(path: string): Promise<void> {
    await this.execArgs(['mkdir', '-p', path]);
  }

  /** 设备端重命名/移动（mv -f） */
  async renameRemote(from: string, to: string): Promise<void> {
    await this.execArgs(['mv', '-f', from, to]);
  }

  /** 设备端修改权限（chmod；mode 为字符串，如 '755' 或 '4755'） */
  async chmodRemote(path: string, mode: string): Promise<void> {
    await this.execArgs(['chmod', mode, path]);
  }

  /** 设备端删除（recursive=true 用 rm -rf，否则 rm -f）。
   *  选中项合成单条命令分批执行，避免逐个 open shell（部分设备 adbd 并发会话受限时
   *  会回 "Socket open failed"）；分批上限兼顾命令行长度。 */
  async removeRemote(paths: string[], recursive: boolean): Promise<void> {
    const flag = recursive ? ['-rf'] : ['-f'];
    const BATCH = 32;
    for (let i = 0; i < paths.length; i += BATCH) {
      await this.execArgs(['rm', ...flag, ...paths.slice(i, i + BATCH)]);
    }
  }

  /** 执行 argv 形式的 shell 命令，stderr 非空或退出码非 0 即抛错；
   *  设备端在 OPEN 阶段偶发直接回 CLOSE（Socket open failed），退避后自动重试一次 */
  private async execArgs(args: string[]): Promise<void> {
    const adb = this.requireAdb();
    try {
      await this.execOne(adb, args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Socket open failed/i.test(msg)) throw e;
      await sleepMs(350);
      await this.execOne(adb, args);
    }
  }

  /** 真正执行一条命令，stderr 非空或退出码非 0 即抛错。
   *  优先新式 shell(v2) 通道：其 spawner 会把 argv 直接 join(" ") 成设备端命令串、
   *  不处理空格/引号，因此逐个用 POSIX 单引号包裹参数防二次拆词；
   *  部分设备（如精简 adbd）未实现 shell(v2) raw 会话，open 阶段即被拒
   *  （Socket open failed，且终端能开是因为它走 pty 分支），此时降级到最通用的
   *  exec 通道（无 pty、设备端按空格拆参，参数保持原样）。 */
  private async execOne(adb: Adb, args: string[]): Promise<void> {
    const shellProto = adb.subprocess.shellProtocol;
    let raw: unknown;
    try {
      raw = shellProto
        ? await shellProto.spawnWait(args.map(shellQuote))
        : await adb.subprocess.noneProtocol.spawnWait(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(shellProto && /Socket open failed/i.test(msg))) throw e;
      // 降级：设备未实现 shell(v2) raw 会话时（open 即被拒），改用最通用的 exec 通道
      raw = await adb.subprocess.noneProtocol.spawnWait(args);
    }
    const res = raw as { stdout?: string; stderr?: string; exitCode?: number | null };
    const stderr = (res.stderr ?? '').trim();
    const code = res.exitCode;
    if (stderr || (typeof code === 'number' && code !== 0)) {
      throw new Error(stderr || `${args[0]} 执行失败（exit=${code ?? '?'}）`);
    }
  }

  /** mkdir -p（供 push / 文件管理器共用） */
  private async ensureDir(path: string): Promise<void> {
    if (!path || path === '/') return;
    await this.execArgs(['mkdir', '-p', path]);
  }

  /** push 前确保父目录存在（Linux 板无 /data，且 sync 不保证自动建目录） */
  private async ensureParentDir(remotePath: string): Promise<void> {
    const parent = parentOf(remotePath);
    if (!parent) return; // 根下直接放，无需处理
    try {
      await this.ensureDir(parent);
    } catch (e) {
      if (e instanceof Error && e.message.includes('无法创建')) throw e;
      // 其余（权限等）留给 sync.write 报真实错误
    }
  }

  private requireAdb(): Adb {
    if (!this.adb) throw new Error('设备未连接');
    return this.adb;
  }
}

interface ChunkReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  releaseLock(): void;
}

/** 取绝对路径的父目录；无父（根或非法）返回空串 */
function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  if (i <= 0) return i === 0 ? '/' : '';
  return path.slice(0, i);
}

interface ChunkStream {
  getReader(): ChunkReader;
}

async function pump(stream: ChunkStream, onChunk: (text: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        onChunk(decoder.decode(value, { stream: true }));
      }
    }
    onChunk(decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

/**
 * @yume-chan/adb 的 PTY 进程在 shell/none 两种协议下方法略有差异（none 无 resize、退出码为 undefined），
 * 这里用结构化类型统一承接，避免直接引用其带泛型的流类型与 DOM 类型发生冲突。
 */
interface PtyLike {
  input: {
    getWriter(): { write(data: Uint8Array): Promise<void> };
  };
  output: {
    getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }>; releaseLock(): void };
  };
  exited: Promise<number | null>;
  resize?(rows: number, cols: number): Promise<void>;
  sigint?(): Promise<void>;
  kill?(): void | Promise<void>;
}

/** 泵干设备输出（原样字节透传，供终端渲染 ANSI 转义序列），随后汇报退出码 */
async function pumpThenExit(
  proc: PtyLike,
  onData: (data: Uint8Array) => void,
  onExit: (code: number | null) => void,
): Promise<void> {
  const reader = proc.output.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) onData(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    onExit(await proc.exited);
  } catch {
    onExit(null);
  }
}

/** 真实 ESC 控制字节（字符码 27）。busybox sh 不认识 `\e` 这种 bash 转义，必须用真字节才能着色。 */
const ESC = '\x1b';

/**
 * bash 专属初始化。
 * 历史教训（v0.2.4/v0.2.5 连续翻车）：bash 场景**不要注入自定义 PS1，也不要碰 stty**：
 * ① bash 自带 readline，行编辑/回显由它全权管理；手动 `stty echo` 会把终端 ECHO 打开，
 *    与 readline 自回显叠加造成字符错乱；
 * ② 自定义彩色 PS1 涉及 readline 对 ANSI 转义的宽度计算（须 `\[` `\]` 标记非打印区），
 *    稍有差池提示符就叠字错乱（`mroot@p200:m/m#` 乱相）。
 * 设备系统自带 PS1（如 Debian 的 `root@p200:/#`，含 `\w` 实时路径）已被验证显示正常，
 * 直接沿用；这里只补零风险增强：ll 别名、ls 颜色（GNU ls 支持 --color）、关闭补全分页。
 */
const BASH_INIT = [
  "alias ll='ls -alF'",
  "alias ls='ls --color=auto'",
  "bind 'set page-completions off' 2>/dev/null || true",
  '',
].join('\n');

/**
 * busybox sh / dash 兜底初始化：这类 shell 不展开 \u \h \w，且通常无行编辑（无方向键历史/tab 补全）。
 * 故：① 用 whoami/hostname/pwd 命令替换构造提示符，覆盖 cd 让路径实时刷新；
 * ② `stty -icanon -echo` 进入 raw 模式、关闭回显，交由前端 readline 接管（缓存输入+自回显+历史），
 *   否则方向键会作为 ESC 字节混入命令导致乱码。
 * 提示符尾部保持 `${ESC}[0m# `（root 为 #，普通用户为 $）这一固定特征，前端据此识别"命令执行完、回到提示符"。
 */
const SH_INIT = [
  'stty -icanon -echo 2>/dev/null || true',
  `_p='${ESC}[1;32m'; _b='${ESC}[1;34m'; _r='${ESC}[0m';`,
  `_setps() { PS1="$_p$(whoami)@$(hostname):$_b$(pwd)$_r# "; }`,
  '_setps',
  'cd() { command cd "$@" && _setps; }',
  "if ls --color=auto / >/dev/null 2>&1; then alias ls='ls --color=auto'; fi",
  "alias ll='ls -alF'",
  '',
].join('\n');

/** POSIX 单引号包裹 shell 参数；参数内含单引号时按 '\'' 转义（与 @yume-chan/adb 的 escapeArg 同款） */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
