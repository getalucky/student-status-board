/**
 * 兼容入口：LLM 客户端实现放在 server/lib/llm.js。
 * 保留 server/llm.js 这个路径，方便外部脚本按技术方案里的文件名引用。
 */
export * from './lib/llm.js';
export { default } from './lib/llm.js';
