# Charting Library 本地补丁清单

本目录的 bundle 相对官方原版包含少量受管补丁，全部由仓库根目录
`scripts/patch_charting_library.mjs` 以精确字符串替换方式落盘。
升级 TradingView 库流程见文件末尾。

| ID | 文件 | 锚点 | 意图 |
|---|---|---|---|
| H1 | bundles/library.6ef314468a2a940f40f4.js | `createOrderLine(){throw ...}` stub | 实现原生 `createOrderLine(price)`：loadLineTool('LineToolOrder') → model.createLineTool → 返回 adapter |
| H2a | bundles/line-tool-order.6295ec35522b8432a85e.js | adapter 类构造器 `class d{constructor(t){...this._active=!0}` | 注入默认字段 `_roundedCorners=!1,_extraBadge=null,_triggerMark=null`（未设置时零行为变化） |
| H2b | bundles/line-tool-order.6295ec35522b8432a85e.js | `setActive(t){...}` 之后追加 | 链式方法 `setRoundedCorners/setExtraBadge/setTriggerMark`，设置后 updateAllViewsAndRedraw |
| H3a | bundles/lt-pane-views.cf9d7448e928a6e8c713.js | renderer 类头 `constructor(e){super(),this._data=null,...,this._adapter=e}setData(...)` | 注入 `_tpSegmentPath/_tpSegment/_tpTriggerMarkData/_tpExtraBadgeData/_tpExtraSegmentsWidth/_tpDrawSegments`：圆角段绘制 + 触发箭头(24px,仅填充) + PnL 徽标(max(32,len*6+10)) |
| H3b/c/d | bundles/lt-pane-views.cf9d7448e928a6e8c713.js | `_drawBody` / `_drawQuantity` / 取消按钮绘制中的 `fillRect+strokeRect` 对 | 三段矩形改走 `_tpSegment`，`_roundedCorners` 开启时圆角、否则退回直角 fill/strokeRect |
| H3e/f/g/h | bundles/lt-pane-views.cf9d7448e928a6e8c713.js | `_drawImpl` 布局宽度和尾部 cancel 调用；hitTest 头部 | 布局宽度计入附加段；cancel 前先画附加段并右移（hasPrevious 传播 `h\|\|g>0`）；附加段区间 hitTest 返回 null |

说明：
- 补丁代码块以 `/* [trade-practice patch …] */ … /* [/trade-practice patch …] */` 标记包裹
- setExtraBadge/setTriggerMark 的颜色参数由调用方保证具体值；renderer 对未定义颜色不作兜底
- bundle 文件名含 content hash，打补丁后与内容不再匹配属预期现象（加载器按固定文件名引用，无影响）
- `--check` 的退出码语义：PENDING/APPLIED 均为 0，仅 MISMATCH 为 1；作为“是否已打补丁”的 CI 判据时请解析输出而非只看退出码
- 脚本必须从仓库根目录执行（ROOT 基于 process.cwd()）；打补丁后可用 `node --check <bundle>` 做语法校验

## 升级 TradingView 库流程

1. 替换 `bundles/` 为新版
2. `node scripts/patch_charting_library.mjs --check` —— 全部 MISMATCH 即锚点失效
3. 在新 bundle 中按属性/方法名重新定位锚点（webpack 只混淆局部变量），更新脚本的 find/replace
4. 执行打补丁 → `npm test` → 手动冒烟（回放开仓/挂单/TP·SL/实盘条件单）
