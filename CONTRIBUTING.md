# Contributing

Issues and focused pull requests are welcome.

## Development

```powershell
npm ci
npm run check
```

`npm run check` runs strict TypeScript checking, unit tests, and a production
build. Test plugin changes in a separate Obsidian vault before using them with
important notes.

Please keep provider prompts concise, preserve the existing privacy boundary,
and never commit API keys, `data.json`, private note text, or generated
`node_modules`.
