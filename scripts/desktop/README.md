# Ash Log als Mac-app

Een echte Mac-app met eigen icoon: hij start de lokale server en toont het Logboek in zijn eigen venster. Met Live op wifi gebruik je het ook op je iPhone.

## Installeren

```
npm run app:install
```

Dit bouwt `Ash Log.app` en zet hem in je eigen map Programma's (`~/Applications`). Zoek hem met Spotlight, of sleep hem vanuit Finder naar je Dock. Stop Ash Log eerst als hij nog draait.

Draai het opnieuw als je de projectmap verplaatst, een andere Node-versie gaat gebruiken of de poort verandert: de app onthoudt waar het project en Node staan en op welke poort de server draait.

Je hebt de Swift-compiler nodig. Die zit bij Xcode, of installeer alleen de Command Line Tools met `xcode-select --install`.

## Starten en stoppen

- **Starten**: klik op het icoon. De app start de server op een vaste poort (5199, of `APP_PORT` uit `.env`) en toont het Logboek in zijn eigen venster. Zijn er bronbestanden gewijzigd sinds de vorige keer, dan bouwt de app eerst opnieuw (een paar seconden). Draait de server al (bijvoorbeeld via `npm run app`), dan gebruikt de app die.
- **Venster sluiten** (Cmd+W): de server blijft draaien, dus je telefoon kan er nog bij. Zolang het icoon in het Dock staat, draait de server.
- **Venster terughalen**: klik op het icoon in het Dock.
- **Stoppen**: rechtsklik op het icoon in het Dock en kies Stop (of Cmd+Q). Dat stopt eerst de server, daarna de app. Uitloggen en afsluiten doen hetzelfde.
- **Server gestopt**: valt de server onderweg weg, dan zegt de app dat en kun je kiezen: Opnieuw starten of Stoppen.
- Na een herstart van je Mac draait er niets, tot je het icoon weer aanklikt.

In het venster:

- **Herladen**: Cmd+R.
- **Groter of kleiner**: Cmd+plus, Cmd+min, en Cmd+0 voor de werkelijke grootte. De app onthoudt je keuze.
- **Terug en vooruit**: veeg met twee vingers, of Cmd+[ en Cmd+].
- **Links naar buiten**, zoals de wiki, openen in je gewone browser. Met andere links (naar bestanden of andere apps) doet de app niets.

Het venster is van Ash Log zelf (het gebruikt WebKit, net als Safari). Er komt dus geen tweede Chrome-icoon meer in je Dock. De map `~/Library/Application Support/Ash Log/chrome` van de vorige versie gebruikt de app niet meer: die mag je zelf weggooien.

## Je telefoon koppelen

