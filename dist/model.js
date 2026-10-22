/**
 * Optional browser-local semantic embeddings. No text is sent to a server.
 * Runtime/model assets are served by this website, on the user's first opt-in.
 * Official docs: https://huggingface.co/docs/transformers.js/v3.8.1/index
 * Model: https://huggingface.co/Xenova/bge-small-zh-v1.5
 */
// The bundled entry includes ONNX Runtime; transformers.web.min.js requires
// bare-specifier imports and cannot run directly in a buildless browser app.
const MODEL = "Xenova/bge-small-zh-v1.5";
const REVISION = "75c43b069aac4d136ba6bc1122f995fedcfd2781";
const RUNTIME = new URL("./vendor/transformers/3.8.1/transformers.min.js", import.meta.url).href;
const WASM_PATH = new URL("./vendor/transformers/3.8.1/", import.meta.url).href;
const MODEL_PATH = new URL(`./models/${REVISION}/`, import.meta.url).href;
const LOAD_TIMEOUT = 600_000;
const EMBED_TIMEOUT = 120_000;
let activeSession = null;
let nextRequest = 0;

function cancelledError() {
  return new DOMException("已取消本地模型加载，可以随时重试。", "AbortError");
}

function notify(session, event) {
  session.lastProgress = event;
  for (const listener of session.listeners) {
    // UI callbacks must not interrupt model loading.
    try { listener(event); } catch { /* Keep the model independent of the UI. */ }
  }
}

function endSession(session, error) {
  if (session.failed) return;
  session.failed = true;
  clearTimeout(session.timer);
  session.worker?.terminate();
  session.rejectReady(error);
  for (const request of session.requests.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  session.requests.clear();
  notify(session, { status: "error", message: error.message, code: error.name });
  session.listeners.clear();
  if (activeSession === session) activeSession = null;
}

function makeSession(timeoutMs) {
  const session = {
    worker: null, ready: false, failed: false,
    listeners: new Set(), requests: new Map(), queue: Promise.resolve(),
    lastProgress: { status: "loading", message: "正在准备浏览器本地 AI…" },
  };
  session.readyPromise = new Promise((resolve, reject) => {
    session.resolveReady = resolve;
    session.rejectReady = reject;
  });
  // A Worker may fail before the caller attaches its own await handler.
  session.readyPromise.catch(() => {});
  activeSession = session;
  try {
    if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
      throw new Error("当前浏览器不支持本地模型，请使用新版 Chrome、Edge、Firefox 或 Safari。");
    }
    session.worker = new Worker(new URL(import.meta.url), { type: "module" });
    session.worker.onmessage = ({ data }) => {
      if (session.failed) return;
      if (data.type === "progress") {
        notify(session, data.event);
      } else if (data.type === "ready") {
        clearTimeout(session.timer);
        session.ready = true;
        notify(session, { status: "ready", progress: 100, message: "本地 AI 已就绪", model: MODEL });
        session.resolveReady(createEmbedder(session));
      } else if (data.type === "result" || data.type === "request-error") {
        const request = session.requests.get(data.id);
        if (!request) return;
        clearTimeout(request.timer);
        session.requests.delete(data.id);
        if (data.type === "result") request.resolve(data.vectors);
        else request.reject(new Error(data.message || "本地语义计算失败，请重试。"));
      } else if (data.type === "fatal") {
        endSession(session, new Error(data.message || "本地模型加载失败，请检查网络后重试。"));
      }
    };
    session.worker.onerror = (event) => {
      event.preventDefault();
      endSession(session, new Error("本地 AI 运行失败，请检查浏览器与网络后重试。"));
    };
    session.worker.onmessageerror = () => endSession(session, new Error("本地 AI 通信失败，请重新启用模型。"));
    session.timer = setTimeout(() => {
      const error = new Error("本地模型加载超时。请检查网络后重试；仍可手动确认物品并生成方案。");
      error.name = "TimeoutError";
      endSession(session, error);
    }, timeoutMs);
    session.worker.postMessage({ type: "load" });
  } catch (error) {
    endSession(session, error);
  }
  return session;
}

function createEmbedder(session) {
  const embed = async (texts) => {
    if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) {
      throw new TypeError("embed 需要一个字符串数组。");
    }
    if (session.failed) throw new Error("本地模型已关闭，请重新启用。");
    if (!texts.length) return [];
    // Serialize requests to keep WASM memory bounded and make timeouts useful.
    const task = session.queue.then(() => new Promise((resolve, reject) => {
      if (session.failed) {
        reject(new Error("本地模型已关闭，请重新启用。"));
        return;
      }
      const id = ++nextRequest;
      const timer = setTimeout(() => {
        const error = new Error("本地语义计算超时，请减少文档数量后重新启用模型。");
        error.name = "TimeoutError";
        endSession(session, error);
      }, EMBED_TIMEOUT);
      session.requests.set(id, { resolve, reject, timer });
      try { session.worker.postMessage({ type: "embed", id, texts }); }
      catch (error) { endSession(session, error); }
    }));
    session.queue = task.catch(() => {});
    return task;
  };
  embed.model = MODEL;
  embed.dimensions = 512;
  return embed;
}

