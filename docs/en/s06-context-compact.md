# s06: Context Compact

`s01 > s02 > s03 > s04 > s05 > [ s06 ] | s07 > s08 > s09 > s10 > s11 > s12`

> *"Context will fill up; you need a way to make room"* -- three-layer compression strategy for infinite sessions.
>
> **Harness layer**: Compression -- clean memory for infinite sessions.

## Problem

The context window is finite. A single `read_file` on a 1000-line file costs ~4000 tokens. After reading 30 files and running 20 bash commands, you hit 100,000+ tokens. The agent cannot work on large codebases without compression.

## Solution

Three layers, increasing in aggressiveness:

```
Every turn:
+------------------+
| Tool call result |
+------------------+
        |
        v
[Layer 1: micro_compact]        (silent, every turn)
  Replace tool_result > 3 turns old
  with "[Previous: used {tool_name}]"
        |
        v
[Check: tokens > 50000?]
   |               |
   no              yes
   |               |
   v               v
continue    [Layer 2: auto_compact]
              Save transcript to .transcripts/
              LLM summarizes conversation.
              Replace all messages with [summary].
                    |
                    v
            [Layer 3: compact tool]
              Model calls compact explicitly.
              Same summarization as auto_compact.
```

## How It Works

1. **Layer 1 -- micro_compact**: Before each LLM call, replace old tool results with placeholders.

<Lang when="python">

```python
def micro_compact(messages: list) -> list:
    tool_results = []
    for i, msg in enumerate(messages):
        if msg["role"] == "user" and isinstance(msg.get("content"), list):
            for j, part in enumerate(msg["content"]):
                if isinstance(part, dict) and part.get("type") == "tool_result":
                    tool_results.append((i, j, part))
    if len(tool_results) <= KEEP_RECENT:
        return messages
    for _, _, part in tool_results[:-KEEP_RECENT]:
        if len(part.get("content", "")) > 100:
            part["content"] = f"[Previous: used {tool_name}]"
    return messages
```

</Lang>

<Lang when="ts">

```ts
function microCompact(messages: Message[]): Message[] {
  const toolResults: ToolResultBlock[] = [];

  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isToolResultBlock(part)) {
        toolResults.push(part);
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) {
    return messages;
  }

  for (const result of toolResults.slice(0, -KEEP_RECENT)) {
    result.content = `[Previous: used ${toolName}]`;
  }

  return messages;
}
```

</Lang>

2. **Layer 2 -- auto_compact**: When tokens exceed threshold, save full transcript to disk, then ask the LLM to summarize.

<Lang when="python">

```python
def auto_compact(messages: list) -> list:
    # Save transcript for recovery
    transcript_path = TRANSCRIPT_DIR / f"transcript_{int(time.time())}.jsonl"
    with open(transcript_path, "w") as f:
        for msg in messages:
            f.write(json.dumps(msg, default=str) + "\n")
    # LLM summarizes
    response = client.messages.create(
        model=MODEL,
        messages=[{"role": "user", "content":
            "Summarize this conversation for continuity..."
            + json.dumps(messages, default=str)[:80000]}],
        max_tokens=2000,
    )
    return [
        {"role": "user", "content": f"[Compressed]\n\n{response.content[0].text}"},
        {"role": "assistant", "content": "Understood. Continuing."},
    ]
```

</Lang>

<Lang when="ts">

```ts
async function autoCompact(messages: Message[]): Promise<Message[]> {
  const transcriptPath = resolve(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  for (const message of messages) {
    appendFileSync(transcriptPath, `${JSON.stringify(message)}\n`, "utf8");
  }

  const response = await client.messages.create({
    model: MODEL,
    messages: [{
      role: "user",
      content: "Summarize this conversation for continuity...\n\n" +
        JSON.stringify(messages).slice(0, 80_000),
    }],
    max_tokens: 2000,
  });

  return [
    { role: "user", content: `[Conversation compressed. Transcript: ${transcriptPath}]` },
    { role: "assistant", content: "Understood. I have the context from the summary. Continuing." },
  ];
}
```

</Lang>

3. **Layer 3 -- manual compact**: The `compact` tool triggers the same summarization on demand.

4. The loop integrates all three:

<Lang when="python">

```python
def agent_loop(messages: list):
    while True:
        micro_compact(messages)                        # Layer 1
        if estimate_tokens(messages) > THRESHOLD:
            messages[:] = auto_compact(messages)       # Layer 2
        response = client.messages.create(...)
        # ... tool execution ...
        if manual_compact:
            messages[:] = auto_compact(messages)       # Layer 3
```

</Lang>

<Lang when="ts">

```ts
export async function agentLoop(messages: Message[]) {
  while (true) {
    microCompact(messages);

    if (estimateTokens(messages) > THRESHOLD) {
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }

    const response = await client.messages.create(...);
    // ... tool execution ...

    if (manualCompact) {
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }
  }
}
```

</Lang>

Transcripts preserve full history on disk. Nothing is truly lost -- just moved out of active context.

## What Changed From s05

| Component      | Before (s05)     | After (s06)                |
|----------------|------------------|----------------------------|
| Tools          | 5                | 5 (base + compact)         |
| Context mgmt   | None             | Three-layer compression    |
| Micro-compact  | None             | Old results -> placeholders|
| Auto-compact   | None             | Token threshold trigger    |
| Transcripts    | None             | Saved to .transcripts/     |

## Try It

```sh
cd learn-claude-code
```

<Lang when="python">

```sh
python agents/s06_context_compact.py
```

1. `Read every Python file in the agents/ directory one by one` (watch micro-compact replace old results)
2. `Keep reading files until compression triggers automatically`
3. `Use the compact tool to manually compress the conversation`

</Lang>

<Lang when="ts">

```sh
cd agents-ts
npm install
npm run s06
```

1. `Read every TypeScript file in the agents-ts directory one by one` (watch micro-compact replace old results)
2. `Keep reading files until compression triggers automatically`
3. `Use the compact tool to manually compress the conversation`

</Lang>

