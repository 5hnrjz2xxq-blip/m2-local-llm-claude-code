#!/usr/bin/env python3
"""
修复 Qwen3.5 GGUF 内嵌 chat template：
把 "System message must be at the beginning" 强检查替换为静默跳过，
使 Claude Code 的多轮请求（在消息中间插入 system）不再报 500。

原理：GGUF 的 metadata 区在文件头，字符串字段用 [u64 长度][字节] 存储。
修改时保持字符串总长度不变（等长填充 jinja 注释），因此 kv 区长度不变、
张量偏移不受影响，无需重写整个 5.68GB 文件。

用法：
    python3 patch_qwen35_template.py [模型路径]

默认路径：
    ~/.cache/lm-studio/models/unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf
"""
import struct
import sys
import os

DEFAULT_PATH = os.path.expanduser(
    "~/.cache/lm-studio/models/unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf"
)

# 模板开头特征字节（用于在文件头定位字符串数据区）
PATTERN = b"{%- set image_count = namespace(value=0) %}"

OLD_CHECK = """    {%- if message.role == "system" %}
        {%- if not loop.first %}
            {{- raise_exception('System message must be at the beginning.') }}
        {%- endif %}
    {%- elif message.role == "user" %}"""

NEW_CHECK = """    {%- if message.role == "system" %}
        {%- if not loop.first %}
            {{- '' }}
        {%- endif %}
    {%- elif message.role == "user" %}"""


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH
    if not os.path.exists(path):
        print(f"错误：文件不存在 {path}")
        return 1

    # 备份
    bak = path + ".orig.bak"
    if not os.path.exists(bak):
        print(f"备份原文件 -> {bak}")
        with open(path, "rb") as src, open(bak, "wb") as dst:
            # 流式复制，避免内存占用
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                dst.write(chunk)
    else:
        print(f"备份已存在，跳过: {bak}")

    # 在文件头 metadata 区定位模板字符串数据（前 20MB 足够）
    with open(path, "rb") as f:
        head = f.read(20 * 1024 * 1024)

    pos = head.find(PATTERN)
    assert pos >= 0, "未找到模板内容，文件结构异常"
    data_offset = pos
    print(f"模板数据偏移: {data_offset}")

    # 字符串长度字段在数据前 8 字节（u64 小端）
    with open(path, "rb") as f:
        f.seek(data_offset - 8)
        str_len = struct.unpack("<Q", f.read(8))[0]
        f.seek(data_offset)
        old_tpl = f.read(str_len).decode("utf-8")
    print(f"字符串长度: {str_len}, 含检查块: {'System message must be at the beginning' in old_tpl}")

    assert OLD_CHECK in old_tpl, "未找到 system 检查块，可能已修复过"
    new_tpl = old_tpl.replace(OLD_CHECK, NEW_CHECK)
    new_len = len(new_tpl.encode("utf-8"))
    pad_len = str_len - new_len
    assert pad_len >= 0, "新模板比原模板长，无法原位替换"

    # 等长填充：jinja 注释块，总长精确等于 pad_len（\n{# 3 字节 + #} 2 字节）
    padding = ("\n{#" + "#" * (pad_len - 5) + "#}").encode("utf-8")
    assert len(padding) == pad_len
    new_bytes = new_tpl.encode("utf-8") + padding
    assert len(new_bytes) == str_len

    with open(path, "r+b") as f:
        f.seek(data_offset)
        f.write(new_bytes)
        f.flush()
    print("✓ 模板已原位替换")

    # 验证
    with open(path, "rb") as f:
        f.seek(data_offset - 8)
        sl = struct.unpack("<Q", f.read(8))[0]
        f.seek(data_offset)
        t2 = f.read(sl).decode("utf-8")
    assert "System message must be at the beginning" not in t2
    assert "{{- '' }}" in t2
    print("✓ 验证通过：检查块已移除，空替换已生效")

    print("\n下一步：重启加载模型（64K）")
    print('  lms unload qwen3.5-9b')
    print('  lms load qwen3.5-9b -c 65536 -y')
    return 0


if __name__ == "__main__":
    sys.exit(main())
