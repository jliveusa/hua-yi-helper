---
name: huayi-keepalive
description: 检查华医网刷课调度器(auto-looper)的保活状态。正常则汇报刷课进度，异常则杀掉僵死进程并自动重启调度器，两种结果都按固定模板发通知邮件（未配置邮件则写本地日志）。适用于无人值守定时巡检。
---

# 华医网刷课调度器 · 保活巡检

检查 `auto-looper` 是否还活着：**正常→汇报进度，异常→自动重启**，两种结果都发通知。
这是无人值守任务，重启是核心职责，不要只报告不动手。

## 0. 首次运行：两个可选功能的配置自检

本 skill 依赖的两个功能**都是可选的**，不配置也能跑，只是能力降级。
第一次运行（或用户主动询问配置）时，执行自检并把结果原样告知用户：

```bash
cd D:\web\hua-yi-helper && node scripts/notify-mail.js --check
```

- 输出 `MAIL_ENABLED` → 邮件通知可用，按下文模板发信。
- 输出 `MAIL_DISABLED` → **不是错误**。告知用户：当前不会发邮件，巡检结果只写本地日志；
  如需邮件通知，在 `scripts/.env.local` 补齐这三项即可：
  ```
  RESEND_API_KEY=你的 Resend API Key
  RESEND_FROM=显示名 <你的发件地址>     # 发件域名需已在 Resend 验证
  RESEND_TO=你的收件地址                # 多个用英文逗号分隔
  ```

另一个可选功能是**验证码自动识别**（决定重启后能否无人值守登录），配置项在同一个文件：

```
VISION_BASE_URL=https://api.openai.com/v1    # 到 /v1 为止，不要带 /chat/completions
VISION_MODEL=gpt-4o-mini                     # 必须是有图片识别能力的多模态模型
VISION_API_KEY=你的 Key
VISION_AUTH_STYLE=bearer                     # 选填。bearer(默认) 或 api-key
```

- **已配置** → 调度器可以 `--headless` 全自动登录，真正无人值守。
- **未配置** → 调度器会**强制显示浏览器窗口**（忽略 `--headless`），账号密码自动填好，
  由人工输入验证码点登录；登录态存入 `local/storage-state.json` 后，后续运行就能用 `--headless` 了。
  重启时若遇到这种情况，必须在通知里明确写"需要人工输入验证码"，不要谎报已恢复。

只要是 OpenAI Chat Completions 格式、且模型支持图片输入的服务都能用，本项目不内置任何
baseURL / 模型名。配置细节见 `scripts/lib/vision-ocr.cjs` 顶部注释。

## 1. 读取状态文件

`D:\web\hua-yi-helper\logs\auto-looper-status.json`（可能不存在 → 见第 4 步判定 D）

字段以实际结构为准，**注意有多个数据源和降级路径**：

| 需要的信息 | 首选来源 | 降级来源 |
|---|---|---|
| 更新时间 | `tsLocal`（北京时间字符串） | 文件 mtime |
| 运行状态 | `state` / `message` / `round` | — |
| 登录态 | `loggedIn` | — |
| 课时标题 | `overall.title` | 日志「📺 正在学习:」行 |
| 视频进度 | `overall.videoCur` / `videoDur` / `videoPct` | `pages[]` 中 `type==="video"` 的 `currentTime`/`duration`；再降级用顶层 `video[<url>].t`（**只有秒数，无 duration**） |
| 本包完成数 | `overall.done` / `overall.total` | 日志「本包 D/T」 |
| 剩余明细 | `overall.remaining` / `learning` / `notDone` / `exam` | 日志「剩余 N 节」（**只有汇总，无明细**） |
| 总体进度 | `overall.overallPct` / `totalMin` / `completedMin` / `remainHours` | — |
| 是否还有待办 | `todos.listHasTodo` | — |

两个重要事实，不要假设：

- **`pages[]` 里的视频条目只在"抓取瞬间正好开着视频页"时才有** `currentTime`/`duration`/`status`。
  只开着课程列表页时，`pages` 只有 `{url, type:"list"}`。所以务必走降级链，不要因为
  `pages` 里没有 video 就报"无进度"。
- **`overall` 里的明细字段（title/done/total/remaining/learning/notDone/exam/videoCur/videoDur）
  是后来才加的**。如果调度器进程是旧版本启动的，这些字段会缺失，此时必须回退到解析日志。

任何字段取不到就在邮件里写"不可用"，**不要编造数值**。

## 2. 读取日志尾部

