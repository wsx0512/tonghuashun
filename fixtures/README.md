# Fixtures —— 回放数据说明

## ⚠️ 来源声明（请如实阅读）

**这些 JSON 不是扶摇 API 的返回。** 本作品未获得扶摇 API Key。

数据由 [`tools/record-fixtures.ts`](../tools/record-fixtures.ts) 于 **2026-10-15 收盘后**
从**公开免费行情源**抓取真实数值快照，再**重建成扶摇的信封结构**：

| 数据 | 真实来源 | 性质 |
|---|---|---|
| `prices_snapshot.json` | 东方财富 `push2.eastmoney.com` | 抓取 |
| `prices_historical__*.json` | 东方财富 `push2his.eastmoney.com` | 抓取 |
| `trading_days.json` | 由沪深300 日 K 的交易日反推 | 抓取 |
| `limit_up_pool.json` | 东方财富 `push2ex.eastmoney.com` 涨停池 | 抓取 |
| `hot_stock_list.json` | 东方财富人气榜 | 抓取 |
| `dragon_tiger_list.json` | 东方财富 `datacenter-web` 龙虎榜 | 抓取 |
| `valuations_snapshot.json` | 东方财富 `push2.eastmoney.com` | 抓取 |
| `tickers_search.json` | 由自选池清单生成 | 构造 |
| `anomaly_analysis_list.json` | 无免费等价源，按扶摇契约构造，素材取自真实涨停池 | **构造** |
| `abnormal_monitor_list.json` | 无免费等价源，按扶摇契约构造 | **构造** |

**数值是真实的**（如贵州茅台 2026-10-15 收盘 1312.97 元、涨幅 +2.10%），
但**信封是重建的**，字段名严格对齐扶摇 `llms-full.txt` 的契约。

### 为什么这样做

1. **让回放数据有真实的数值形态**——演示不会像玩具数据集。
2. **让扶摇适配器可被真实契约验证**——它消费的正是同一种结构与字段名。
   切换 `SENTINEL_MODE=live` 并提供 `FUYAO_API_KEY` 即可接真实数据，
   无需改动任何上层逻辑。

### 有意保留的真实陷阱

这些 fixture 保留了若干**真实存在的坑**，用于驱动降级与合规测试：

- **`data.timestamp` 语义**：是上游数据的最大有效时间，不是取数时刻。过期判定锚定它。
- **单位口径不一致**：`dragon_tiger_list.json` 的 `change` 是**小数**（`0.067927` = +6.79%），
  而 `prices_snapshot.json` 的 `price_change_ratio_pct` **已是百分数**。
  不归一化就会产生 100 倍的假冲突（测试 `TC-C8`）。
- **合规陷阱**：`dragon_tiger_list.json` 中保留了东财原始字段 `_source_explain_raw`，
  其值为 `"普通席位买入，成功率44.94%"`——含**预测性表述**，题目明令不得呈现。
  适配器必须丢弃它（测试 `TC-D5`）。
- **ticker ≠ 唯一键**：`000001.SZ` 是平安银行，`000001.SH` 是上证指数。
  录制器最初按 ticker 反查导致两条记录撞车，已按 (市场 + 代码) 修正。

## 重新生成

```bash
npm run record
```

需要能访问上述公开数据源。若某个源不可用，脚本会跳过该文件并给出警告，
其余 fixture 仍会正常生成。

## 目录

```
fixtures/
├─ fuyao/       扶摇信封结构的回放数据（data.timestamp / item[] / request_id）
├─ catalog.json 标的目录与别名，供自然语言解析的加扎词典使用
└─ seed/        演示用的构造数据（关注池、匿名持仓、示例任务）
```
