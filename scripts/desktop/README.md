# Ash Log as a Mac app

A real Mac app with its own icon: it starts the local server and shows Ash Log in its own window. With Live on Wi-Fi you can use it on your iPhone too.

## Installing

```
npm run app:install
```

This builds `Ash Log.app` and puts it in the Applications folder in your home folder (`~/Applications`). Find it with Spotlight, or drag it from Finder to your Dock. Quit Ash Log first if it's still running.

Run it again when you move the project folder, switch to a different Node version or change the port: the app remembers where the project and Node are, and which port the server runs on.

You need the Swift compiler. It comes with Xcode, or install just the Command Line Tools with `xcode-select --install`.

## Starting and quitting

- **Start**: click the icon. The app starts the server on a fixed port (5199, or `APP_PORT` from `.env`) and shows Ash Log in its own window. If source files changed since last time, the app builds first (a few seconds). If the server is already running (through `npm run app`, for example), the app uses that one.
- **Close the window** (Cmd+W): the server keeps running, so your phone can still reach it. As long as the icon is in the Dock, the server runs.
- **Get the window back**: click the icon in the Dock.
- **Quit**: right-click the icon in the Dock and choose Quit (or Cmd+Q). That stops the server first, then the app. Logging out and shutting down do the same.
- **Server stopped**: if the server goes down while you're using it, the app tells you and you can choose: Restart or Quit.
- After a restart of your Mac nothing runs, until you click the icon again.

In the window:

- **Reload**: Cmd+R.
- **Bigger or smaller**: Cmd+plus, Cmd+minus, and Cmd+0 for the actual size. The app remembers your choice.
- **Back and forward**: swipe with two fingers, or Cmd+[ and Cmd+].
- **Links to the outside**, like the wiki, open in your normal browser. Other links (to files or other apps) do nothing.

The window belongs to Ash Log itself (it uses WebKit, like Safari). So there's no second Chrome icon in your Dock anymore. The app no longer uses the folder `~/Library/Application Support/Ash Log/chrome` from the previous version: feel free to delete it.

## Pairing your phone

Live on Wi-Fi, the certificate, pairing and what happens when your Mac isn't around: see [On your phone](../../README.md#on-your-phone) in the README. On a Mac with an iPhone, your phone uses your Mac's name (like `https://My-MacBook.local:5199`), so that address stays the same.

## When macOS asks something

- **Access to your Documents folder**: choose Allow. The project lives there; without access, the app can't start the server. You can change this later in System Settings > Privacy & Security > Files & Folders.
- **"Do you want the application "node" to accept incoming network connections?"**: choose Allow. The firewall asks this when you turn on Live on Wi-Fi for the first time. Refused it by accident? System Settings > Network > Firewall > Options, find node and choose Allow incoming connections.
- **Devices on your local network**: choose Allow. You can change this later in System Settings > Privacy & Security > Local Network.

After a reinstall, macOS may ask again: to macOS it's a new app then.

## Problems

- Everything the server does is in `.local/server.log`. When something goes wrong, the Open Log button opens that file, and in the app you'll also find it under Help > Open Server Log.
- **Port in use**: another program uses the port. Close it, or set a different port in `.env`, for example `APP_PORT=5200`, and run `npm run app:install` again.
- **Node not found**: Node was updated or moved. Run `npm run app:install` again.
- **Project folder not found**: moved it? Run `npm run app:install` again from the new place.
- **Old icon in the Dock** after a reinstall: `killall Dock`.

## Without the app

```
npm run app         builds and starts the server in the terminal (Ctrl+C stops it)
npm run app:serve   starts the server without building
```

The app uses a server that's already running, and stops it again when you quit the app.

The app also works without a window, handy to see what it does:

```
"$HOME/Applications/Ash Log.app/Contents/MacOS/AshLog" --print-config   project, Node and port
"$HOME/Applications/Ash Log.app/Contents/MacOS/AshLog" --start-server   start the server the way the app does
"$HOME/Applications/Ash Log.app/Contents/MacOS/AshLog" --stop-server    and stop it again
```