读 `D:\web\hua-yi-helper\logs\auto-looper.log` 最后 30 行，提取：

- 最近一条 `📺 正在学习: {标题} | 视频 {N}% ({X}s/{Y}s) | 本包 {D}/{T} | 总进度 {P}%（{C}分/{T}分），剩余约 {H}h`
- 最近一条 `✅ 已刷完课程: {标题} | 本包已完成 {D}/{T}，剩余 {K} 节` → 没有则填「暂无」
- 最近一条含「课堂问答」的 `[页面]` 行 → 没有则填「今日无课堂问答」

## 3. 检查进程与文件新鲜度

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*auto-looper*' } | Select-Object ProcessId,CommandLine"
```

同时取 `logs/auto-looper.log` 的最后修改时间。

## 4. 保活判定

**全部满足 = 正常：**

- a) 存在 CommandLine 含 `auto-looper` 的 node 进程
- b) `auto-looper.log` 在 **3 小时内**更新过
- c) 视频进度 > 0，或日志有最近的刷课活动记录

判定顺序很重要：**先排除下面两个"不该重启"的终态，再考虑重启。**

**判定 E（已全部刷完 = 正常终态，不要重启）**：进程不存在，且以下任一成立 →
用模板 E，**绝对不要重启**：

- `todos.listHasTodo === false`
- 日志尾部出现「课程列表无未完成课程」/「未发现未完成课程（可能已全部刷完）」/
  「所有课程已刷完」

> 为什么必须先判这个：调度器刷完所有课程后会自己发完成邮件并正常 `exit 0`
> （见 auto-looper.mjs 的 doneConfirm 逻辑）。此时"进程不存在"是**成功**而非故障。
> 若误判为异常去重启，调度器会因为无课可刷立刻再退出，形成"每小时空转重启 +
> 每小时一封误报邮件"的死循环。

**判定 D（从未运行）**：进程不存在**且** `status.json` 不存在 → 用模板 D，不要尝试重启。

**其余情况（真异常）**：进程不存在或日志陈旧，且课程列表**仍有**待办
（`listHasTodo === true` 或日志显示还有未完成课时）→ 走第 5 步重启。

## 5. 异常处理：重启

### a. 先杀僵死进程

仅当**存在** auto-looper 进程、但日志**超过 30 分钟**未更新（僵死）时才杀：

```bash
taskkill /F /PID <第3步查到的PID>
```

> ⚠️ **只能杀 CommandLine 匹配 `auto-looper` 的 node 进程。**
> 绝不允许按 `Name='node.exe'` 批量杀，机器上可能有其它 node 服务。
> 杀之前必须已经从第 3 步拿到确切 PID。

### b. 确认无残留后启动新实例

重跑第 3 步确认没有 auto-looper 进程了，再用 Bash 工具（`run_in_background=true`）启动：

```bash
cd "D:\web\hua-yi-helper" && node scripts/auto-looper.mjs --headless > logs/auto-looper-run.log 2>&1
```

（若 `node` 不在 PATH，用 `"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe"` 代替）

**注意**：若验证码识别未配置，调度器会忽略 `--headless` 并弹出窗口等人工输码。
此时不要判定为"重启成功"，要在通知里写明需要人工介入。

### c. 等 60 秒后验证

重新读 `status.json` 和日志，确认：文件是否新鲜生成、是否有 video 进度、
`currentTime`>0 或日志出现刷课活动。

### d. 发通知（模板 B；仍未恢复用模板 C）

## 6. 发送通知

设好环境变量后调用现成脚本（**收发件地址一律由脚本从 `.env.local` 读取，
不要在这里写任何邮箱地址**）：

```bash
cd D:\web\hua-yi-helper && MAIL_SUBJECT="标题" MAIL_BODY="正文" node scripts/notify-mail.js
```

按退出码处理：

| 退出码 | 含义 | 动作 |
|---|---|---|
| 0 | 发送成功 | 完成 |
| 3 | 未配置邮件通知 | **不是错误**。把完整正文追加写入本地日志（见第 7 步），并告知用户"邮件未配置，已记录本地" |
| 2 | 已配置但发送失败 | 把正文 + 失败原因追加写入本地日志 |

## 7. 本地日志降级

邮件未配置或发送失败时，把完整通知正文**追加**（绝不覆盖）到：

```
D:\web\hua-yi-helper\.workbuddy\memory\<YYYY-MM-DD>.md
```

---

## 邮件模板

严格按格式生成，**不要自由发挥、不要添加额外内容**。正文为纯文本，不要 HTML。
拿不到的字段写「不可用」或模板里指定的兜底文案。

### 模板A：保活正常 · 进度汇报

Subject：`📊 华医网刷课进度汇报（{tsLocal}）`

```
━━━━━━━━━━━━━━━━━━━━━━━━━
📊 华医网刷课进度汇报（{tsLocal}）
━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 保活状态：正常
📺 当前课程：{title}
🎬 播放进度：{videoCur}s / {videoDur}s（{videoPct}%）
✅ 本包进度：{done}/{total} 已完成
⏳ 剩余课时：{remaining} 节（学习中 {learning} + 未学习 {notDone} + 待考试 {exam}）
📈 总体进度：{overallPct}%（{completedMin}分钟 / {totalMin}分钟），剩余约 {remainHours} 小时
📝 最近刷完：{最近一条"已刷完课程"整行，无则「暂无」}
💬 课堂问答：{最近一条"课堂问答"日志摘要，无则「今日无课堂问答」}
━━━━━━━━━━━━━━━━━━━━━━━━━
此邮件由定时任务自动发送
```

> 若 `learning`/`notDone`/`exam` 取不到（旧版调度器进程），把括号整段替换为
> `（明细不可用）`，保留 `{remaining} 节`。

### 模板B：异常 · 已自动重启

Subject：`【🔄 已自动重启】华医网刷课调度器（{tsLocal}）`

```
━━━━━━━━━━━━━━━━━━━━━━━━━
【🔄 已自动重启】华医网刷课调度器（{tsLocal}）
━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ 检测到异常：{具体哪个判定失败，如"进程不存在"或"日志3小时未更新"}
🔧 执行动作：{杀僵死进程 PID=xxx / 启动新进程}
⏳ 验证结果：{重启后60秒验证：status新鲜=是/否，video在播=是/否，ct=Xs}
📺 当前进度：{重启后的视频进度，不可读则写"不可用"}
🔐 登录方式：{验证码自动识别已启用，全自动 / 未配置识别，需人工输入验证码}
━━━━━━━━━━━━━━━━━━━━━━━━━
此邮件由定时任务自动发送
```

### 模板C：重启失败

Subject：`【❌ 重启失败】华医网刷课调度器（{tsLocal}）`

```
━━━━━━━━━━━━━━━━━━━━━━━━━
【❌ 重启失败】华医网刷课调度器（{tsLocal}）
━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ 异常：{原始失败原因}
🔧 已尝试：{执行了什么操作}
❌ 结果：{重启后 status.json 仍不存在或无活动}
📋 建议：请手动检查 D:\web\hua-yi-helper\logs\auto-looper-run.log
━━━━━━━━━━━━━━━━━━━━━━━━━
此邮件由定时任务自动发送
```

### 模板D：调度器从未运行

Subject：`【⚠️ 调度器未运行】华医网刷课（{tsLocal}）`

```
━━━━━━━━━━━━━━━━━━━━━━━━━
【⚠️ 调度器未运行】华医网刷课（{tsLocal}）
━━━━━━━━━━━━━━━━━━━━━━━━━
未发现 auto-looper 进程或 status.json 文件。
建议：在 D:\web\hua-yi-helper 目录执行
      node scripts/auto-looper.mjs --headless
