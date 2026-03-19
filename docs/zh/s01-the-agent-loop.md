# s01: The Agent Loop (智能体循环)

`[ s01 ] s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"One loop & Bash is all you need"* -- 一个工具 + 一个循环 = 一个智能体。
>
> **Harness 层**: 循环 -- 模型与真实世界的第一道连接。

## 问题

语言模型能推理代码, 但碰不到真实世界 -- 不能读文件、跑测试、看报错。没有循环, 每次工具调用你都得手动把结果粘回去。你自己就是那个循环。

## 解决方案

```text
+--------+      +-------+      +---------+
|  User  | ---> |  LLM  | ---> |  Tool   |
| prompt |      |       |      | execute |
+--------+      +---+---+      +----+----+
                    ^                |
                    |   tool_result  |
                    +----------------+
                    (loop until stop_reason != "tool_use")
```

一个退出条件控制整个流程。循环持续运行, 直到模型不再调用工具。

## 工作原理

1. 用户 prompt 作为第一条消息。

<Lang when="python">

```python
messages.append({"role": "user", "content": query})
```

</Lang>

<Lang when="ts">

```ts
history.push({ role: "user", content: query });
```

</Lang>

2. 将消息和工具定义一起发给 LLM。

<Lang when="python">

```python
response = client.messages.create(
    model=MODEL, system=SYSTEM, messages=messages,
    tools=TOOLS, max_tokens=8000,
)
```

</Lang>

<Lang when="ts">

```ts
const response = await client.messages.create({
  model: MODEL,
  system: SYSTEM,
  messages: history,
  tools: TOOLS,
  max_tokens: 8000,
});
```

</Lang>

3. 追加助手响应。检查 `stop_reason` -- 如果模型没有调用工具, 结束。

<Lang when="python">

```python
messages.append({"role": "assistant", "content": response.content})
if response.stop_reason != "tool_use":
    return
```

</Lang>

<Lang when="ts">

```ts
history.push({
  role: "assistant",
  content: response.content,
});

if (response.stop_reason !== "tool_use") {
  return;
}
```

</Lang>

4. 执行每个工具调用, 收集结果, 作为 user 消息追加。回到第 2 步。

<Lang when="python">

```python
results = []
for block in response.content:
    if block.type == "tool_use":
        output = run_bash(block.input["command"])
        results.append({
            "type": "tool_result",
            "tool_use_id": block.id,
            "content": output,
        })
messages.append({"role": "user", "content": results})
```

</Lang>

<Lang when="ts">

```ts
const results = response.content
  .filter((block) => block.type === "tool_use")
  .map((block) => ({
    type: "tool_result" as const,
    tool_use_id: block.id,
    content: runBash(block.input.command),
  }));

history.push({ role: "user", content: results });
```

</Lang>

组装为一个完整函数:

<Lang when="python">

```python
def agent_loop(query):
    messages = [{"role": "user", "content": query}]
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages,
            tools=TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            return

        results = []
        for block in response.content:
            if block.type == "tool_use":
                output = run_bash(block.input["command"])
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                })
        messages.append({"role": "user", "content": results})
```

</Lang>

<Lang when="ts">

```ts
export async function agentLoop(history: Message[]) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: history,
      tools: TOOLS,
      max_tokens: 8000,
    });

    history.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results = response.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: runBash(block.input.command),
      }));

    history.push({ role: "user", content: results });
  }
}
```

</Lang>

不到 30 行, 这就是整个智能体。后面 11 个章节都在这个循环上叠加机制 -- 循环本身始终不变。

## 变更内容

| 组件          | 之前       | 之后                           |
|---------------|------------|--------------------------------|
| Agent loop    | (无)       | `while True` + stop_reason     |
| Tools         | (无)       | `bash` (单一工具)              |
| Messages      | (无)       | 累积式消息列表                 |
| Control flow  | (无)       | `stop_reason != "tool_use"`    |

## 试一试

```sh
cd learn-claude-code
```

<Lang when="python">

```sh
python agents/s01_agent_loop.py
```

试试这些 prompt (英文 prompt 对 LLM 效果更好, 也可以用中文):

1. `Create a file called hello.py that prints "Hello, World!"`
2. `List all Python files in this directory`
3. `What is the current git branch?`
4. `Create a directory called test_output and write 3 files in it`

</Lang>

<Lang when="ts">

```sh
cd agents-ts
npm install
npm run s01
```

试试这些 prompt (英文 prompt 对 LLM 效果更好, 也可以用中文):

1. `Create a file called hello.ts that logs "Hello, World!"`
2. `List all TypeScript files in this directory`
3. `What is the current git branch?`
4. `Create a directory called test_output and write 3 files in it`

</Lang>
