/**
 * 兼容移动端的剪贴板复制工具
 * 在不支持 Clipboard API 的环境下使用 fallback 方案
 */

/**
 * 复制文本到剪贴板
 * @param text 要复制的文本
 * @returns 是否复制成功
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 优先使用 Clipboard API
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn('[Clipboard] Clipboard API failed, trying fallback:', err);
    }
  }

  // Fallback: 使用 execCommand (兼容旧浏览器和某些移动端)
  return copyWithExecCommand(text);
}

/**
 * 使用 execCommand 复制文本（fallback 方案）
 */
function copyWithExecCommand(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  
  // 防止滚动
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.width = '2em';
  textarea.style.height = '2em';
  textarea.style.padding = '0';
  textarea.style.border = 'none';
  textarea.style.outline = 'none';
  textarea.style.boxShadow = 'none';
  textarea.style.background = 'transparent';
  // iOS 需要设置 fontSize 防止缩放
  textarea.style.fontSize = '16px';
  
  document.body.appendChild(textarea);
  
  // iOS 需要特殊处理
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  
  if (isIOS) {
    const range = document.createRange();
    range.selectNodeContents(textarea);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    textarea.setSelectionRange(0, text.length);
  } else {
    textarea.focus();
    textarea.select();
  }
  
  let success = false;
  try {
    success = document.execCommand('copy');
  } catch (err) {
    console.error('[Clipboard] execCommand failed:', err);
  }
  
  document.body.removeChild(textarea);
  return success;
}
