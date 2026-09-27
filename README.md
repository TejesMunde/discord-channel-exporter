# discord-channel-exporter

A [Vencord](https://github.com/Vendicated/Vencord) plugin that exports every message in a Discord channel to JSON. Full history with reply chains and attachment metadata, plus a live capture mode for messages as they arrive.

Two buttons are injected in a vertical stack just left of the chat box:

| Button | Action |
| --- | --- |
| `⬇ Export` | Downloads the entire channel history. Shows a live count while running. Click again on the same channel to cancel. |
| `● Live` | Starts recording `MESSAGE_CREATE` events. Click again to stop and save. Turns red with a count while recording. |

## Install

### One click

| OS | Command |
| --- | --- |
| Windows | Double click `install.cmd` |
| macOS / Linux | `pwsh ./install.ps1` (needs [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/installing-powershell)) |

The installer finds your Vencord checkout by checking `$VENCORD_DIR`, `~/Vencord`, `~/Downloads/Vencord`, `~/code/Vencord`, and the folder next to this repo. If none exists it clones Vencord to `~/Vencord` (needs `git`). Then it:

1. Copies `*.ts` and `*.tsx` into `src/userplugins/FetchChannelMessages`
2. Runs `pnpm install` and `pnpm run build`
3. Copies `dist` into your Vencord data dir, or runs `pnpm run inject` if Vencord was never injected
4. Tells you to fully quit Discord and reopen it

Vencord data dirs: `%APPDATA%\Vencord\dist` (Windows), `~/Library/Application Support/Vencord/dist` (macOS), `~/.config/Vencord/dist` (Linux).

### Manual

```bash
git clone https://github.com/Vendicated/Vencord && cd Vencord && pnpm install
cp -R /path/to/discord-channel-exporter src/userplugins/FetchChannelMessages
pnpm build && pnpm inject
```

Restart Discord. The plugin appears in **Settings > Plugins**.

## Output

Files land in `~/Downloads` with no dialog prompt. Single file for small channels, chunked for large ones:

```
general-1788524967852.json                     # under 50,000 messages
general-1788524967852-part001.json             # 50,000 each, part003 onwards
live-1234567890123456789-1788524967852.json    # live capture
```

Each record:

```json
{
  "id": "1234567890123456789",
  "author": "username#0001 (987654321098765432)",
  "content": "message text",
  "timestamp": "2026-09-04T12:00:00.000Z",
  "replyTo": "1100000000000000000",
  "replyToAuthor": "username",
  "attachments": 2,
  "attachmentUrls": ["https://cdn.discordapp.com/..."],
  "imageUrls": ["https://cdn.discordapp.com/..."],
  "attachmentsDetailed": [
    {
      "url": "https://cdn.discordapp.com/...",
      "proxyUrl": "https://media.discordapp.net/...",
      "filename": "screenshot.png",
      "contentType": "image/png",
      "width": 1920,
      "height": 1080
    }
  ],
  "threadId": null
}
```

`imageUrls` includes attachment images plus embed images and thumbnails, ready to pipe into a downloader. Messages are sorted by snowflake ID, so ordering is correct even though fetches run in parallel.

## How it handles big channels

- **100 messages per request**, 150ms between pages.
- **Rate limits**: a `429` triggers exponential backoff (1s, 2s, 4s, 8s, 16s plus jitter) and retries up to 5 times.
- **Parallel segments**: channels older than 7 days have their time span split into 5 segments fetched concurrently, which is roughly 5x faster.
- **Chunking**: 50,000 messages per file so a 500k message channel does not produce one giant JSON blob.
- **Resume**: progress is checkpointed in `localStorage` under `fcm-resume-<channelId>`. If an export dies partway, the next run offers to resume from the last saved part.
- **Cancel**: clicking `⬇ Export` again while it is running aborts that channel and keeps the parts already written.

Saving tries three paths in order: the Vencord native helper, direct Node `fs`, then a browser download as last resort. The last one may show a save dialog if you have "Ask where to save files" enabled.

## Console commands

Open Discord's devtools console (`Ctrl+Shift+I` / `Cmd+Option+I`). Every log line is prefixed.

```
[FCM] Resuming 1234567890 from part 3 total 100000 before=...
[FCM] 429 rate limited, retry 1 in 1032ms
[FCM] auto-saved /Users/you/Downloads/general-...-part003.json
```

To cancel an export from the console instead of clicking:

```js
__FCM_abort("1234567890123456789")
```

## Troubleshooting

**`No messages (empty channel or no permission)`**
The account cannot read the channel, or the channel is genuinely empty.

**`Export failed: ... 401`**
The request was not authenticated. Make sure Vencord is actually injected (you should see the Vencord settings tab) rather than only running from a source checkout.

**Buttons do not appear**
A `MutationObserver` on `document.body` re-injects the bar whenever Discord re-renders the chat area. If it is still missing, check the console for errors and confirm the plugin is enabled in **Settings > Plugins**.

**Count is slightly lower than Discord's own search result**
Deleted messages and messages hidden from search are not returned by the API. A gap of a few on a 9k message channel is normal.

## Files

| File | Purpose |
| --- | --- |
| `index.tsx` | The whole plugin. No runtime dependencies beyond Vencord's `@webpack/common`. |
| `native.ts` | Optional Vencord native module, writes JSON straight to `~/Downloads` with no dialog. |
| `install.ps1` / `install.cmd` | One click installer. |

Logs are tagged `[FCM]` and `[FetchChannelMessages]`. The internal plugin id stays `FetchChannelMessages` so existing installs keep their settings and folder.

## License

MIT. Built as a fork of a Vencord userplugin.
