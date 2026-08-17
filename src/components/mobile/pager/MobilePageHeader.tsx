import React from 'react';

interface MobilePageHeaderProps {
  /** 页标题:顶部静止时 34px 粗大标题;内容滚动后收起,紧凑行显现该标题 */
  title: string;
  /** 大标题旁的弱化附加信息(如图库数量),紧凑态不显示 */
  meta?: React.ReactNode;
  /** 页级操作(靠右);壳层头像钮在更右侧,已预留避让位,页头不再放头像 */
  trailing?: React.ReactNode;
  /** useScrollEdge 的输出:内容滚离顶部 = true → 页头转均匀玻璃材质(scroll edge) */
  scrolled: boolean;
}

// 共享页头(P7-1,方案 §4.3「页顶栏」行):iOS large title 形态。
// 顶部静止:透明无边界 + 34px 大标题;内容滚动:大标题收起(弹性曲线),
// 紧凑标题在 trailing 之外的可用空间居中淡入,整行转均匀玻璃材质
// (.glass 消费 --glass-* token)+ 底部分隔线(scroll edge 边缘加深)。
// 头部位流内(flex-shrink-0),不做内容压底 overlay:玻璃材质变化是滚动边界信号,
// 不追求内容从磨砂下透过的效果。紧凑行右侧固定预留 44px:避让 pager 壳层
// fixed 右上角的头像钮(tabs 壳下为无害留白)。
export const MobilePageHeader: React.FC<MobilePageHeaderProps> = ({
  title,
  meta,
  trailing,
  scrolled,
}) => (
  <header
    className={`flex-shrink-0 transition-[background-color,border-color,box-shadow] duration-300 ${
      scrolled ? 'glass border-b border-gray-800' : 'border-b border-transparent'
    }`}
    style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
  >
    {/* 紧凑行:trailing 常驻;紧凑标题 scrolled 时淡入 */}
    <div className="flex items-center h-11 px-4">
      <span
        className={`flex-1 truncate whitespace-nowrap text-center text-[17px] font-semibold text-white transition-opacity duration-300 ${
          scrolled ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {title}
      </span>
      {trailing ? <div className="flex items-center gap-2">{trailing}</div> : null}
      {/* 壳层头像钮(pager 壳 fixed 右上角)避让位 */}
      <div className="w-11 shrink-0" aria-hidden />
    </div>

    {/* 大标题行:scrolled 时收起(max-h + 透明度过渡,弹性曲线) */}
    <div
      className={`overflow-hidden px-4 transition-all duration-300 ease-spring ${
        scrolled ? 'max-h-0 opacity-0' : 'max-h-16 opacity-100'
      }`}
    >
      <h1 className="truncate pb-1.5 text-[34px] font-bold leading-[1.2] text-white">
        {title}
        {meta ? (
          <span className="ml-2 align-middle text-sm font-normal text-gray-500">{meta}</span>
        ) : null}
      </h1>
    </div>
  </header>
);
