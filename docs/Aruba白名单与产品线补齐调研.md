# Aruba WiFi 产品线补齐调研（待用户确认后动手）

> 对应 HANDOVER 第 5 节第 2 项。原文写「要把 `arubanetworks.com` 加入采集白名单」。
> **实测证据与该说法不一致**：现行 Aruba AP Data sheet 都在已在白名单内的 `hpe.com`。
> 本文只出结论与登记草案，**未改 profiles、未扩白名单**。

## 1. 事实核对

| 项 | 结果 |
|---|---|
| `profiles/hpe_aruba_wifi.json` | `sources: []`，产品线空壳 |
| 白名单 | 仅 `www.hpe.com` / `hpe.com` |
| `hpe_aruba_cx_switches.json` | 已登记十余条，全部走 `hpe.com/psnow/...`，**未使用 arubanetworks.com** |
| 官网 AP 页 | `https://www.hpe.com/us/en/aruba-access-points.html`（200） |
| 官网旧域名 | `https://www.arubanetworks.com/products/networking/access-points/` → **404** |

AP Data sheet 链接形态（与 CX 同款）：

- 文档页：`https://www.hpe.com/psnow/doc/a00140933enw`
- PDF：`https://www.hpe.com/psnow/downloadDoc/HPE%20Aruba%20Networking%20750%20Series-a00140933enw.pdf?id=a00140933enw&contentDisposition=attachment`

**结论：先补 sources，不必先扩域名。** 把 `arubanetworks.com` 写进白名单目前没有实证支撑，属于扩大合规面却解决不了空产品线。

## 2. 建议动作（按优先级）

### A. 填 `hpe_aruba_wifi.json` 的 sources（推荐先做）

照抄 CX 交换机结构，首批建议登记 **园区 AP 主力线**（与跨品牌选型最相关）：

| series | materialPageUrl（doc id） | 备注 |
|---|---|---|
| 750 | a00140933enw | Wi-Fi 7 旗舰 |
| 740 | a00147704enw | Wi-Fi 7 |
| 730 | a00138541enw | Wi-Fi 7 |
| 720 | a00146618enw | Wi-Fi 7 |
| 650 | a00119145enw | Wi-Fi 6E |
| 630 | a00114648enw | Wi-Fi 6E |
| 610 | a00125607enw | Wi-Fi 6E |
| 550 | a00064820enw | Wi-Fi 6 |
| 530 | a00064816enw | Wi-Fi 6 |
| 510 | a00058595enw | Wi-Fi 6 |

`pdfUrl` 按 CX 模式拼 `downloadDoc/...`；`officialFileName` 用官网命名；`productPageUrl` 指向 AP 总页。

`expectedSha256`：CX 有值是因为已实测建档。新登记条目若无基线，首次采集/探测会建档——**不要编造哈希**。可选路径：

1. 首次只跑探测/采集拿真实 SHA 再回填基线（推荐，与目录治理流程一致）
2. 或接受「新建档（无基线）」状态，等一轮探测后再对齐

### B. 白名单是否扩 `arubanetworks.com`（暂不建议）

| 若扩 | 风险 | 收益 |
|---|---|---|
| 加 `arubanetworks.com` | 合规边界变宽；当前 AP 数据并不在该域 | 几乎为 0（实测 404） |
| 不扩 | 无 | 白名单保持最小必要 |

只有当后续发现仍有彩页/重定向落在 `arubanetworks.com` 时再议，并且**仍要你点头**。

### C. 是否把 profile `enabled` 打开

CX 交换机目前是 `approvalStatus: "draft"`、`enabled: false`。WiFi 同理建议先 draft + 有 sources，等你确认采集范围后再 `enabled: true` 并部署。

## 3. 待你确认

1. **是否按上表 10 条园区 AP 填入 sources**（仍走现有 `hpe.com` 白名单，不扩域名）？
2. **是否连 Hospitality / Outdoor / Hardened 一起登记**（720H/600H/760/670/580/518…），还是先只做园区线？
3. **`enabled`**：填完就开采集，还是先 draft 等你抽查 PDF 链接后再开？
4. 若你仍希望保留 HANDOVER 原话里的 `arubanetworks.com`：请说明具体要在该域采什么（产品页？历史 PDF？），否则我按「不扩域名」执行。

## 4. 我准备怎么改（你点头后）

1. 改 `profiles/hpe_aruba_wifi.json`：补齐 productLine/subseries/sources，保持 schema 2.2。
2. `npm test`（目录聚合/品牌数断言可能要同步：catalog 测试写死了品牌与资料条目数）。
3. 不擅自 `node deploy.js push`；生产变更等你指令。