━━━━━━━━━━━━━━━━━━━━━━━━━
此邮件由定时任务自动发送
```

> 模板 D 的 `{tsLocal}` 取当前时间（status.json 不存在时无从读取）。

### 模板E：已全部刷完 · 正常终态（不重启）

Subject：`✅ 华医网刷课已全部完成（{tsLocal}）`

```
━━━━━━━━━━━━━━━━━━━━━━━━━
✅ 华医网刷课已全部完成（{tsLocal}）
━━━━━━━━━━━━━━━━━━━━━━━━━
🏁 调度器状态：已正常退出（无课可刷，非故障）
📋 判定依据：{listHasTodo=false / 日志"课程列表无未完成课程"}
📈 总体进度：{overallPct}%（{completedMin}分钟 / {totalMin}分钟）
📝 最近刷完：{最近一条"已刷完课程"整行，无则「暂无」}
🔧 本次动作：未重启（全部完成属正常终态，重启会空转）
💡 如需继续：报名新课程包后再手动启动调度器
━━━━━━━━━━━━━━━━━━━━━━━━━
此邮件由定时任务自动发送
```

> 若 `overall` 字段整体缺失（调度器未打开过视频页就退出了），把「总体进度」行
> 替换为 `📈 总体进度：不可用（本轮未采集到课时数据）`。

