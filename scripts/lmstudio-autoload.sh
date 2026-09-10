#!/bin/bash
# LM Studio 自动加载模型（64K 上下文，parallel=1）
# 由 launchd 每 15 秒触发一次：LM Studio 运行中但模型未按 64K 加载时自动补上
LMS="/Applications/LM Studio.app/Contents/Resources/app/.webpack/lms"
MODEL="qwen3.5-9b"
CONTEXT=65536

# LM Studio 未运行则不动作
if ! pgrep -qf "/LM Studio.app/" >/dev/null 2>&1; then
    exit 0
fi

# 确保本地服务在 1234 端口（幂等）
"$LMS" server start --port 1234 >/dev/null 2>&1

# 已按 64K 加载目标模型则跳过
PS_OUT="$("$LMS" ps 2>/dev/null)"
if echo "$PS_OUT" | grep -qE "^${MODEL}[[:space:]]" \
   && echo "$PS_OUT" | grep -E "^${MODEL}[[:space:]]" | grep -q "$CONTEXT"; then
    exit 0
fi

# 卸载可能的重复实例
"$LMS" unload "${MODEL}:2" >/dev/null 2>&1

# 加载模型（64K 上下文，单槽，稳定配置）
"$LMS" load "$MODEL" -c "$CONTEXT" --parallel 1 -y >/dev/null 2>&1
exit 0
