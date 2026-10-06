# Ash Log

Ash Log is a free, unofficial progress tracker for *RuneScape: Dragonwilds*. Tick off quest steps, find chests, ores and lore on a map, and keep track of which unique unlocks (like the patterns of armour sets) you already have. All game content comes from the [RuneScape: Dragonwilds Wiki](https://dragonwilds.runescape.wiki) through its API.

Ash Log runs on your own computer, Windows or Mac. There's no account and no cloud: your progress lives in a file on your computer. Turn on **Live on Wi-Fi** and you can use it on your phone too, as long as it's on the same Wi-Fi.

## Contents

- [What you need](#what-you-need)
- [Installing](#installing)
- [On Windows](#on-windows)
- [On a Mac](#on-a-mac)
- [On your phone](#on-your-phone)
- [Updating](#updating)
- [Your data](#your-data)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Source and license](#source-and-license)

## What you need

- **Windows 10 or 11**, or **macOS 13 or later**.
- **Node.js 22.12 or later.** Get the LTS version from [nodejs.org](https://nodejs.org). npm comes with it.
- **On Windows:** Microsoft Edge (built into Windows) or Google Chrome, for Ash Log's own window.
- **On a Mac:** the Xcode Command Line Tools, for the Mac app. Install them with `xcode-select --install` in Terminal.
- **Git** makes updating easier later, but you don't need it: you can also download the project as a ZIP.
- **For your phone:** an iPhone with Safari or an Android phone with Chrome, on the same Wi-Fi as your computer.

## Installing

These steps are the same on Windows and Mac. After that, each system has its own section on starting Ash Log from its own icon.

### 1. Download the project

With Git:

```
git clone https://github.com/joost-meijerink/ash-log.git
cd ash-log
```

Without Git: on GitHub, choose **Code > Download ZIP**, unzip it to a place where it can stay (your Documents folder, for example) and open that folder in a terminal.

To open a terminal in the project folder:

- **Windows 11:** right-click inside the folder in File Explorer and choose **Open in Terminal**.
- **Windows 10:** click the address bar of File Explorer, type `cmd` and press Enter.
- **Mac:** open Terminal, type `cd ` (with a space), drag the folder into the window and press Enter.

### 2. Install

```
npm install
```

Does PowerShell tell you that running scripts is disabled on this system? Then type `npm.cmd install`, or use Command Prompt (`cmd`) instead of PowerShell. The same goes for the other `npm` commands below.

### 3. Your contact details for the wiki

Ash Log fetches the game content through the wiki's API. The wiki wants to know who's doing that, so its admins can reach you if something goes wrong. For that, you create a file called `.env`:

- **Windows:** `copy .env.example .env`, then `notepad .env`
- **Mac:** `cp .env.example .env`, then `open -e .env`

On the `WIKI_USER_AGENT` line, replace the example address with your own e-mail address, or with a URL where you can be reached (like your GitHub page). The sync refuses the example address. `.env` stays on your own computer.

### 4. The first sync

The quests, map points and rewards already come with the project. Ash Log fetches the map tiles and icons (about 45 MB) from the wiki itself, once. There are two ways to do that:

- Start Ash Log (see below) and click **Update from wiki** at the top right (the button with the arrows).
- Or in the terminal: `npm run sync`

The first time takes a few minutes, because Ash Log politely asks the wiki for one file at a time. After that, a sync is much faster: only what changed on the wiki comes in again.

## On Windows

```
npm run app:install
```

This puts **Ash Log** and **Stop Ash Log** in your Start menu, with the Ash Log icon. Want an icon on your desktop too? Use `npm run app:install -- --desktop`. You don't need admin rights.

- **Start:** click Ash Log. The first time, Ash Log builds the app first, which takes a moment. Then it opens in its own window (Edge or Chrome in app mode, separate from your normal browser).
- **Stop:** close the window. If Live on Wi-Fi is on, Ash Log first asks whether it should keep running for your phone. You can also pick **Stop Ash Log** in the Start menu.
- **Remove:** `npm run app:uninstall`. Your progress stays.

Moved the project folder or installed another version of Node? Run `npm run app:install` again.

More about the window, the firewall and problems on Windows: [scripts/windows/README.md](scripts/windows/README.md).

## On a Mac

```
npm run app:install
```

This builds **Ash Log.app** and puts it in the Applications folder in your home folder (`~/Applications`). Find it with Spotlight or drag it to your Dock.

- **Start:** click the icon. The app starts the server and shows Ash Log in its own window.
- **Close the window** (Cmd+W): the server keeps running, so your phone can still reach it.
- **Quit:** Cmd+Q, or right-click the icon in the Dock and choose Quit.

macOS asks for permission a few times: for your Documents folder (if the project is there), for incoming connections to node (with Live on Wi-Fi) and for devices on your local network. Choose Allow each time.

More about the Mac app, the icon and problems: [scripts/desktop/README.md](scripts/desktop/README.md).

### Without an app icon

On both systems (and on Linux) you can also run it from the terminal:

```
npm run app
```

Then open `http://localhost:5199` in your browser. Ctrl+C in the terminal stops Ash Log.

## On your phone

With **Live on Wi-Fi** you can use Ash Log on your phone: tick things off and look things up next to your game. Your progress stays on your computer; your phone reaches it over your Wi-Fi.

### Before you start

- Your computer and your phone are on **the same Wi-Fi**. A guest network, or Wi-Fi where devices can't see each other (like in many offices and hotels), won't work.
- Do the pairing **at home**, on your own Wi-Fi.
- **Windows:** set your Wi-Fi to **Private network**. Go to Settings > Network & internet > Wi-Fi, pick your network and under **Network profile type** choose **Private network**. On a public network, the firewall blocks your phone.
- Live on Wi-Fi is off after every start. Only the computer itself can turn it on.

### Once per phone

1. Start Ash Log on your computer, click **Live** at the top right and turn on **Live on Wi-Fi**.
2. The first time, your computer asks whether node (Node.js) may accept connections. On Windows, tick only private networks and allow it. On a Mac, choose Allow.
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

Want to choose yourself? Put the line `LIVE_ADDRESS=name` in `.env` (always your computer's name, `.local`) or `LIVE_ADDRESS=ip` (always the address). The name only works if your phone knows `.local` names: iPhones do, Android phones from version 12.

## Updating

With Git:

```
git pull
npm install
npm run app:install
```

Stop Ash Log first. Then click **Update from wiki** in Ash Log to fetch the latest game content from the wiki.

Without Git: download the new ZIP and unzip it to a new folder. Copy `.env`, `data/progress.json`, `data/overrides.json` and the `.local` folder (your paired phones and the certificate) from your old folder to the new one. Run `npm install` and `npm run app:install` there.

## Your data

Everything stays on your own computer:

| File | What's in it |
|---|---|
| `data/progress.json` | your ticks: quest steps, map points, unlocks and vaults |
| `data/overrides.json` | your own corrections, like a quest location you put on the map yourself |
| `.env` | your contact details for the wiki, and maybe a different port |
| `.local/` | paired phones, Ash Log's certificate and the log file |

These files aren't in Git, so they never end up on GitHub. Make a copy of `data/progress.json` now and then: that's your progress.

## Troubleshooting

- **What is the server doing?** It's all in `.local/server.log` (on Windows `.local\server.log`).
- **Port in use:** another program uses port 5199. Close it, or set a different port in `.env`, for example `APP_PORT=5200`. On a Mac, run `npm run app:install` again after that.
- **The sync refuses to run:** put your own e-mail address or URL in `WIKI_USER_AGENT` in `.env` (see [step 3](#3-your-contact-details-for-the-wiki)).
- **Your phone can't reach it:** is Live on Wi-Fi on (the Live button then has a gold dot)? Are both on the same Wi-Fi, and isn't that a guest network? On Windows: is your Wi-Fi set to Private network, and is Node.js allowed through the firewall? Check Windows Security > Firewall & network protection > Allow an app through firewall. On a Mac: System Settings > Network > Firewall > Options.
- **"This Connection Is Not Private" (Safari) or "Your connection is not private" (Chrome) on your phone:** the certificate isn't (fully) installed. Do step 4 of [On your phone](#on-your-phone) again. On an iPhone, the last step is easy to miss: Certificate Trust Settings.
- **The icon on your home screen stopped working:** your computer probably got a different address. See [Your phone's address](#your-phones-address).
- **npm gives an error about scripts in PowerShell:** use `npm.cmd` instead of `npm`, or Command Prompt.

## Development

```
npm run dev         dev server with hot reload on http://localhost:5173
npm test            all tests (against saved samples, never against the live wiki)
npm run typecheck   check TypeScript
npm run sync        fetch the game content; also --only=quests,rewards, --full and --no-tiles
```

Built with Vite, Vue 3, TypeScript, Pinia, Tailwind CSS and Leaflet.

Contributions are welcome. Be kind to the wiki: send your own User-Agent with contact details, make requests one at a time, and use only the API.

## Source and license

- **Code:** MIT license, see [LICENSE](LICENSE).
- **Game content:** the quests, map points, rewards, images and map tiles come from the [RuneScape: Dragonwilds Wiki](https://dragonwilds.runescape.wiki) and fall under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/). That also goes for `data/wiki`, the sea textures in `src/assets/sea` (made from the map tiles) and the Ash Logs sprite in the icon. So use those only non-commercially, with attribution and under the same license.
- *RuneScape* and *RuneScape: Dragonwilds* belong to Jagex. Ash Log is an unofficial fan tool and isn't affiliated with or endorsed by Jagex or the wiki.
