/** Testable adapter to native Container.exec. Never use unbounded process.output(). */
export interface ShellProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exitCode: Promise<number>;
  kill(signal?: number): void;
}
export async function boundedProcess(process: ShellProcess, maxBytes: number, signal: AbortSignal) {
  const chunks: Uint8Array[][] = [[], []]; let bytes = 0;
  const readers = [process.stdout, process.stderr].map(stream => stream?.getReader());
  let rejectFailure: (error: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  let failed = false;
  const stop = (reason: string) => {
    if (failed) return; failed = true;
    try { process.kill(9); } catch { /* container destruction is the authoritative cleanup */ }
    for (const reader of readers) void reader?.cancel().catch(() => {});
    rejectFailure(new Error(reason));
  };
  const abort = () => stop('Sandbox command interrupted or deadline reached');
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const drain = async (index: number) => {
      const reader = readers[index]; if (!reader) return;
      while (!failed) {
        const { value, done } = await reader.read(); if (done) return;
        bytes += value.byteLength;
        if (bytes > maxBytes) { stop('Sandbox output limit exceeded'); return; }
        chunks[index].push(value);
      }
    };
    const [, , exitCode] = await Promise.race([Promise.all([drain(0), drain(1), process.exitCode]), failure]);
    const decode = (parts: Uint8Array[]) => {
      const output = new Uint8Array(parts.reduce((n, v) => n + v.length, 0)); let offset = 0;
      for (const part of parts) { output.set(part, offset); offset += part.length; }
      return new TextDecoder().decode(output);
    };
    return { exitCode, stdout: decode(chunks[0]), stderr: decode(chunks[1]) };
  } finally { signal.removeEventListener('abort', abort); }
}
