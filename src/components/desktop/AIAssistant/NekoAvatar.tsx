import React from 'react';

type Status = 'online' | 'thinking' | 'err';

interface Props {
  size?: number;
  /** 保留 prop 兼容外部调用，但不再渲染状态点 */
  status?: Status;
  /** 闭眼态：隐藏眼睛像素 */
  blink?: boolean;
}

const GREEN = '#4ade80';

/**
 * 空心像素猫头（12×11 网格，四角内收锥形 + 尖耳，仅描边）。
 * X = 轮廓 / O = 眼 / . = 透明
 */
const CAT = [
  '..X......X..',
  '.X.X....X.X.',
  'X..XXXXXX..X',
  'X..........X',
  'X..........X',
  'X..O....O..X',
  'X..........X',
  'X..........X',
  'X..........X',
  '.X........X.',
  '..XXXXXXXX..',
];

export const NekoAvatar: React.FC<Props> = ({ size = 36, status: _status, blink }) => {
  void _status;

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg
        viewBox="0 -0.5 12 12"
        width={size}
        height={size}
        style={{ imageRendering: 'pixelated', display: 'block' }}
        shapeRendering="crispEdges"
      >
        {CAT.flatMap((row, y) =>
          row.split('').map((ch, x) => {
            if (ch === '.') return null;
            if (ch === 'O' && blink) return null;
            return (
              <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={GREEN} />
            );
          }),
        )}
      </svg>
    </div>
  );
};
