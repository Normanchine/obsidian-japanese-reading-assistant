# Japanese Reading Assistant

[中文说明](#中文说明)

Japanese Reading Assistant is an Obsidian plugin for reading Japanese books,
articles, and study notes without leaving the current page. Select a word for a
compact dictionary-style explanation, or select a sentence for one consistent
translation shared by contextual vocabulary and grammar views.

The result appears in a separate non-modal popup instead of an Obsidian notice.

## Features

- Translate a selected Japanese word or short phrase.
- Show reading, part of speech, dictionary form, and a concise usage note.
- Analyze a selected sentence with one shared translation.
- Extract memorization-worthy vocabulary and distinguish core meanings from
  meanings in the current sentence.
- Mark grammar fragments in the source sentence with color-linked wavy
  underlines.
- Explain each grammar pattern's function and connection in one short note.
- Pin, drag, resize, and copy from the popup; use a bottom sheet on mobile.
- Work in Markdown editing, Live Preview, and Reading view.
- Use a local Ollama model or the DeepSeek API.
- Trigger automatically after selection, optionally only while holding Ctrl,
  Alt, or Shift.

## Requirements

- Obsidian 1.11.5 or later.
- One configured provider:
  - Ollama running locally or on an address reachable from the current device.
  - A DeepSeek account and API key.

The default Ollama endpoint is `http://127.0.0.1:11434`, and the default model
is `qwen2.5:7b`. Other chat models may work if they reliably follow structured
JSON output.

## Installation

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the release whose tag
matches the plugin version. Put them in:

```text
<Vault>/.obsidian/plugins/japanese-reading-assistant/
```

Then reload Obsidian and enable **Japanese Reading Assistant** under
**Settings → Community plugins**.

### BRAT beta

Before the plugin is accepted into the Obsidian community directory, you can
install the repository through BRAT as a beta plugin.

## Usage

1. Select Japanese text in an editor or Reading view.
2. The plugin classifies a short selection as a word and a longer selection as
   a sentence.
3. For a sentence, switch between **Vocabulary** and **Grammar analysis**
   without sending another model request. Both views always share the same
   translation.

When Alt is configured as the trigger, hold Alt before pressing the mouse
button and drag across the text. While Alt auto-triggering is enabled, Alt-drag
in the editor is treated as a normal linear selection instead of CodeMirror's
rectangular selection.

Commands and the editor context menu are available when automatic querying is
disabled or manual control is preferred.

## Network use and privacy

The plugin has no telemetry and does not access or upload entire notes.

| Provider | Data sent | Destination | Account or cost |
| --- | --- | --- | --- |
| Ollama | Current selection and the fixed analysis prompt | The Ollama address configured by the user | No account required; compute runs on that server |
| DeepSeek | Current selection and the fixed analysis prompt | The DeepSeek-compatible API address configured by the user | API key and possible provider charges |

- Filenames, vault paths, note titles, surrounding notes, and full vault
  contents are not sent.
- Nearby editor text is used only on-device to avoid accidentally
  auto-sending an ordinary Chinese-only selection.
- The DeepSeek API key is stored with Obsidian Secret Storage and is not written
  to the plugin's `data.json`.
- Results are cached only in memory and disappear when Obsidian closes.
- A custom provider address receives the same selected text, so only configure
  endpoints you trust.
- On mobile, `127.0.0.1` refers to the mobile device itself. A desktop Ollama
  server requires an explicitly configured LAN address and appropriate local
  network security.

## Current boundaries

- Markdown editing, Live Preview, and Markdown Reading view are supported.
- Selection capture inside PDF, EPUB, canvas, or third-party iframe readers is
  not guaranteed.
- Vocabulary cards and spaced-repetition export are planned but are not
  persisted in the current release.

## Development

```powershell
npm ci
npm run check
```

`npm run check` runs strict TypeScript checks, unit tests, and a production
build. The generated `main.js` is attached to releases and is not committed to
the source branch.

## License

MIT © 2026 [Yicong Zhang](https://github.com/Normanchine)

---

## 中文说明

Japanese Reading Assistant（日语阅读助手）是一个面向日语书籍、文章和学习
笔记阅读的 Obsidian 插件。它把结果显示在独立的非模态悬浮窗中：

- 划选单词或短语：显示翻译、假名、词性和必要用法。
- 划选句子：只请求模型一次，生成统一译文、可背诵词汇和精炼语法解析。
- 词汇页区分词典基本义和当前句中的具体意思。
- 语法页在原句中用不同颜色的波浪线对应标注，并说明句中作用与简短接续。
- 支持固定、拖动、缩放和复制；移动端使用底部面板。
- 支持 Markdown 编辑、实时预览和阅读视图。
- 支持本地 Ollama 与 DeepSeek API。

### 中文安装说明

从对应版本的 GitHub Release 下载：

```text
main.js
manifest.json
styles.css
```

放入：

```text
<Vault>/.obsidian/plugins/japanese-reading-assistant/
```

重新加载 Obsidian 后，在“设置 → 第三方插件”中启用
**Japanese Reading Assistant**。正式进入社区插件市场前，也可以通过 BRAT
安装此 GitHub 仓库进行测试。

### 隐私说明

插件只向你配置的 Ollama 或 DeepSeek 兼容地址发送当前选中文字和固定提示词，
不会发送文件名、Vault 路径、整篇笔记或整个仓库，不包含遥测。DeepSeek API
Key 保存在 Obsidian Secret Storage 中，不写入插件 `data.json`。自定义服务
地址同样会收到选中文字，请只配置可信端点。

作者：张艺聪（Yicong Zhang）
