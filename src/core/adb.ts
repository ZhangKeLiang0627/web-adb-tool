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
}

type StateListener = (connected: boolean) => void;

export class AdbClient {
  private adb: Adb | null = null;
  private readonly credentialStore = new AdbWebCredentialStore('web-adb-tool');
  private readonly listeners = new Set<StateListener>();

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

    if (shellProto) {
      // shell 协议：支持 resize / sigint，是完整终端体验的首选路径
      const proc = (await shellProto.pty({
        command: 'sh',
        terminalType: 'xterm-256color',
      })) as unknown as PtyLike;

      const writer = proc.input.getWriter();
      void pumpThenExit(proc, onData, onExit);

      return {
        write: (data) => writer.write(data),
        resize: (rows, cols) => proc.resize?.(rows, cols) ?? Promise.resolve(),
        sigint: () => proc.sigint?.() ?? Promise.resolve(),
        kill: async () => {
          await proc.kill?.();
        },
      };
    }

    // 设备不支持 shell 协议时，退回 none 协议（无 resize，退出码为 null）
    const proc = (await adb.subprocess.noneProtocol.pty('sh')) as unknown as PtyLike;
    const writer = proc.input.getWriter();
    void pumpThenExit(proc, onData, onExit);

    return {
      write: (data) => writer.write(data),
      resize: () => Promise.resolve(),
      sigint: () => proc.sigint?.() ?? Promise.resolve(),
      kill: async () => {
        await proc.kill?.();
      },
    };
  }

  /** 上传本地文件到设备（push），带进度回调 */
  async pushFile(
    file: File,
    remotePath: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<void> {
    const adb = this.requireAdb();
    const sync = await adb.sync();
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

    try {
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
