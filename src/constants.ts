/**
 * 全局共享常量。
 */

/**
 * 桌面/移动布局切换断点(px):窗口宽度小于该值走移动端树(MobileAppContent)。
 * P7-2 定为 900(方案 §6/§10 #2):覆盖 iPad 竖屏(≤834)进移动壳;
 * 窄桌面窗口(700–899)落入移动壳是 §10 #2 已拍板行为,
 * 该带宽由宽触屏档(src/index.css 的 .wide-touch-*)做内容列限宽居中。
 */
export const MOBILE_BREAKPOINT_PX = 900;
