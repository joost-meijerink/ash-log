# Ash Log op Windows

Ash Log in je Startmenu, met eigen icoon: één klik start de server en opent het Logboek in een eigen venster. Met Live op wifi gebruik je het ook op je telefoon. Werkt op Windows 10 en 11, zonder beheerdersrechten.

## Wat je nodig hebt

- Node.js 22.12 of nieuwer (de LTS-versie van nodejs.org is prima).
- Microsoft Edge (zit in Windows) of Google Chrome, voor het venster.
- Het project met `npm install` erin.

## Installeren

```
npm run app:install
```

Dit zet **Ash Log** en **Ash Log stoppen** in je Startmenu. Wil je ook een icoon op je bureaublad: `npm run app:install -- --desktop`. Op de taakbalk zetten kan via rechtsklik op Ash Log in Start.

De snelkoppelingen onthouden waar het project en Node staan. Verplaats je de projectmap of gebruik je een andere Node? Draai `npm run app:install` dan opnieuw. De poort (5199, of `APP_PORT` uit `.env`) leest Ash Log bij elke start.

Weghalen: `npm run app:uninstall`. Dat stopt Ash Log, haalt de snelkoppelingen weg en ook `%LOCALAPPDATA%\Ash Log` (het browserprofiel van het venster). Je voortgang in `data\progress.json` blijft staan.

## Starten en stoppen

- **Starten**: klik op Ash Log. Even zie je een klein consolevenster (of alleen een knop op de taakbalk); dat gaat vanzelf dicht zodra het venster open is. De eerste keer, en na een wijziging in de broncode, bouwt Ash Log eerst de app. Dat duurt even.
- **Het venster** is Edge in app-modus, met een eigen profiel. Het staat dus los van je gewone browser: geen tabbladen, geen extensies. Geen Edge? Dan Chrome. Geen van beide? Dan je standaardbrowser, maar die kan Ash Log niet zien sluiten: stop dan zelf met Ash Log stoppen.
- **Venster sluiten**: Ash Log stopt. Staat Live op wifi aan, dan vraagt hij eerst of hij moet blijven draaien voor je telefoon.
- **Nog eens op Ash Log klikken** terwijl hij draait: je krijgt er een venster bij.
- **Stoppen**: sluit het venster, of kies Ash Log stoppen in het Startmenu. Dat stopt de server en sluit ook het venster.
- Na een herstart van je pc draait er niets, tot je Ash Log weer start.

## Live op wifi

Live op wifi staat na elke start uit: dan kan alleen je pc erbij. Doe dit thuis, op je eigen wifi.

1. **Wifi op privé**: open Instellingen > Netwerk en internet > Wi-Fi en kies je netwerk. Zet onder **Netwerkprofieltype** de optie **Privénetwerk** aan (niet Openbaar netwerk). Op een openbaar netwerk laat de firewall je telefoon er niet bij.
2. Zet in Ash Log op je pc **Live op wifi** aan.
3. **Firewall**: de eerste keer vraagt Windows of Node.js JavaScript Runtime verbindingen mag ontvangen. Vink alleen privénetwerken aan en sta het toe.
4. Volg op je pc de stappen in het Live-venster: je telefoon installeert één keer het certificaat van Ash Log en wordt gekoppeld met een QR-code.

Per ongeluk geweigerd, of komt je telefoon er niet bij? Open Windows-beveiliging > **Firewall- en netwerkbeveiliging** > **Een app doorlaten door de firewall**, kies Instellingen wijzigen, zoek Node.js JavaScript Runtime en vink Privé aan. Kijk ook of je wifi echt op Privénetwerk staat.

Zolang Live op wifi aan staat, gaat je pc niet vanzelf slapen (het scherm wel). Je telefoon kan er alleen bij als je pc aan staat, Ash Log draait en jullie op hetzelfde wifi zitten.

## Problemen

- Alles wat de server doet staat in `.local\server.log`. Bij een foutmelding biedt Ash Log aan dat bestand in Kladblok te openen.
- **Poort bezet**: een ander programma gebruikt de poort. Sluit dat, of zet een andere poort in `.env`, bijvoorbeeld `APP_PORT=5200`.
- **Node niet gevonden** of **Projectmap niet gevonden**: draai `npm run app:install` opnieuw.
- **Er blijft een consolevenster open met een foutmelding**: lees de melding, die staat ook in `.local\server.log`.

## Zonder snelkoppelingen

```
npm run app         bouwt en start de server in de terminal (Ctrl+C stopt hem)
npm run app:serve   start de server zonder te bouwen
```

Open daarna `http://localhost:5199`. De launcher zelf kan ook vanuit een terminal:

```
node --import tsx scripts/windows/launcher.ts               starten en venster openen
node --import tsx scripts/windows/launcher.ts --no-browser  alleen de server starten
node --import tsx scripts/windows/launcher.ts --status      draait hij? (exit 0 of 1)
node --import tsx scripts/windows/launcher.ts --stop        stoppen
```

## Voor ontwikkelaars

| Bestand | Wat het doet |
|---|---|
| `launcher.ts` | starten (eerst bouwen als dat moet), venster openen, wachten tot het dicht is, stoppen; met `--gui` ook meldingen in een venster |
| `install.ts` | maakt de snelkoppelingen (via `npm run app:install`, zie `scripts/install.ts`) |
| `shortcuts.ps1` | maakt of verwijdert de snelkoppelingen met WScript.Shell; alleen ASCII, want Windows PowerShell 5.1 leest een bestand zonder BOM als ANSI |
| `ash-log.ico` | het icoon, gemaakt door `npx tsx scripts/desktop/make-icons.ts --ico` |
| `__fixtures__/` | nep-server en nep-vite voor de tests |

Hoe het werkt:

- De snelkoppeling start `node.exe` zelf, geminimaliseerd, met `launcher.ts --gui`. Geen PowerShell-venster: Windows Terminal (de standaardconsole van Windows 11) negeert `-WindowStyle Hidden` ([microsoft/terminal#12464](https://github.com/microsoft/terminal/issues/12464)). Geen eigen .exe: Smart App Control blokkeert programma's zonder handtekening.
- De launcher start de server los van zichzelf (zonder console, uitvoer naar `.local\server.log`) en opent het venster. Het wachten tot het venster dicht is doet een kopie van de launcher (`--watch`), ook zonder console. Zo blijft er geen consolevenster open staan.
- Het venster is Edge of Chrome met `--app` en een eigen `--user-data-dir` in `%LOCALAPPDATA%\Ash Log`. Zolang die browser draait, houdt hij het bestand `lockfile` in dat profiel vast; daaraan ziet de launcher dat het laatste venster dicht is.
- Meldingen (fouten, de vraag over Live op wifi) zijn een `WScript.Shell`-popup uit Windows PowerShell. De tekst gaat via een omgevingsvariabele, nooit via de opdrachtregel.

Testen zonder Windows: `npx vitest run scripts/windows scripts/install.test.ts`. De Windows-kant draait daar met een nagebootst systeem; de hele keten (server starten, venster, stoppen) draait echt, met een nep-browser. Overrides voor tests en CI: `ASHENFALL_PORT`, `ASHENFALL_START_TIMEOUT`, `ASHENFALL_STOP_TIMEOUT`, `ASHENFALL_SERVER_ENTRY`, `ASHENFALL_VITE`, `ASHENFALL_BROWSER` en `ASH_LOG_LOCAL_DIR` (een andere map dan `.local`, zodat een test nooit je echte gekoppelde apparaten of certificaat raakt).
