# Ash Log

Ash Log is a free, unofficial progress tracker for *RuneScape: Dragonwilds*. Tick off quest steps, find chests, ores and lore on a map, and keep track of which unique unlocks (like the patterns of armour sets) you already have. All game content comes from the [RuneScape: Dragonwilds Wiki](https://dragonwilds.runescape.wiki).

Ash Log is an app for your computer, Windows or Mac. There's no account and no cloud: your progress lives on your computer. Turn on **Live on Wi-Fi** and you can use it on your phone too, as long as it's on the same Wi-Fi.

## Contents

- [Download](#download)
- [Install on macOS](#install-on-macos)
- [Install on Windows](#install-on-windows)
- [First start](#first-start)
- [On your phone](#on-your-phone)
- [Updating](#updating)
- [Your data](#your-data)
- [Troubleshooting](#troubleshooting)
- [Run from source](#run-from-source)
- [Source and license](#source-and-license)

## Download

Get the latest version from the [Releases page](https://github.com/joost-meijerink/ash-log/releases/latest):

| Your computer | File |
|---|---|
| Mac with Apple silicon (M1 or newer) | `Ash-Log-<version>-mac-arm64.dmg` |
| Mac with an Intel processor | `Ash-Log-<version>-mac-x64.dmg` |
| Windows 10 or 11 | `Ash-Log-<version>-windows-setup.exe` |

Not sure which Mac you have? Open the Apple menu > **About This Mac**: it says "Chip Apple M…" or "Processor Intel".

Ash Log isn't signed with a paid Apple or Microsoft certificate yet. That's why your computer warns you the first time you open it. The steps below show how to open it anyway; you only have to do this once.

## Install on macOS

1. Open the `.dmg` and drag **Ash Log** onto **Applications**.
2. Open Ash Log from Applications. macOS says it can't verify the app. Click **Done** (not Move to Trash).
3. Open **System Settings > Privacy & Security**, scroll down to the message about Ash Log and click **Open Anyway**. Confirm with your password or Touch ID.
4. Open Ash Log again. From now on it just opens.

On macOS 12 to 14 you can also right-click Ash Log in Applications, choose **Open**, and then **Open** again.

Closing the window keeps Ash Log running, so your phone can still reach it. Quit it with **Cmd+Q** or by right-clicking the icon in the Dock.

## Install on Windows

1. Run `Ash-Log-<version>-windows-setup.exe`.
2. Windows shows "Windows protected your PC". Click **More info**, then **Run anyway**.
3. Ash Log installs for your user only (no administrator needed) and puts **Ash Log** in the Start menu and on your desktop.

Does Windows block it completely, without a Run anyway button? Then **Smart App Control** is on, and it doesn't allow unsigned apps. You can check this under Windows Security > App & browser control > Smart App Control.

Closing the window quits Ash Log. If Live on Wi-Fi is on, it asks first whether to keep running for your phone; it then keeps running in the background, with an icon in the corner of the taskbar to open or quit it.

To remove Ash Log: Settings > Apps > Installed apps > Ash Log > Uninstall. Your progress stays (see [Your data](#your-data)).

## First start

The map, quests and collections work right away: the game content from the wiki comes with the app. Click **Update from wiki** (top right) now and then to fetch the latest content. The first time, that takes a few minutes.


## On your phone

With **Live on Wi-Fi** you can use Ash Log on your phone: tick things off and look things up next to your game. Your progress stays on your computer; your phone reaches it over your Wi-Fi.

### Before you start

- Your computer and your phone are on **the same Wi-Fi**. A guest network, or Wi-Fi where devices can't see each other (like in many offices and hotels), won't work.
- Do the pairing **at home**, on your own Wi-Fi.
- **Windows:** set your Wi-Fi to **Private network**. Go to Settings > Network & internet > Wi-Fi, pick your network and under **Network profile type** choose **Private network**. On a public network, the firewall blocks your phone.
- Live on Wi-Fi is off after every start. Only the computer itself can turn it on.

### Once per phone

1. In Ash Log on your computer, click **Live** at the top right and turn on **Live on Wi-Fi**.
2. The first time, your computer asks whether Ash Log may accept connections. On Windows, tick only private networks and allow it. On a Mac, choose **Allow**, and allow Ash Log to find devices on your local network if macOS asks.
3. In the same window, under **Which phone?**, pick iPhone or Android.
4. **Install the certificate.** Your phone talks to your computer over a secure connection. For that, you install Ash Log's certificate once. Ash Log makes that certificate itself, and it only covers addresses on your own network, never real websites.
   - **iPhone:** scan the QR code with the camera, tap **Download Profile** on the page that opens and then **Allow**. Open Settings, tap **Profile Downloaded** and install it; the red "Not Signed" warning is expected. Then turn on Ash Log under Settings > General > About > **Certificate Trust Settings**.
   - **Android:** scan the QR code and tap **Download certificate**. Open Settings > Security & privacy > More security settings > Encryption & credentials > Install a certificate > **CA certificate**, tap **Install anyway** and pick `ash-log-ca.crt` from your Downloads. Are the menus named differently on your phone? Search Settings for "CA certificate". You need a screen lock, and use Chrome: other browsers don't always trust the certificate.
5. **Pair.** On your computer, click **Pair a device**. You get a QR code that works for 10 minutes. Scan it and open the link in Safari (iPhone) or Chrome (Android). Can't scan it? Open the address shown below it and type the 6 digits.
6. **Add it to your home screen.** iPhone: in Safari, tap Share > **Add to Home Screen**. Android: in Chrome, tap the three dots > **Add to Home screen**.

Then open Quests, Map and Collections once while your computer can be reached. That way your phone has everything it needs.

### After that

- Turn on Live on Wi-Fi on your computer and open Ash Log from your home screen. That's all.
- While Live on Wi-Fi is on, your computer won't go to sleep by itself (the screen will). Close a laptop's lid, though, and it sleeps anyway.
- If your computer is off or asleep, or Live on Wi-Fi is off, you'll see **Ash Log can't be reached** after a few seconds. With **View last known data** you can read everything back, but you can't tick anything off. Once your computer is back, Ash Log carries on by itself.
- Your paired devices are listed in the Live on Wi-Fi window on your computer. You can unpair them there too.

### Your phone's address

- **Mac with an iPhone:** your Mac's name, like `https://My-MacBook.local:5199`. That never changes.
- **Windows, Linux, or an Android phone:** your computer's address on your network, like `https://192.168.1.23:5199`.

If your router gives your computer a different address, the icon on your home screen stops working. Pair your phone again then (steps 5 and 6; the certificate can stay). You can prevent this by giving your computer a fixed address in your router (often called "DHCP reservation" or "static IP address").

Want to choose yourself? Put the line `LIVE_ADDRESS=name` (always your computer's name, `.local`) or `LIVE_ADDRESS=ip` (always the address) in a file called `.env` in [your data folder](#your-data). The name only works if your phone knows `.local` names: iPhones do, Android phones from version 12.

## Updating

Ash Log tells you when a new version is out (it checks GitHub at most once a day). Download it from the [Releases page](https://github.com/joost-meijerink/ash-log/releases/latest) and install it over the old one, the same way as the first time. Your progress, paired phones and certificate stay.

## Your data

Everything stays on your own computer, in Ash Log's data folder:

- **macOS:** `~/Library/Application Support/Ash Log` (in Finder: Go > Go to Folder, and paste that)
- **Windows:** `%APPDATA%\Ash Log` (paste that into the address bar of File Explorer)

| In that folder | What's in it |
|---|---|
| `data/progress.json` | your ticks: quest steps, map points, unlocks and vaults |
| `data/overrides.json` | your own corrections, like a quest location you put on the map yourself |
| `data/wiki`, `wiki-img` | game content you fetched with Update from wiki |
| `server/` | paired phones, Ash Log's certificate and the log file (`server.log`) |
| `.env` | optional settings, like `APP_PORT=5200` or `LIVE_ADDRESS=ip` |

Make a copy of `data/progress.json` now and then: that's your progress. Uninstalling Ash Log leaves this folder alone.

## Troubleshooting

- **What is Ash Log doing?** It's all in `server/server.log` in your data folder. On a Mac: Help > Open Server Log.
- **Port in use:** another program uses port 5199 (maybe Ash Log started from source). Close it, or put another port in `.env` in your data folder, for example `APP_PORT=5200`.
- **Your phone can't reach it:** is Live on Wi-Fi on (the Live button then has a gold dot)? Are both on the same Wi-Fi, and isn't that a guest network? On Windows: is your Wi-Fi set to Private network, and is Ash Log allowed through the firewall? Check Windows Security > Firewall & network protection > Allow an app through firewall. On a Mac: System Settings > Network > Firewall > Options, and System Settings > Privacy & Security > Local Network.
- **"This Connection Is Not Private" (Safari) or "Your connection is not private" (Chrome) on your phone:** the certificate isn't (fully) installed. Do step 4 of [On your phone](#on-your-phone) again. On an iPhone, the last step is easy to miss: Certificate Trust Settings.
- **The icon on your home screen stopped working:** your computer probably got a different address. See [Your phone's address](#your-phones-address).

## Run from source

For developers, and for Linux (there's no Linux app yet). You need Node.js 22.12 or newer and Git.

```
git clone https://github.com/joost-meijerink/ash-log.git
cd ash-log
npm install
```

To fetch content from the wiki yourself, copy `.env.example` to `.env` and put your own e-mail address or URL in `WIKI_USER_AGENT`: the wiki wants to know who uses its API. In this setup your data lives in the project folder (`data/` and `.local/`), not in the app's data folder.

```
npm run app            build and start Ash Log on http://localhost:5199 (Ctrl+C stops it)
npm run dev            dev server with hot reload on http://localhost:5173
npm run sync           fetch the game content; also --only=quests,rewards, --full and --no-tiles
npm test               all tests (against saved samples, never against the live wiki)
npm run typecheck      check TypeScript
npm run desktop:dev    run the desktop app from source (its data stays in .local/desktop-dev)
npm run desktop:build  package the desktop app for this computer, unpacked
npm run desktop:dist   build the macOS and Windows installers into release/
```

The older ways to start Ash Log from source still work: a Mac app built from the project (`npm run app:install`, see [scripts/desktop/README.md](scripts/desktop/README.md)) and Start menu shortcuts on Windows (see [scripts/windows/README.md](scripts/windows/README.md)).

Built with Vite, Vue 3, TypeScript, Pinia, Tailwind CSS, Leaflet and Electron.

Contributions are welcome. Be kind to the wiki: send your own User-Agent with contact details, make requests one at a time, and use only the API.

## Source and license

- **Code:** MIT license, see [LICENSE](LICENSE).
- **Game content:** the quests, map points, rewards, images and map tiles come from the [RuneScape: Dragonwilds Wiki](https://dragonwilds.runescape.wiki) and fall under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/). That also goes for `data/wiki`, the content that ships inside the app, the sea textures in `src/assets/sea` (made from the map tiles) and the Ash Logs sprite in the icon. So use those only non-commercially, with attribution and under the same license.
- *RuneScape* and *RuneScape: Dragonwilds* belong to Jagex. Ash Log is an unofficial fan tool and isn't affiliated with or endorsed by Jagex or the wiki.
