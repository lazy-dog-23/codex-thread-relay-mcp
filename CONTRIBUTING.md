# Contributing

中文摘要：欢迎贡献。请优先保持 relay 工具兼容、状态模型稳定、验证完整，再考虑扩展功能。

## Before You Start

- Open an issue first for behavior changes that affect public MCP tools or relay semantics.
- Keep refactors separate from bug fixes unless they are tightly coupled.
- Preserve compatibility for existing relay tools unless the change explicitly updates the public contract.

## Local Setup

Prerequisites:

- Node.js 22
- npm
- Git
- PowerShell 7
- Windows Codex App environment for live smoke or soak validation

Install dependencies:

```powershell
npm install
```

## Expected Verification

For most changes, run:

```powershell
npm run check
npm test
npm run smoke
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

For async dispatch, callback delivery, recovery, or lease changes, also run:

```powershell
npm run soak
```

If the change only touches docs, keep the diff focused and make sure the repository remains free of malformed patch output.

## Change Guidelines

- Keep the original relay tools compatible.
- Prefer durable state and explicit error codes over implicit fallback behavior.
- Keep same-project nested dispatch and callback paths in mind when changing lease or recovery logic.
- Do not rely on private Codex internals outside the supported public surfaces already used by this project.
- Keep README and validation guidance aligned with the actual tool behavior.

## Pull Request Notes

Please include:

- what changed
- why it changed
- the public surface affected
- verification you ran
- known follow-up or residual risk

If you change error codes, callback envelopes, recovery behavior, or dispatch resolution rules, call that out clearly.

## License

By contributing to this repository, you agree that your contributions will be released under the MIT License used by this project.
