# s03: TodoWrite

`s01 > s02 > [ s03 ] s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"An agent without a plan drifts"* -- list the steps first, then execute.
>
> **Harness layer**: Planning -- keeping the model on course without scripting the route.

## Problem

On multi-step tasks, the model loses track. It repeats work, skips steps, or wanders off. Long conversations make this worse -- the system prompt fades as tool results fill the context. A 10-step refactoring might complete steps 1-3, then the model starts improvising because it forgot steps 4-10.

## Solution

```text
+--------+      +-------+      +---------+
|  User  | ---> |  LLM  | ---> | Tools   |
| prompt |      |       |      | + todo  |
+--------+      +---+---+      +----+----+
                    ^                |
                    |   tool_result  |
                    +----------------+
                          |
              +-----------+-----------+
              | TodoManager state     |
              | [ ] task A            |
              | [>] task B  <- doing  |
              | [x] task C            |
              +-----------------------+
                          |
              if rounds_since_todo >= 3:
                inject <reminder> into tool_result
```

## How It Works

1. TodoManager stores items with statuses. Only one item can be `in_progress` at a time.

<Lang when="python">

```python
class TodoManager:
    def update(self, items: list) -> str:
        validated, in_progress_count = [], 0
        for item in items:
            status = item.get("status", "pending")
            if status == "in_progress":
                in_progress_count += 1
            validated.append({"id": item["id"], "text": item["text"],
                              "status": status})
        if in_progress_count > 1:
            raise ValueError("Only one task can be in_progress")
        self.items = validated
        return self.render()
```

</Lang>

<Lang when="ts">

```ts
class TodoManager {
  private items: TodoItem[] = [];

  update(items: unknown): string {
    if (!Array.isArray(items)) {
      throw new Error("items must be an array");
    }

    let inProgressCount = 0;
    const validated = items.map((item, index) => {
      const record = (item ?? {}) as Record<string, unknown>;
      const text = String(record.text ?? "").trim();
      const status = String(record.status ?? "pending").toLowerCase() as TodoStatus;
      const id = String(record.id ?? index + 1);

      if (status === "in_progress") inProgressCount += 1;
      return { id, text, status };
    });

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }
}
```

</Lang>

2. The `todo` tool goes into the dispatch map like any other tool.

<Lang when="python">

```python
TOOL_HANDLERS = {
    # ...base tools...
    "todo": lambda **kw: TODO.update(kw["items"]),
}
```

</Lang>

<Lang when="ts">

```ts
const TOOL_HANDLERS = {
  // ...base tools...
  todo: (input) => TODO.update(input.items),
};
```

</Lang>

3. A nag reminder injects a nudge if the model goes 3+ rounds without calling `todo`.

<Lang when="python">

```python
if rounds_since_todo >= 3 and messages:
    last = messages[-1]
    if last["role"] == "user" and isinstance(last.get("content"), list):
        last["content"].insert(0, {
            "type": "text",
            "text": "<reminder>Update your todos.</reminder>",
        })
```

</Lang>

<Lang when="ts">

```ts
if (roundsSinceTodo >= 3) {
  results.unshift({
    type: "text",
    text: "<reminder>Update your todos.</reminder>",
  });
}
```

</Lang>

The "one in_progress at a time" constraint forces sequential focus. The nag reminder creates accountability.

## What Changed From s02

| Component      | Before (s02)     | After (s03)                |
|----------------|------------------|----------------------------|
| Tools          | 4                | 5 (+todo)                  |
| Planning       | None             | TodoManager with statuses  |
| Nag injection  | None             | `<reminder>` after 3 rounds|
| Agent loop     | Simple dispatch  | + rounds_since_todo counter|

## Try It

```sh
cd learn-claude-code
```

<Lang when="python">

```sh
python agents/s03_todo_write.py
```

1. `Refactor the file hello.py: add type hints, docstrings, and a main guard`
2. `Create a Python package with __init__.py, utils.py, and tests/test_utils.py`
3. `Review all Python files and fix any style issues`

</Lang>

<Lang when="ts">

```sh
cd agents-ts
npm install
npm run s03
```

1. `Refactor the file hello.ts: add type annotations, comments, and a small CLI entry`
2. `Create a TypeScript package with index.ts, utils.ts, and tests/utils.test.ts`
3. `Review all TypeScript files and fix any style issues`

</Lang>
