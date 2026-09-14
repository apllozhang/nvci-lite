# n9e 告警规则建议（NAS 侧，代码不动）

> 对应 HANDOVER 第 5 节第 3 项。服务侧 `/metrics` 与 `nvci_probe_updated_info` 推送已就绪；本文件是给 n9e（Nightingale）配置的规则草稿，**需你确认口径后再在 NAS/n9e 上落地**。

## 1. 可用指标（生产已暴露）

### 1.1 进程内 `/metrics`（vmagent 抓取）

| 指标 | 类型 | 标签 | 含义 |
|---|---|---|---|
| `nvci_http_requests_total` | counter | method, route, status | API 请求量 |
| `nvci_login_total` | counter | outcome=success/failed/locked | 登录结果 |
| `nvci_collect_documents_total` | counter | result | 采集文档结果 |
| `nvci_probe_results_total` | counter | status, ok | 探测结果 |
| `nvci_ai_calls_total` | counter | outcome=ok/rate_limited/error | AI 调用 |
| `nvci_process_uptime_seconds` | gauge | — | 进程存活时长 |
| `nvci_process_memory_rss_bytes` | gauge | — | RSS 内存 |
| `nvci_process_heap_used_bytes` | gauge | — | 堆内存 |

注意：计数器是**进程内存态**，容器重启会归零；告警应用 `increase()`/`rate()`，不要直接比绝对值。

### 1.2 厂商更新事件（推送到 VictoriaMetrics）

`lib/notify.js` 在探测判定「厂商已更新」时 POST 到 `{NVCI_LITE_VM_URL}/api/v1/import/prometheus`：

```text
nvci_probe_updated_info{vendor="…",series="…",document="…",sha256="…"} 1 <ms>
```

HANDOVER 注释里的示例规则：`count_over_time(nvci_probe_updated_info[1h]) > 0`。

## 2. 建议规则（按优先级）

以下 PromQL 可直接建 n9e 规则；阈值是**建议值**，请按你们告警疲劳度调整。

### R1 · 厂商彩页已更新（业务主告警，必须有）

```promql
count_over_time(nvci_probe_updated_info[1h]) > 0
```

- 严重级：**Info / 提醒**（不阻断采集，但是选型证据可能过期）
- 恢复：无自动恢复，靠人工看第 5 步
- 备注：若要按品牌拆分，加 `by (vendor)`

### R2 · 采集连续失败（内容侧）

```promql
sum by (result) (
  increase(nvci_collect_documents_total{result!~"ok|success"}[30m])
) > 5
```

- 严重级：**Warning**
- 说明：`result` 实际枚举以运行时为准；先在 n9e 里查 `nvci_collect_documents_total` 的 label 取值再收紧正则。**待确认**：生产上 `result` 是 `downloaded/reused/failed` 还是别的。

### R3 · 登录异常（安全）

```promql
sum(increase(nvci_login_total{outcome="failed"}[15m])) > 20
```

```promql
sum(increase(nvci_login_total{outcome="locked"}[15m])) >= 1
```

- 严重级：failed → Warning；locked → **Critical**（已触发同 IP 10 次锁定）

### R4 · AI 被限流（选型报告会降级）

```promql
sum(increase(nvci_ai_calls_total{outcome="rate_limited"}[30m])) > 0
```

- 严重级：Warning
- 说明：429 时 Word 分析失败会自动降级 AI 材料包，业务不中断但体验下降

### R5 · 探测异常堆积

```promql
sum by (status) (
  increase(nvci_probe_results_total{ok="false"}[2h])
) > 10
```

- 严重级：Warning
- 说明：区分 `unreachable/not_pdf/redirect_broken/...`；死链已在人工裁定后会 `manual_settled` 跳过，不应持续报警

### R6 · 进程没了（可用性）

```promql
absent(nvci_process_uptime_seconds) == 1
```

或 vmagent 侧 scrape down 告警（你们现有体系可能已有）：

```promql
up{job="nvci-lite"} == 0
```

- 严重级：**Critical**

### R7 · 内存水位（可选）

```promql
nvci_process_memory_rss_bytes > 1.5e9
```

- 严重级：Warning
- 说明：1.5GB 是拍脑袋建议值，容器 limit 是多少？**待确认**

## 3. 落地前需要你确认的三件事

1. **n9e 侧谁配置**：我只出规则草稿，还是要在能访问 n9e API 的前提下帮你建？（后者需要权限）
2. **告警接收人/渠道**：邮件、企微、钉钉还是值班组？规则和通知渠道绑定。
3. **`NVCI_LITE_VM_URL`**：生产容器是否已配到 `http://10.20.30.203:8428`（或你们实际 VM 地址）？没配的话 R1 永远不会响——需要改 `deploy.config.json` / 远端 `.env` 后 `node deploy.js push`。

## 4. 不建议现在做的

- 把 `/metrics` 拆成需要鉴权：会破坏现有 vmagent 抓取；当前无业务数据，保持可匿名拉取即可。
- 为 21 条死链单独建长期 Critical：应先人工裁定降噪，否则会变成噪音源。
- 在应用内做告警通道：与 n9e 职责重复；应用只负责指标与 `nvci_probe_updated_info`。
