# NVCI Lite × ALE WebUI v6 试点（v6-pilot 分支）

> M5 三项目试点之一。范围：向导第 1→2 步（选品牌与型号 → 采集彩页）。不动 main、不改业务逻辑（app.js 未动，纯样式/令牌层）。

## 变更

1. `public/css/tokens.css`：webui kit 生成令牌（vendored，单一真源），index.html 先于 styles.css 加载；
2. `public/styles.css` :root 重构：删除与 kit 重复的色值/圆角/阴影定义，NVCI 专属别名全部改指 v6 令牌（--bg→--color-canvas、--muted→--color-text-muted、状态底色→--status-*-bg 等）；--neutral-bg 为 NVCI 专属本地值（kit 无对应角色）；
3. 三处窄屏样式修复（试点审计发现，纯样式层）：
   - 顶栏 ≤760 换行（品牌行 + 工具行），height:auto；
   - 选择器工具条（搜索 + 批量按钮）≤760 换行；
   - 向导栅格 250px 品牌树 → ≤760 纵向堆叠（树内部 42vh 自滚）；资料表 ≤760 容器内横向滚动（min-width:640，列不压缩——R2/R9 同口径）。

## 试点页与验证

- 页面：`/`（向导第 1→2 步）
- 断言（webui kit/tools/_pilot/verify-nvci.mjs）：品牌令牌实测（--primary 解析 = #6b489d）、步骤 1 勾选 → 下一步 → step2 面板 + 步骤条 active=2、**跨步数据保持**（点步骤条回 1：勾选与计数不丢）、320 根级无溢出、子资源 200、控制台零错 —— **8/8 PASS**
- 截图：step1/step2 × 320/1440（webui 仓库 _pilot-evidence/nvci/）
- 迁移耗时：约 2 小时（含三处窄屏修复）
- 缺失令牌/组件：无缺失；轻量档升级边界：本页交互复杂度在 Alpine 档范围内，无需升级

## M6-R1 追加(2026-09-14,建设方=移交方 AI)

- **R4-01 修复**:`styles.css` 窄屏断点 `max-width:760px` → `860px`(覆盖 768 平板档;原先 768 落桌面布局致 865px 根溢出、顶栏逐字竖排)。
- 验证:320/768/1440 三档根级零溢出;verify-nvci 8/8 回归 PASS。