## For developers

| File | What it does |
|---|---|
| `native/AshLog.swift` | the app itself: window with WebKit, menus, starting and stopping the server, health check |
| `build-app.ts` | compiles the app with `swiftc` and builds the bundle (with `Info.plist` and icon) in `build/` |
| `install-app.sh` | builds the app and puts it in `~/Applications` |
| `start.sh`, `stop.sh`, `status.sh` | start, stop and check the server; the app calls `start.sh` and `stop.sh` |
| `lib.sh` | shared settings of the scripts |
| `__fixtures__/SelfTest.swift` | test driver: the tests compile the app with it, so they can try the links, stopping on quit and the scripts without a window |
| `make-icons.ts` | makes the icons: `public/icons/*.png`, `build/AppIcon.icns` and the Windows icon `scripts/windows/ash-log.ico` |
| `icon*.svg` | the icons: square, maskable, macOS, and small variants |

Changed the icon? Run `npx tsx scripts/desktop/make-icons.ts --web --ico` and commit the PNGs in `public/icons/` and `scripts/windows/ash-log.ico`; a test checks that they match the SVGs.

To try a script on its own on another port: `ASHENFALL_PORT=5300 sh scripts/desktop/start.sh` (and then `stop.sh` with the same port).

The build writes the project, Node and the port into `Info.plist` (`AshLogProjectDir`, `AshLogNode`, `AshLogPort`); the app passes Node and the port to the scripts as `ASHENFALL_NODE` and `ASHENFALL_PORT`. Changed `AshLog.swift`? Run `npm run app:install` (quit Ash Log first).

Debugging with the Web Inspector: in Safari, turn on Settings > Advanced > Show features for web developers, then choose Develop > (your Mac's name) > Ash Log.

## Icon

The icon is the Ash Logs sprite from the wiki (`File:Ash_Logs.png`, CC BY-NC-SA 3.0) on a leather tile. Sources: `icon*.svg` and `ash-logs.png` in this folder. After a change: `npx tsx scripts/desktop/make-icons.ts`, then `npm run app:install`.

## Editing the icon in Figma

`scripts/desktop/figma/` has two SVGs that Figma imports cleanly (drag them onto the canvas, or use File > Import):

- `ash-log-ios.svg`: iPhone home screen and web. Square to the edge; iOS rounds the corners itself. The pink dashed line (`iOS_mask_guide_hide_on_export`) shows where iOS cuts off: hide that layer before you export.
- `ash-log-macos.svg`: the Dock icon on Apple's icon grid (824 px body with a 100 px margin).

Layers: `Leather`, `Compass_rose`, `Borders` (`Border_outer`, `Border_inner`, `Border_gold`), `Diamonds` and `Ash_Logs`. The macOS file also has `Shape`, `Body` and `Rim_light`. The borders are plain strokes with Apple's continuous corners; change their width and colour through the stroke.

What Figma doesn't take over from the real sources: the leather grain (an SVG filter) and the shadow under the logs. You can add those in Figma as an effect (shadow under the logs: Drop shadow, y 12, blur 24, black 60%).

### Using your own version

The icons come from the two exports in `scripts/desktop/figma/`: `ash-log-ios.png` and `ash-log-macos.png` (1024 x 1024). When those are there, `make-icons.ts` makes everything from them: the iPhone and web icons, the favicon (with rounded corners), a maskable version (your design a bit smaller on a blurred copy of itself) and all sizes of the Dock icon. Without those two files, it falls back to the SVG sources (`icon*.svg`).

To change the icon:

1. Edit it in Figma and export both variants as 1024 x 1024 PNG, with the same names, to `scripts/desktop/figma/`. The iOS version must be opaque right into the corners (hide the guide); the macOS version has a transparent margin around the body (100 to 924 px).
2. `npm run app:icons`
3. `npm run app:install` (quit Ash Log first)

`npm run app:figma` makes the Figma SVGs again from the original SVG sources, if you want to start over from that design.
