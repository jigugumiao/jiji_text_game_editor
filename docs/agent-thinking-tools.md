# thinking×tools 兼容性探针结论

> 探针脚本：`tools/probe_agent_compat.mjs`（一次性，需 `DEEPSEEK_KEY` 环境变量）

## 测试环境

- 端点：DeepSeek OpenAI 兼容 API（`https://api.deepseek.com/chat/completions`）
- 模型：`deepseek-v4-flash`
- 请求：`tools` + `tool_choice:'auto'`，分别以 `thinking:{type:'disabled'}` 与 `thinking:{type:'enabled'}` 各发一次
- 时间：2026-09 实施 Task 1 时实测

## 实测结果

| 模式 | HTTP | tool_calls | reasoning_content | finish_reason | 备注 |
|---|---|---|---|---|---|
| thinking=disabled + tools | 200 | ✅ 返回 `get_current_block` | 无 | `tool_calls` | 1160ms |
| thinking=enabled + tools | 200 | ✅ 返回 `get_current_block` | 有（59 字） | `tool_calls` | 870ms；`usage.completion_tokens_details.reasoning_tokens: 13` |

两种模式均正常返回工具调用，无报错。

## 结论

**DeepSeek V4（deepseek-v4-flash）支持 thinking 与 tools 共存**——thinking enabled 时模型照常返回 `tool_calls`，并附带 `reasoning_content` 与 `reasoning_tokens` 计费。

据此，设计文档 §8 中「带 tools 的轮次兜底 `thinking:'disabled'`」的限制**放开**：工具轮可开启 thinking（rewrite/design 等需要推理的场景），无需降级。

Task 13 场景提示词按此结论落：`callDeepseek` 带 tools 时保持场景默认 thinking 设置即可，不再强制 disabled。

> 注：探针使用用户提供的 API Key 通过环境变量运行，key 未写入任何仓库文件。