Live op wifi, het certificaat, koppelen en wat er gebeurt als je Mac er niet is: zie [Op je telefoon](../../README.md#op-je-telefoon) in de README. Op een Mac met iPhone gebruikt je telefoon de naam van je Mac (zoals `https://Mijn-MacBook.local:5199`), dus dat adres blijft hetzelfde.

## Als macOS iets vraagt

- **Toegang tot je map Documenten**: kies Sta toe. Het project staat daar, zonder toegang kan de app de server niet starten. Terugzetten kan in Systeeminstellingen > Privacy en beveiliging > Bestanden en mappen.
- **"Wil je dat het programma node inkomende netwerkverbindingen accepteert?"**: kies Sta toe. Dit vraagt de firewall als je Live op wifi voor het eerst aanzet. Per ongeluk geweigerd? Systeeminstellingen > Netwerk > Firewall > Opties, zoek node en kies Sta inkomende verbindingen toe.
- **Apparaten op je lokale netwerk**: kies Sta toe. Terugzetten kan in Systeeminstellingen > Privacy en beveiliging > Lokaal netwerk.

Na opnieuw installeren kan macOS dit opnieuw vragen: voor macOS is het dan een nieuwe app.

## Problemen

- Alles wat de server doet staat in `.local/server.log`. Bij een foutmelding opent de knop Log openen dat bestand, en in de app vind je het ook onder Help > Serverlog openen.
- **Poort bezet**: een ander programma gebruikt de poort. Sluit dat, of zet een andere poort in `.env`, bijvoorbeeld `APP_PORT=5200`, en draai `npm run app:install` opnieuw.
- **Node niet gevonden**: Node is bijgewerkt of verplaatst. Draai `npm run app:install` opnieuw.
- **Projectmap niet gevonden**: verplaatst? Draai `npm run app:install` opnieuw vanuit de nieuwe plek.
- **Oud icoon in het Dock** na opnieuw installeren: `killall Dock`.

## Zonder app

```
npm run app         bouwt en start de server in de terminal (Ctrl+C stopt hem)
npm run app:serve   start de server zonder te bouwen
```

De app gebruikt een server die al draait, en stopt hem ook weer als je de app stopt.

De app zelf kan het ook zonder venster, handig om te zien wat hij doet:

```
"$HOME/Applications/Ash Log.app/Contents/MacOS/AshLog" --print-config   project, Node en poort
"$HOME/Applications/Ash Log.app/Contents/MacOS/AshLog" --start-server   server starten zoals de app dat doet
"$HOME/Applications/Ash Log.app/Contents/MacOS/AshLog" --stop-server    en weer stoppen
```

## Voor ontwikkelaars

| Bestand | Wat het doet |
|---|---|
| `native/AshLog.swift` | de app zelf: venster met WebKit, menu's, server starten en stoppen, gezondheidscontrole |
| `build-app.ts` | compileert de app met `swiftc` en bouwt de bundel (met `Info.plist` en icoon) in `build/` |
| `install-app.sh` | bouwt de app en zet hem in `~/Applications` |
| `start.sh`, `stop.sh`, `status.sh` | server starten, stoppen en controleren; de app roept `start.sh` en `stop.sh` aan |
| `lib.sh` | gedeelde instellingen van de scripts |
| `__fixtures__/SelfTest.swift` | testdriver: de tests compileren de app hiermee en proberen zo zonder venster de links, het stoppen bij afsluiten en de scripts |
| `make-icons.ts` | maakt de iconen: `public/icons/*.png`, `build/AppIcon.icns` en het Windows-icoon `scripts/windows/ash-log.ico` |
| `icon*.svg` | de iconen: vierkant, maskable, macOS, en kleine varianten |

Icoon aangepast? Draai `npx tsx scripts/desktop/make-icons.ts --web --ico` en commit de PNG's in `public/icons/` en `scripts/windows/ash-log.ico`; een test controleert dat ze bij de SVG's passen.

Een script los proberen op een andere poort: `ASHENFALL_PORT=5300 sh scripts/desktop/start.sh` (en daarna `stop.sh` met dezelfde poort).

Het project, Node en de poort zet de build in `Info.plist` (`AshLogProjectDir`, `AshLogNode`, `AshLogPort`); de app geeft Node en de poort aan de scripts door als `ASHENFALL_NODE` en `ASHENFALL_PORT`. `AshLog.swift` aangepast? Draai `npm run app:install` (stop Ash Log eerst).

Debuggen met de Web Inspector: zet in Safari bij Instellingen > Geavanceerd de functies voor webontwikkelaars aan, en kies dan Ontwikkel > (naam van je Mac) > Ash Log.

## Icoon

Het icoon is de Ash Logs-sprite van de wiki (`File:Ash_Logs.png`, CC BY-NC-SA 3.0) op een lederen tegel. Bronnen: `icon*.svg` en `ash-logs.png` in deze map. Na een wijziging: `npx tsx scripts/desktop/make-icons.ts` en daarna `npm run app:install`.

## Icoon bewerken in Figma

In `scripts/desktop/figma/` staan twee SVG's die Figma netjes importeert (sleep ze op het canvas, of Bestand > Importeren):

- `ash-log-ios.svg`: iPhone-beginscherm en web. Vierkant tot de rand, iOS rondt de hoeken zelf af. De roze stippellijn (`iOS-masker_hulplijn_verbergen_bij_export`) laat zien waar iOS afsnijdt: verberg die laag voor je exporteert.
- `ash-log-macos.svg`: het Dock-icoon op Apple's icoonraster (body van 824 px met 100 px marge).

Lagen: `Leer`, `Kompasroos`, `Randen` (`Rand_buiten`, `Rand_binnen`, `Rand_goud`), `Ruitjes` en `Ash_Logs`. De randen zijn gewone lijnen met Apple's continue hoeken; dikte en kleur pas je aan via de stroke.

Wat Figma niet overneemt uit de echte bronnen: de leernerf (een SVG-filter) en de schaduw onder de logs. Die kun je in Figma als effect toevoegen (schaduw onder de logs: Drop shadow, y 12, blur 24, zwart 60%).

### Je eigen versie gebruiken

De iconen komen uit de twee exports in `scripts/desktop/figma/`: `ash-log-ios.png` en `ash-log-macos.png` (1024 x 1024). Staan die er, dan maakt `make-icons.ts` daar alles van: de iPhone- en webiconen, de favicon (met afgeronde hoeken), een maskable versie (je ontwerp iets kleiner op een vervaagde kopie ervan) en alle maten van het Dock-icoon. Zonder die twee bestanden valt het terug op de SVG-bronnen (`icon*.svg`).

Icoon aanpassen:

1. Bewerk het in Figma en exporteer beide varianten als PNG van 1024 x 1024, met dezelfde namen, naar `scripts/desktop/figma/`. De iOS-versie moet dekkend zijn tot in de hoeken (verberg de hulplijn), de macOS-versie heeft een transparante rand rond de body (100 tot 924 px).
2. `npm run app:icons`
3. `npm run app:install` (stop Ash Log eerst)

`npm run app:figma` maakt de Figma-SVG's opnieuw vanuit de oorspronkelijke SVG-bronnen, als je vanaf dat ontwerp opnieuw wilt beginnen.
