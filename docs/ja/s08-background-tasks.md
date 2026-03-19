# s08: Background Tasks

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"遅い操作はバックグラウンドへ、エージェントは次を考え続ける"* -- デーモンスレッドがコマンド実行、完了後に通知を注入。
>
> **Harness 層**: バックグラウンド実行 -- モデルが考え続ける間、Harness が待つ。

## 問題

一部のコマンドは数分かかる: `npm install`、`pytest`、`docker build`。ブロッキングループでは、モデルはサブプロセスの完了を待って座っている。ユーザーが「依存関係をインストールして、その間にconfigファイルを作って」と言っても、エージェントは並列ではなく逐次的に処理する。

## 解決策

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

## 仕組み

1. BackgroundManagerがスレッドセーフな通知キューでタスクを追跡する。

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

2. `run()`がデーモンスレッドを開始し、即座にリターンする。

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

3. サブプロセス完了時に、結果を通知キューへ。

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

4. エージェントループが各LLM呼び出しの前に通知をドレインする。

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

ループはシングルスレッドのまま。サブプロセスI/Oだけが並列化される。

## s07からの変更点

| Component      | Before (s07)     | After (s08)                |
|----------------|------------------|----------------------------|
| Tools          | 8                | 6 (base + background_run + check)|
| Execution      | Blocking only    | Blocking + background threads|
| Notification   | None             | Queue drained per loop     |
| Concurrency    | None             | Daemon threads             |

## 試してみる

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