/**
 * @param {(event: {status: string, message: string, progress?: number, file?: string, loaded?: number, total?: number}) => void} [onProgress]
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<(texts: string[]) => Promise<number[][]>>} Same-order, L2-normalized 512-dimensional embeddings.
 * Progress percentages describe the current download file, not total model setup.
 * The q8 weights alone are about 24 MB, plus tokenizer and WASM runtime assets.
 * Abort/timeout terminates the Worker. A later call starts a fresh, retryable load.
 */
export async function loadLocalModel(onProgress, { signal, timeoutMs = LOAD_TIMEOUT } = {}) {
  if (signal?.aborted) throw cancelledError();
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : LOAD_TIMEOUT;
  const session = activeSession || makeSession(deadline);
  if (typeof onProgress === "function") {
    session.listeners.add(onProgress);
    try { onProgress(session.lastProgress); } catch { /* UI callback only. */ }
  }
  const abort = () => endSession(session, cancelledError());
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await session.readyPromise;
  } finally {
    if (typeof onProgress === "function") session.listeners.delete(onProgress);
    signal?.removeEventListener("abort", abort);
  }
}

/** Immediately stop loading/inference and release the model's Worker memory. */
export function unloadLocalModel() {
  if (activeSession) endSession(activeSession, cancelledError());
}

// This same-origin module is its own dedicated Worker entry point.
// No Blob URLs, eval, API credentials, or server inference are involved.
if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  let extractor = null;
  let starting = null;
  const sendProgress = (event) => globalThis.postMessage({ type: "progress", event });

  async function initialize() {
    sendProgress({ status: "loading", message: "正在从本站加载 AI 运行组件…" });
    const { pipeline, env } = await import(RUNTIME);
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = MODEL_PATH;
    env.useBrowserCache = typeof caches !== "undefined";
    env.backends.onnx.wasm.wasmPaths = WASM_PATH;
    // Static hosting does not require COOP/COEP or SharedArrayBuffer.
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    extractor = await pipeline("feature-extraction", MODEL, {
      revision: REVISION,
      local_files_only: true,
      dtype: "q8",
      device: "wasm",
      progress_callback: (event) => {
        if (event.status === "progress") {
          sendProgress({
            status: "download", message: "正在下载本地模型…",
            file: event.file, progress: event.progress,
            loaded: event.loaded, total: event.total,
          });
        } else if (event.status === "initiate" || event.status === "download") {
          sendProgress({ status: "loading", file: event.file, message: "正在加载模型与分词器…" });
        }
      },
    });
    sendProgress({ status: "loading", message: "正在初始化本地语义引擎…" });
    // Warm up with a public string so ready means inference really works.
    const warmup = await extractor(["物品语义分类"], { pooling: "cls", normalize: true });
    warmup.dispose?.();
    globalThis.postMessage({ type: "ready" });
  }

  async function compute(texts) {
    const vectors = [];
    // Small batches work on CPU/WASM without a large attention tensor.
    for (let offset = 0; offset < texts.length; offset += 4) {
      const tensor = await extractor(texts.slice(offset, offset + 4), { pooling: "cls", normalize: true });
      try {
        const batch = tensor.tolist();
        for (const vector of batch) {
          if (!Array.isArray(vector) || vector.length !== 512 || vector.some((n) => !Number.isFinite(n))) {
            throw new Error("模型返回了无效向量，请重新启用本地 AI。");
          }
          vectors.push(vector);
        }
      } finally {
        tensor.dispose?.();
      }
    }
    return vectors;
  }

  globalThis.onmessage = async ({ data }) => {
    if (data.type === "load") {
      if (!starting) {
        starting = initialize().catch(() => {
          globalThis.postMessage({ type: "fatal", message: "模型加载失败。请检查网络后重试，或刷新网页重新下载本站模型；仍可手动确认物品并生成方案。" });
        });
      }
    } else if (data.type === "embed") {
      try {
        await starting;
        if (!extractor) throw new Error("本地模型尚未就绪，请重新启用。");
        const vectors = await compute(data.texts);
        globalThis.postMessage({ type: "result", id: data.id, vectors });
      } catch {
        globalThis.postMessage({ type: "request-error", id: data.id, message: "本地语义计算失败，请减少文档长度后重试。" });
      }
    }
  };
}
