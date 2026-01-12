<p align="center">
  <img width="full" src="https://github.com/user-attachments/assets/ac1cd9e3-f811-4af7-9338-7d6d0c80fcd7" />
</p>


<h1 align="center">Browser CLI </h1>

<div align="center">
  
  [![Discord](https://img.shields.io/discord/1391101800052035714?color=7289DA&label=Discord&logo=discord&logoColor=white)](https://discord.gg/N7crMvEX)
  [![Twitter Follow](https://img.shields.io/twitter/follow/browse_make?style=social)](https://x.com/intent/user?screen_name=browse_make)
  
</div>

`br` is a command line tool used by any capable LLM agent, like ChatGPT, [Claude Code](https://github.com/anthropics/claude-code) or [Gemini CLI](https://github.com/google-gemini/gemini-cli).

https://www.npmjs.com/package/@browsemake/browser-cli

## Why Browser CLI?
- **Just works**: simply browser automation, coding not required, leave the rest workflow to the most powerful LLM agent
- **AI first**: designed for LLM agent, readable view from HTML, and error hint
- **Secure**: can be run locally, no credential passed to LLM 
- **Robust**: browser persisted progress across session, and track history action for replay

## Install
```bash
npm install -g @browsemake/browser-cli
```

## Usage
Type instruction to AI agent (Gemini CLI / Claude Code / ChatGPT):

```
> You have browser automation tool 'br', use it to go to amazon to buy me a basketball
```

Use command line directly by human:

```bash
br start
br goto https://github.com/
```

## Demos

Grocery (Go to Amazon and buy me a basketball)
<div align="center">
    <a href="https://www.loom.com/share/b7aeba65bb0b4c4bb5bbef9b59b4b9dc">
      <img style="max-width:300px;" src="https://github.com/user-attachments/assets/3cd46b9a-6ef9-4987-a952-fcd22890334c">
    </a>
</div>

Navigate to GitHub repo:
<div align="center">
    <a href="https://www.loom.com/share/0ef198e259864ae08afa9ae9f78acfac">
      <img style="max-width:300px;" src="https://cdn.loom.com/sessions/thumbnails/0ef198e259864ae08afa9ae9f78acfac-3e42df07f2040874-full-play.gif">
    </a>
</div>


Print invoice

Download bank account statement

Search for job posting

## Features
- **Browser Action**: Comprehensive action for browser automation (navigation, click, etc.)
- **LLM friendly output**: LLM friendly command output with error correction hint
- **Daemon mode**: Always-on daemon mode so it lives across multiple LLM sessions
- **Structured web page view**: Accessibility tree view for easier LLM interpretation than HTML
- **Secret management**: Secret management to isolate password from LLM
- **History tracking**: History tracking for replay and scripting

## Command

### Start the daemon
```bash
br start
```
If starting the daemon fails (for example due to missing Playwright browsers),
the CLI prints the error output so you can diagnose the issue.

### Navigate to a URL
```bash
br goto https://example.com
```

### Click an element

```bash
br click "button.submit"
```

Commands that accept a CSS selector (like `click`, `fill`, `scrollIntoView`, `type`) can also accept a numeric ID. These IDs are displayed in the output of `br view-tree` and allow for direct interaction with elements identified in the tree.

### Scroll element into view

```bash
br scrollIntoView "#footer"
```

### Scroll to percentage of page

```bash
br scrollTo 50
```

### Fill an input field

```bash
br fill "input[name='q']" "search text"
```

### Fill an input field with a secret

```bash
MY_SECRET="top-secret" br fill-secret "input[name='password']" MY_SECRET
```

When retrieving page HTML with `br view-html`, any text provided via
`fill-secret` is masked to avoid exposing secrets.

### Type text into an input

```bash
br type "input[name='q']" "search text"
```

### Press a key

```bash
br press Enter
```

### Scroll next/previous chunk

```bash
br nextChunk
br prevChunk
```

### View page HTML

```bash
br view-html
```

### View action history

```bash
br history
```

### Clear action history

```bash
br clear-history
```

### Capture a screenshot

```bash
br screenshot
```

### View accessibility and DOM tree

```bash
br view-tree
```

Outputs a hierarchical tree combining accessibility roles with DOM element
information. It also builds an ID-to-XPath map for quick element lookup.

### List open tabs

```bash
br tabs
```

### Switch to a tab by index

```bash
br switch-tab 1
```

### Stop the daemon

```bash
br stop
```

The daemon runs a headless Chromium browser and exposes a small HTTP API. The CLI communicates with it to perform actions like navigation and clicking elements.
