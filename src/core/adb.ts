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

  /** 上传本地文件到设备（push），带进度回调 */
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
          onProgress(done, total);
          controller.enqueue(buf);
        },
      });

      // @yume-chan 的流类型（ArrayBufferLike）与 DOM 的 ReadableStream 类型
      // 在 TS 上不兼容，但运行时二者均为原生 ReadableStream，此处安全断言。
      await sync.write({
        filename: remotePath,
        file: stream as unknown as import('@yume-chan/stream-extra').ReadableStream<
          import('@yume-chan/stream-extra').MaybeConsumable<Uint8Array>
        >,
      });
    } finally {
      await sync.dispose();
    }
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

  /** push 前确保父目录存在（Linux 板无 /data，且 sync 不保证自动建目录） */
  private async ensureParentDir(remotePath: string): Promise<void> {
    const slash = remotePath.lastIndexOf('/');
    if (slash <= 0) return; // 相对路径或根下直接放，无需处理
    const parent = remotePath.slice(0, slash) || '/';

    const adb = this.requireAdb();
    try {
      const shellProto = adb.subprocess.shellProtocol;
      if (shellProto) {
        const res = await shellProto.spawnWait(['mkdir', '-p', parent]);
        if (res.exitCode !== 0) {
          throw new Error(`无法创建目录 ${parent}（请确认路径正确且该目录可写）`);
        }
      } else {
        await adb.subprocess.noneProtocol.spawnWait(['mkdir', '-p', parent]);
      }
    } catch (e) {
      // mkdir 失败（无权限/目录非法）给出中文提示，其余连接错误交由 sync.write 报真实错误
      if (e instanceof Error && e.message.startsWith('无法创建')) throw e;
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
 * bash 专属初始化：bash 完整支持 PS1 转义（\u \h \w \$）与 tab 补全。
 * 颜色用真实 ESC 字节注入，`\u@\h:\w\$` 由 bash 展开为 用户名@主机名:路径# 。
 */
const BASH_INIT = [
  'stty -echo',
  `export PS1='${ESC}[1;32m\\u@\\h:${ESC}[1;34m\\w${ESC}[0m\\$ '`,
  "if ls --color=auto / >/dev/null 2>&1; then alias ls='ls --color=auto'; fi",
  "alias ll='ls -alF'",
  'stty echo',
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
