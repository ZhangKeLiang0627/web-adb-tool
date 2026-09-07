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
