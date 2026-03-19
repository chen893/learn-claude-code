# TypeScript Agents

`agents-ts` 是一套可单独运行的 TypeScript 版本示例。

## 环境要求

- Node.js 20+
- npm 10+

## 安装

```bash
cd agents-ts
npm install
```

## 配置

复制 `.env.example` 为 `.env`，然后填写你的凭证。

默认接入参数：

- `MODEL_ID=claude-sonnet-4-6`
- `ANTHROPIC_BASE_URL` 留空时走 Anthropic 官方默认端点

鉴权优先级：

1. `ANTHROPIC_AUTH_TOKEN`
2. `ANTHROPIC_API_KEY`

## 运行

```bash
npm run s01
```


## 校验

```bash
npm run typecheck
```


## 章节脚本

- `npm run s01`
- `npm run s02`
- `npm run s03`
- `npm run s04`
- `npm run s05`
- `npm run s06`
- `npm run s07`
- `npm run s08`
- `npm run s09`
- `npm run s10`
- `npm run s11`
- `npm run s12`
