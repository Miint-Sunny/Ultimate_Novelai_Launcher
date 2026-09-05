/**
 * 把 buildOverlaySpec 的锚点画到图上:底图 → 参考线(V5 十字 / V4 网格)→ 编号锚点 → 名字角标。
 * 尺寸系数照他的 renderImageWithCharacterOverlay,输出 JPEG 0.9 控制视觉 token。
 */

import type { OverlaySpec } from '../../../../services/agentHarness/tools/canvasOverlay';

export async function renderCharacterOverlay(blob: Blob, spec: OverlaySpec, maxEdge: number | null): Promise<{ base64: string; mimeType: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  try {
    const longSide = Math.max(bitmap.width, bitmap.height);
    const scale = maxEdge && longSide > maxEdge ? maxEdge / longSide : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d 不可用');
    ctx.drawImage(bitmap, 0, 0, width, height);

    // 参考层
    ctx.strokeStyle = 'rgba(255,255,255,0.33)';
    ctx.lineWidth = Math.max(1, Math.min(width, height) * 0.002);
    ctx.beginPath();
    if (spec.guide === 'grid5') {
      for (let i = 1; i < 5; i += 1) {
        ctx.moveTo((width * i) / 5, 0); ctx.lineTo((width * i) / 5, height);
        ctx.moveTo(0, (height * i) / 5); ctx.lineTo(width, (height * i) / 5);
      }
    } else {
      ctx.moveTo(width / 2, 0); ctx.lineTo(width / 2, height);
      ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2);
    }
    ctx.stroke();

    // 锚点
    const diameter = Math.min(56, Math.max(22, width * 0.032));
    const border = Math.max(2, diameter * 0.085);
    const indexFont = diameter * 0.42;
    const labelFont = Math.min(20, Math.max(10, width * 0.014));
    for (const anchor of spec.anchors) {
      const cx = anchor.x * width;
      const cy = anchor.y * height;
      ctx.beginPath(); ctx.arc(cx, cy, diameter / 2 + border, 0, Math.PI * 2); ctx.fillStyle = '#FFFFFF'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, diameter / 2, 0, Math.PI * 2); ctx.fillStyle = anchor.color; ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `800 ${indexFont}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(anchor.index), cx, cy);
      if (anchor.label) {
        ctx.font = `600 ${labelFont}px system-ui, sans-serif`;
        const padH = 6; const padV = 3; const gap = 4;
        const textWidth = ctx.measureText(anchor.label).width;
        const badgeW = textWidth + padH * 2;
        const badgeH = labelFont * 1.3 + padV * 2;
        const top = Math.min(Math.max(0, cy + diameter + gap), Math.max(0, height - badgeH));
        const left = Math.min(Math.max(0, cx - badgeW / 2), Math.max(0, width - badgeW));
        roundedRect(ctx, left, top, badgeW, badgeH, 4);
        ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(anchor.label, left + padH, top + badgeH / 2);
      }
    }
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/jpeg', width, height };
  } finally {
    bitmap.close();
  }
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
