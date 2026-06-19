/**
 * Bot 服务门面 - 保持对外 export 形状不变。
 *
 * 实现按职责拆分到 ./bot/ 下：
 * - bot/botSession        Bot 授权/会话/WebSocket 与生成任务轮询（botService 单例）
 * - bot/cloudLibraryAdapter  对接传统云后端的 Vibe/备份/墓碑/标签池等适配器
 * - bot/onlineService     在线人数心跳服务（onlineService 单例）
 * - publicLibrary         本地 sidecar 公共库 facade（保持原样重新导出）
 */

export * from './bot/botSession';
export * from './bot/cloudLibraryAdapter';
export * from './bot/onlineService';
export * from './publicLibrary';
