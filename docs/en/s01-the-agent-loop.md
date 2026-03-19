# s01: The Agent Loop

`[ s01 ] s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"One loop & Bash is all you need"* -- one tool + one loop = an agent.
>
> **Harness layer**: The loop -- the model's first connection to the real world.

## Problem

A language model can reason about code, but it can't *touch* the real world -- can't read files, run tests, or check errors. Without a loop, every tool call requires you to manually copy-paste results back. You become the loop.

## Solution

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

One exit condition controls the entire flow. The loop runs until the model stops calling tools.

## How It Works

1. User prompt becomes the first message.

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

2. Send messages + tool definitions to the LLM.

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

3. Append the assistant response. Check `stop_reason` -- if the model didn't call a tool, we're done.

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

4. Execute each tool call, collect results, append as a user message. Loop back to step 2.

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

Assembled into one function:

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

That's the entire agent in under 30 lines. Everything else in this course layers on top -- without changing the loop.

## What Changed

| Component     | Before     | After                          |
|---------------|------------|--------------------------------|
| Agent loop    | (none)     | `while True` + stop_reason     |
| Tools         | (none)     | `bash` (one tool)              |
| Messages      | (none)     | Accumulating list              |
| Control flow  | (none)     | `stop_reason != "tool_use"`    |

## Try It

```sh
cd learn-claude-code
```

<Lang when="python">

```sh
python agents/s01_agent_loop.py
```

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

1. `Create a file called hello.ts that logs "Hello, World!"`
2. `List all TypeScript files in this directory`
3. `What is the current git branch?`
4. `Create a directory called test_output and write 3 files in it`

</Lang>
