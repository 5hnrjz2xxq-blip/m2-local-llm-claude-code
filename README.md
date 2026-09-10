# M2 Air 本地大模型接入 Claude Code 全链路指南

> MacBook Air M2（16GB / 256GB，10+10 核）上，用 LM Studio 跑本地模型，并完整接入 VS Code 的 Claude Code（通过 CC-Switch 管理切换，走国内镜像）。

**成果**：Claude Code 通过本地模型完成「创建文件 → 运行 → 读取输出」的多轮工具调用闭环，无需联网 API。

---

## 目录

1. [最终方案](#1-最终方案)
2. [为什么是这套方案](#2-为什么是这套方案)
3. [完整步骤](#3-完整步骤)
4. [关键排坑记录](#4-关键排坑记录)
5. [常用命令速查](#5-常用命令速查)
6. [回滚与恢复](#6-回滚与恢复)

---

## 1. 最终方案

| 组件 | 选择 | 说明 |
|---|---|---|
| 推理服务器 | **LM Studio 0.4.24** | 自带 llama.cpp / MLX 双引擎，本地 API 服务 |
| 模型 | **Qwen3.5-9B-Q4_K_M（GGUF，unsloth 版）** | 9B 参数、多模态、代码/推理能力均衡，Q4_K_M 量化 5.68GB |
| 引擎 | **llama.cpp**（GGUF 走此引擎） | 上下文长度可自由控制 |
| 上下文 | **65536（64K）** | Claude Code 完整请求约 4.7 万 tokens，32K 装不下 |
| API 端点 | `http://127.0.0.1:1234` | OpenAI 兼容 + Anthropic 兼容（`/v1/messages`） |
| 切换工具 | **CC-Switch** | 管理 Claude Code 的供应商切换 |
| 自动加载 | **macOS LaunchAgent** | LM Studio 重启后自动按 64K 加载模型 |

**性能实测**：约 10.7 tok/s（M2 Air，16GB 统一内存，模型常驻 5.29GiB）。

---

## 2. 为什么是这套方案

### 2.1 为什么不用 Ollama
- 用户明确否决（速度与可控性考量），且已完整卸载。

### 2.2 为什么不用 MLX 引擎（关键限制）
MLX 版模型（`mlx-community/Qwen3.5-9B-OptiQ-4bit`）在 16GB 机器上被引擎的 **auto-fit 机制硬性限制上下文**：

- 实测 `lms ps` 显示 `CONTEXT=13568`，无论 `-c 32768`、关闭 `modelLoadingGuardrails`、调整 `autoFitMinContextLength` 都无法突破；
- 原因：`working_set=11.84GiB / reserve=3.00GiB / safe_ceiling=8.84GiB`，32K 上下文需要 `estimated_peak=8.86GiB`，超出 0.02GiB 即被拒绝；
- 关闭 auto-fit 需要 `mlxContextAutoFit` 特性（mlx-llm ≥ 1.11.1），本机 1.11.0 已是最新但无此开关，CLI 也不暴露相关参数；
- 结论：**16GB 内存下 MLX 引擎装不下 Claude Code 的上下文需求**。

### 2.3 为什么选 GGUF + llama.cpp
- GGUF 版模型走 llama.cpp 引擎，上下文长度完全可控：`lms load <model> -c 65536` 直接生效；
- 实测 64K 上下文加载成功，内存仅 5.29GiB；
- 模型选 `unsloth/Qwen3.5-9B-GGUF` 的 `Q4_K_M` 量化（5.68GB），在 9B 级模型里综合（代码/推理/多模态）与体积最均衡。

### 2.4 为什么选 Qwen3.5-9B
- 9B 参数在 16GB 统一内存的 M 系列芯片上是最优体积/能力平衡点（27B 及以上需更高内存）；
- Qwen 系列代码能力与推理能力在同级开源模型中领先，且支持多模态输入。

---

## 3. 完整步骤

### 3.1 卸载 Ollama

```bash
rm -rf /Applications/Ollama.app
rm -rf ~/.ollama
rm -f ~/Library/LaunchAgents/com.user.ollama-env.plist ~/.ollama-env.sh
# 清理 Application Support / Caches / Preferences 下的 Ollama 残留
# 遗留的死符号链接需手动删除：
sudo rm /usr/local/bin/ollama
```

### 3.2 安装 LM Studio

```bash
# 走 USTC 镜像的 Homebrew
brew install --cask lm-studio
```

lms CLI 路径：

```bash
LMS="/Applications/LM Studio.app/Contents/Resources/app/.webpack/lms"
```

### 3.3 下载模型（国内镜像）

用 HuggingFace 国内镜像 + aria2 多线程断点续传：

```bash
# 需要 aria2（brew install aria2）
aria2c -c -x 8 -s 8 -k 4M \
  -d ~/.cache/lm-studio/models/unsloth/Qwen3.5-9B-GGUF \
  "https://hf-mirror.com/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf"
```

> 注意：下载期间不要同时让 MLX 模型常驻内存，16GB 机器会因内存耗尽卡死（实测踩坑）。

### 3.4 启动本地服务

```bash
"$LMS" server start --port 1234
```

验证：

```bash
"$LMS" ps
```

### 3.5 修复 GGUF 内嵌模板（**必做，否则 Claude Code 报 500**）

**问题**：Qwen3.5 官方 chat template 强制 `system` 消息必须在第一条（`raise_exception('System message must be at the beginning.')`），而 Claude Code 的多轮请求会在消息中间插入 system 消息，导致：

```
API Error: 500 Engine protocol predict request returned 500
... Jinja Exception: System message must be at the beginning
```

**修复**：直接修改 GGUF 文件内嵌模板，把该检查替换为静默跳过。用**原位字节替换**（等长填充），保持文件长度不变，不破坏张量偏移。

```bash
python3 scripts/patch_qwen35_template.py
```

脚本会：
1. 备份原文件为 `.orig.bak`（可回滚）；
2. 在文件头 metadata 区定位 `tokenizer.chat_template` 字符串（约 7816 字节）；
3. 把 `raise_exception('System message must be at the beginning.')` 块替换为 `{{- '' }}`；
4. 用 jinja 注释等长填充到原长度，原位写回；
5. 重新读取验证。

> 注意：LM Studio 的外部 `chat_template.jinja` 文件对 GGUF 模型不生效（llama.cpp 引擎只用 GGUF 内嵌模板），所以必须改文件本身。
>
> 参考 GGUF 类型表（手写解析用）：`0=UINT8 1=INT8 2=UINT16 3=INT16 4=UINT32 5=INT32 6=FLOAT32 7=BOOL 8=STRING 9=ARRAY 10=UINT64 11=INT64 12=FLOAT64`。GGUFReader 的 `field.offset` 指向 kv 条目起始，可直接据此解析字符串数据偏移。

### 3.6 加载模型（64K 上下文）

```bash
"$LMS" unload qwen3.5-9b
"$LMS" load qwen3.5-9b -c 65536 -y
"$LMS" ps   # 确认 CONTEXT=65536
```

### 3.7 配置 CC-Switch

在 CC-Switch 中新增供应商：

- **名称**：`LM Studio 本地`
- **类型**：Claude Code
- **Base URL**：`http://127.0.0.1:1234`
- **API Key**：任意非空（如 `lm-studio`）
- **模型名**：`qwen3.5-9b`（对应 `ANTHROPIC_MODEL / HAIKU / SONNET / OPUS` 四档）

> 命令行方式（CC-Switch 未运行时直改 SQLite，操作前先备份 `~/.cc-switch/cc-switch.db`）或直接在 CC-Switch GUI 操作均可。

### 3.8 验证 Claude Code 接入

```bash
claude -p "创建一个 hello.py 文件，内容打印 Hello World，然后运行它，把输出结果告诉我" \
  --max-turns 6 --dangerously-skip-permissions
```

预期输出：创建文件 → 运行 → 返回 `Hello World`。

### 3.9 LM Studio 重启后自动加载（LaunchAgent）

LM Studio 本身没有「重启后自动恢复上次加载」的开关，用 macOS LaunchAgent 每 15 秒检查一次，发现 LM Studio 运行但模型未按 64K 加载时自动补上：

```bash
# 1. 安装脚本与 plist
mkdir -p ~/bin
cp scripts/lmstudio-autoload.sh ~/bin/
chmod +x ~/bin/lmstudio-autoload.sh
cp scripts/com.user.lmstudio-autoload.plist ~/Library/LaunchAgents/

# 2. 注册
launchctl unload ~/Library/LaunchAgents/com.user.lmstudio-autoload.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.user.lmstudio-autoload.plist
```

同时建议把 LM Studio 默认上下文改为 64K（编辑 `~/.cache/lm-studio/settings.json`）：

```json
"defaultContextLength": { "type": "custom", "value": 65536 }
```

---

## 4. 关键排坑记录

| 现象 | 根因 | 解决 |
|---|---|---|
| `Jinja Exception: System message must be at the beginning` | Qwen3.5 模板强制 system 开头，Claude Code 多轮在中间插 system | 修改 GGUF 内嵌模板（见 3.5） |
| `request (47007 tokens) exceeds the available context size (32768)` | Claude Code 完整请求约 4.7 万 tokens，32K 不够 | 64K 上下文加载（见 3.6） |
| MLX 版 CONTEXT 始终 13568，`-c 32768` 无效 | MLX 引擎 auto-fit 硬算（差 0.02GiB 被拒），本机 mlx-llm 1.11.0 无关闭开关 | 改用 GGUF + llama.cpp 引擎 |
| 下载时系统整体卡死（Bash/GUI 全超时约半小时） | MLX 模型 7.12GB 常驻 + 大文件下载 + 其他应用，内存耗尽 | 卸载 MLX 模型后再下载；下载后删除 MLX 模型目录释放 11GB |
| LM Studio GUI 无法自动化（AX 树只有菜单栏） | Electron 应用窗口对 macOS AX 不可见 | 全部改用 lms CLI 操作 |
| 模型目录放外部 `chat_template.jinja` 不生效 | llama.cpp 引擎只用 GGUF 内嵌模板 | 直接改 GGUF 文件 |

### 4.1 其他已验证不可行的路径
- **MTP 投机解码**（OptiQ 自带权重）：16GB 加载被拒（insufficient system resources）。
- **GUI 修改加载参数**：LM Studio 是 Electron，窗口对 AX 树不可见，无法自动化。

---

## 5. 常用命令速查

```bash
LMS="/Applications/LM Studio.app/Contents/Resources/app/.webpack/lms"

"$LMS" server start --port 1234   # 启动服务
"$LMS" load qwen3.5-9b -c 65536 -y   # 加载模型（64K）
"$LMS" unload qwen3.5-9b          # 卸载模型
"$LMS" ps                         # 查看加载状态（CONTEXT 列确认上下文）
"$LMS" ls                         # 列出已下载模型
```

**API 测试**：

```bash
# OpenAI 兼容
curl http://127.0.0.1:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5-9b","messages":[{"role":"user","content":"你好"}]}'

# Anthropic 兼容（Claude Code 走这个）
curl http://127.0.0.1:1234/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: lm-studio" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"qwen3.5-9b","messages":[{"role":"user","content":"你好"}]}'
```

---

## 6. 回滚与恢复

- **模型模板**：`scripts/patch_qwen35_template.py` 运行前会备份原文件为 `.orig.bak`；如需还原：`mv Qwen3.5-9B-Q4_K_M.gguf.orig.bak Qwen3.5-9B-Q4_K_M.gguf`。
- **CC-Switch 配置**：数据库备份在 `~/.cc-switch/cc-switch.db.bak-*`。
- **Claude 配置**：原配置备份在 `~/.claude/settings.json.bak-glm`。
- **停用自动加载**：`launchctl unload ~/Library/LaunchAgents/com.user.lmstudio-autoload.plist`

---

## 附录：本机环境

- macOS（M 系列芯片，16GB 统一内存 / 256GB 磁盘）
- Homebrew 6.x（USTC 镜像）、pip 清华源、HuggingFace 国内镜像（hf-mirror）
- LM Studio 0.4.24、Claude Code CLI 2.1.173（`~/.npm-global/bin/claude`）
- CC-Switch（管理 Claude Code 供应商切换）

> 所有下载走国内镜像：`hf-mirror.com`、清华 PyPI、USTC Homebrew。
