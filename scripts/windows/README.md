# Ash Log on Windows

Ash Log in your Start menu, with its own icon: one click starts the server and opens Ash Log in its own window. With Live on Wi-Fi you can use it on your phone too. Works on Windows 10 and 11, without admin rights.

## What you need

- Node.js 22.12 or later (the LTS version from nodejs.org is fine).
- Microsoft Edge (built into Windows) or Google Chrome, for the window.
- The project, with `npm install` done.

## Installing

```
npm run app:install
```

This puts **Ash Log** and **Stop Ash Log** in your Start menu. Want an icon on your desktop too: `npm run app:install -- --desktop`. To pin it to the taskbar, right-click Ash Log in Start.

The shortcuts remember where the project and Node are. Moved the project folder or using a different Node? Run `npm run app:install` again. The port (5199, or `APP_PORT` from `.env`) is read on every start.

To remove it: `npm run app:uninstall`. That stops Ash Log and removes the shortcuts, and also `%LOCALAPPDATA%\Ash Log` (the browser profile of the window). Your progress in `data\progress.json` stays.

An older version called the stop shortcut "Ash Log stoppen". Installing or uninstalling removes that old shortcut too.

## Starting and stopping

- **Start**: click Ash Log. For a moment you see a small console window (or just a button on the taskbar); it closes by itself once the window is open. The first time, and after a change to the source code, Ash Log builds the app first. That takes a moment.
- **The window** is Edge in app mode, with its own profile. So it's separate from your normal browser: no tabs, no extensions. No Edge? Then Chrome. Neither? Then your default browser, but Ash Log can't tell when you close that: stop it yourself with Stop Ash Log.
- **Close the window**: Ash Log stops. If Live on Wi-Fi is on, it first asks whether it should keep running for your phone.
- **Click Ash Log again** while it's running: you get another window.
- **Stop**: close the window, or pick Stop Ash Log in the Start menu. That stops the server and closes the window too.
- After a restart of your PC nothing runs, until you start Ash Log again.

## Live on Wi-Fi

Live on Wi-Fi is off after every start: then only your PC can reach Ash Log. Do this at home, on your own Wi-Fi.

1. **Wi-Fi set to private**: open Settings > Network & internet > Wi-Fi and pick your network. Under **Network profile type**, choose **Private network** (not Public network). On a public network, the firewall won't let your phone in.
2. In Ash Log on your PC, turn on **Live on Wi-Fi**.
3. **Firewall**: the first time, Windows asks whether Node.js JavaScript Runtime may accept connections. Tick only private networks and allow it.
4. On your PC, follow the steps in the Live on Wi-Fi window: your phone installs Ash Log's certificate once and gets paired with a QR code.

Refused it by accident, or can't your phone get in? Open Windows Security > **Firewall & network protection** > **Allow an app through firewall**, choose Change settings, find Node.js JavaScript Runtime and tick Private. Also check that your Wi-Fi really is set to Private network.

While Live on Wi-Fi is on, your PC won't go to sleep by itself (the screen will). Your phone can only reach it while your PC is on, Ash Log is running and both are on the same Wi-Fi.

## Problems

- Everything the server does is in `.local\server.log`. When something goes wrong, Ash Log offers to open that file in Notepad.
- **Port in use**: another program uses the port. Close it, or set a different port in `.env`, for example `APP_PORT=5200`.
- **Ash Log won't start after you moved the project folder or updated Node**: run `npm run app:install` again.
- **A console window stays open with an error**: read the message; it's in `.local\server.log` too.

## Without shortcuts

```
npm run app         builds and starts the server in the terminal (Ctrl+C stops it)
npm run app:serve   starts the server without building
```

Then open `http://localhost:5199`. The launcher itself also works from a terminal:

```
node --import tsx scripts/windows/launcher.ts               start and open the window
node --import tsx scripts/windows/launcher.ts --no-browser  start only the server
node --import tsx scripts/windows/launcher.ts --status      is it running? (exit 0 or 1)
node --import tsx scripts/windows/launcher.ts --stop        stop
```

## For developers

| File | What it does |
|---|---|
| `launcher.ts` | starts (building first when needed), opens the window, waits until it's closed, stops; with `--gui` it also shows messages in a dialog |
| `install.ts` | makes the shortcuts (through `npm run app:install`, see `scripts/install.ts`) |
| `shortcuts.ps1` | creates or removes the shortcuts with WScript.Shell; ASCII only, because Windows PowerShell 5.1 reads a file without a BOM as ANSI |
| `ash-log.ico` | the icon, made by `npx tsx scripts/desktop/make-icons.ts --ico` |
| `__fixtures__/` | fake server and fake vite for the tests |

How it works:

- The shortcut starts `node.exe` itself, minimized, with `launcher.ts --gui`. No PowerShell window: Windows Terminal (the default console of Windows 11) ignores `-WindowStyle Hidden` ([microsoft/terminal#12464](https://github.com/microsoft/terminal/issues/12464)). No .exe of its own: Smart App Control blocks unsigned programs.
- The launcher starts the server detached from itself (without a console, output to `.local\server.log`) and opens the window. Waiting for the window to close is done by a copy of the launcher (`--watch`), also without a console. That way no console window stays open.
- The window is Edge or Chrome with `--app` and its own `--user-data-dir` in `%LOCALAPPDATA%\Ash Log`. As long as that browser runs, it holds the `lockfile` in that profile; that's how the launcher knows the last window is closed.
- Messages (errors, the question about Live on Wi-Fi) are a `WScript.Shell` popup from Windows PowerShell. The text goes through an environment variable, never through the command line.

Testing without Windows: `npx vitest run scripts/windows scripts/install.test.ts`. The Windows side runs there on a simulated system; the whole chain (starting the server, the window, stopping) runs for real, with a fake browser. Overrides for tests and CI: `ASHENFALL_PORT`, `ASHENFALL_START_TIMEOUT`, `ASHENFALL_STOP_TIMEOUT`, `ASHENFALL_SERVER_ENTRY`, `ASHENFALL_VITE`, `ASHENFALL_BROWSER` and `ASH_LOG_LOCAL_DIR` (a folder other than `.local`, so a test never touches your real paired devices or certificate).
