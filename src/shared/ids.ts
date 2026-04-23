/**
 * Isomorphic ID generators.
 *
 * 设计约束：
 * - linnkit 是同构 package（既会被 Node-side host 使用，也会被前端 renderer 通过
 *   `linnkit/runtime-kernel/events` 等子入口透传 transitive import 拖入 bundle）。
 * - 因此本文件不允许 `import { randomUUID } from 'crypto'`：那会触发 vite
 *   `__vite-browser-external` shim，构建时 named import 解析失败。
 * - 改用 Web Crypto API（`globalThis.crypto.randomUUID`），它在所有现代浏览器
 *   与 Node 19+ 上都内置；老 Node 也可通过 `globalThis.crypto.randomUUID` 访问
 *   （Node 14.17+ 在 `node:crypto` 暴露了 `webcrypto`，并自 19 起把 `crypto`
 *   挂到 globalThis）。
 * - 极端 fallback：若运行环境同时缺 Web Crypto，则降级为 Math.random RFC4122 v4
 *   生成器；这些 ID 仅用于会话/消息/run/exec/trace 内部去重展示，不承担加密
 *   强度要求，降级在语义上是安全的。
 */

type WebCryptoLike = { randomUUID?: () => string };

function isoRandomUUID(): string {
  const c = (globalThis as unknown as { crypto?: WebCryptoLike }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // Fallback RFC4122 v4（非加密强度）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function shortRandomId(prefix: string): string {
  return `${prefix}-${isoRandomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function generateMessageId(): string {
  return shortRandomId('msg');
}

export function generateConversationId(): string {
  return shortRandomId('conv');
}

export function generateRunId(): string {
  return shortRandomId('run');
}

export function generateExecutionId(): string {
  return shortRandomId('exec');
}

export function generateTraceId(): string {
  return shortRandomId('trace');
}
