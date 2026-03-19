# s08: Background Tasks

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"Run slow operations in the background; the agent keeps thinking"* -- daemon threads run commands, inject notifications on completion.
>
> **Harness layer**: Background execution -- the model thinks while the harness waits.

## Problem

Some commands take minutes: `npm install`, `pytest`, `docker build`. With a blocking loop, the model sits idle waiting. If the user asks "install dependencies and while that runs, create the config file," the agent does them sequentially, not in parallel.

## Solution

```
Main thread                Background thread
+-----------------+        +-----------------+
| agent loop      |        | subprocess runs |
| ...             |        | ...             |
| [LLM call] <---+------- | enqueue(result) |
|  ^drain queue   |        +-----------------+
+-----------------+

Timeline:
Agent --[spawn A]--[spawn B]--[other work]----
             |          |
             v          v
          [A runs]   [B runs]      (parallel)
             |          |
             +-- results injected before next LLM call --+
```

## How It Works

1. BackgroundManager tracks tasks with a thread-safe notification queue.

<Lang when="python">

```python
class BackgroundManager:
    def __init__(self):
        self.tasks = {}
        self._notification_queue = []
        self._lock = threading.Lock()
```

</Lang>

<Lang when="ts">

```ts
class BackgroundManager {
  tasks: Record<string, BackgroundTask> = {};
  private notificationQueue: Array<{ task_id: string; status: string; result: string }> = [];
}
```

</Lang>

2. `run()` starts a daemon thread and returns immediately.

<Lang when="python">

```python
def run(self, command: str) -> str:
    task_id = str(uuid.uuid4())[:8]
    self.tasks[task_id] = {"status": "running", "command": command}
    thread = threading.Thread(
        target=self._execute, args=(task_id, command), daemon=True)
    thread.start()
    return f"Background task {task_id} started"
```

</Lang>

<Lang when="ts">

```ts
run(command: string) {
  const taskId = randomUUID().slice(0, 8);
  this.tasks[taskId] = { status: "running", result: null, command };
  const child = spawn(shell, args, { cwd: WORKDIR });
  return `Background task ${taskId} started`;
}
```

</Lang>

3. When the subprocess finishes, its result goes into the notification queue.

<Lang when="python">

```python
def _execute(self, task_id, command):
    try:
        r = subprocess.run(command, shell=True, cwd=WORKDIR,
            capture_output=True, text=True, timeout=300)
        output = (r.stdout + r.stderr).strip()[:50000]
    except subprocess.TimeoutExpired:
        output = "Error: Timeout (300s)"
    with self._lock:
        self._notification_queue.append({
            "task_id": task_id, "result": output[:500]})
```

</Lang>

<Lang when="ts">

```ts
child.on("close", () => {
  this.notificationQueue.push({
    task_id: taskId,
    status: "completed",
    result: result.slice(0, 500),
  });
});
```

</Lang>

4. The agent loop drains notifications before each LLM call.

<Lang when="python">

```python
def agent_loop(messages: list):
    while True:
        notifs = BG.drain_notifications()
        if notifs:
            notif_text = "\n".join(
                f"[bg:{n['task_id']}] {n['result']}" for n in notifs)
            messages.append({"role": "user",
                "content": f"<background-results>\n{notif_text}\n"
                           f"</background-results>"})
            messages.append({"role": "assistant",
                "content": "Noted background results."})
        response = client.messages.create(...)
```

</Lang>

<Lang when="ts">

```ts
const notifications = BG.drainNotifications();
if (notifications.length) {
  messages.push({
    role: "user",
    content: `<background-results>\n${notifText}\n</background-results>`,
  });
}
```

</Lang>

The loop stays single-threaded. Only subprocess I/O is parallelized.

## What Changed From s07

| Component      | Before (s07)     | After (s08)                |
|----------------|------------------|----------------------------|
| Tools          | 8                | 6 (base + background_run + check)|
| Execution      | Blocking only    | Blocking + background threads|
| Notification   | None             | Queue drained per loop     |
| Concurrency    | None             | Daemon threads             |

## Try It

```sh
cd learn-claude-code
```

<Lang when="python">

```sh
python agents/s08_background_tasks.py
```

</Lang>

<Lang when="ts">

```sh
cd agents-ts
npm install
npm run s08
```

</Lang>

1. `Run "sleep 5 && echo done" in the background, then create a file while it runs`
2. `Start 3 background tasks: "sleep 2", "sleep 4", "sleep 6". Check their status.`
3. `Run pytest in the background and keep working on other things`

