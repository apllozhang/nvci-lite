# nvci-lite · AI 协作约定

网络厂商彩页采集与对比工具（NVCI 完整版的轻量版）。**先读 `docs/HANDOVER.md`**——起因、经过、专家意见脉络、未完成清单、北极星都在那里。

## 常用命令

```bash
npm test            # 121 个封闭单测，任何改动前后都要绿
npm start           # 本地起服务 http://localhost:8788
node deploy.js push # 部署到 NAS（自动先备份远端 data，勿跳过）
BASE_URL=http://10.20.30.203:8789 node scripts/bulk-select-e2e.js  # 无头验收样板（puppeteer-core + Edge）
```

## 工程红线（违反必返工）

1. **合规采集底线**：只访问 profiles/ 登记的官方 HTTPS 来源，白名单 + SHA-256 校验，不绕过任何访问控制。加新域名必须经用户确认。
2. **参数四态不许弱化**：待复核/未披露/抽取失败的语义不可篡改，不许把机器推测值升格为"有值"。
3. **CSP `script-src 'self'`**：前端禁止内联脚本，逻辑全在 public/app.js。
4. **数据容器加 `notranslate`**：翻译插件改写数字会毁掉对比数据。
5. **列表行点击防双触发**：用"单一 handler + preventDefault + input.checked 同步"模式（label 包 input 的教训），参考 toggleDocSelect。
6. **表格禁内滚盒子**：max-height + sticky 会表头错位，对齐第 5 步彩页校验模式。
7. **i18n 六语言**（zh-CN/zh-TW/en/fr/es/ja）逐语言锚点插入，改 UI 文案必须六语同步。
8. **敏感文件永不入库**：.env、data/、deploy.config.json、*复核报告*.md 已在 .gitignore，别动。

## 协作风格

需求不清主动问；意见不合一律直说、拿代码证据反驳（专家评审 v1-v4 有三处事实错误被推翻）；不编造事实，缺信息标"待确认"；交付后 ≤4 个方向的轻量引导。UI 改动必须跑无头几何断言验收（参考 scripts/bulk-select-e2e.js），截图目测不算数。
