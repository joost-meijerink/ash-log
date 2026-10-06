# Ash Log

**English:** Ash Log is a free, unofficial progress tracker for *RuneScape: Dragonwilds*. Tick off quest steps, find chests, ores and lore on an interactive map, and keep track of unique unlocks such as armour set patterns. All game content comes from the [RuneScape: Dragonwilds Wiki](https://dragonwilds.runescape.wiki) through its API. It runs on your own computer (Windows or macOS) and, over your home Wi-Fi, on your phone. The interface is in Dutch; the game texts stay in English. Installation steps are below (in Dutch).

---

Ash Log is een logboek voor *RuneScape: Dragonwilds*. Je vinkt queststappen af, zoekt kisten, ertsen en lore op een kaart, en houdt bij welke unieke unlocks (zoals de patterns van armour sets) je al hebt. Alle spelinhoud komt van de [RuneScape: Dragonwilds Wiki](https://dragonwilds.runescape.wiki).

Ash Log draait op je eigen computer, Windows of Mac. Er is geen account en geen cloud: je voortgang staat in een bestand op je computer. Zet je **Live op wifi** aan, dan gebruik je het ook op je telefoon, zolang die op hetzelfde wifi zit.

De schermen zijn Nederlands. Quests, stappen en itemnamen blijven Engels, zoals in het spel.

## Inhoud

- [Wat je nodig hebt](#wat-je-nodig-hebt)
- [Installeren](#installeren)
- [Op Windows](#op-windows)
- [Op een Mac](#op-een-mac)
- [Op je telefoon](#op-je-telefoon)
- [Bijwerken](#bijwerken)
- [Je gegevens](#je-gegevens)
- [Problemen](#problemen)
- [Ontwikkelen](#ontwikkelen)
- [Bron en licentie](#bron-en-licentie)

## Wat je nodig hebt

- **Windows 10 of 11**, of **macOS 13 of nieuwer**.
- **Node.js 22.12 of nieuwer.** Neem de LTS-versie van [nodejs.org](https://nodejs.org). npm zit erbij.
- **Op Windows:** Microsoft Edge (zit in Windows) of Google Chrome, voor het eigen venster van Ash Log.
- **Op een Mac:** de Command Line Tools van Xcode, voor de Mac-app. Installeer die met `xcode-select --install` in Terminal.
- **Git** is handig om later bij te werken, maar niet verplicht: je kunt het project ook als ZIP downloaden.
- **Voor je telefoon:** een iPhone met Safari of een Android-telefoon met Chrome, op hetzelfde wifi als je computer.

## Installeren

Deze stappen zijn voor Windows en Mac hetzelfde. Daarna volgt per systeem hoe je Ash Log met een eigen icoon start.

### 1. Het project downloaden

Met Git:

```
git clone https://github.com/joost-meijerink/ash-log.git
cd ash-log
```

Zonder Git: kies op GitHub **Code > Download ZIP**, pak de ZIP uit naar een vaste plek (bijvoorbeeld je map Documenten) en open die map in een terminal.

Een terminal openen in de projectmap:

- **Windows 11:** rechtsklik in de map in Verkenner en kies **Openen in Terminal**.
- **Windows 10:** klik in de adresbalk van Verkenner, typ `cmd` en druk op Enter.
- **Mac:** open Terminal, typ `cd ` (met een spatie), sleep de map in het venster en druk op Enter.

### 2. Installeren

```
npm install
```

Krijg je in PowerShell de melding dat het uitvoeren van scripts is uitgeschakeld? Typ dan `npm.cmd install`, of gebruik de Opdrachtprompt (`cmd`) in plaats van PowerShell. Dat geldt ook voor de andere `npm`-opdrachten hieronder.

### 3. Je contactgegevens voor de wiki

Ash Log haalt de spelinhoud op via de API van de wiki. De wiki wil weten wie dat doet, zodat de beheerders je kunnen bereiken als er iets misgaat. Daarvoor maak je een bestand `.env`:

- **Windows:** `copy .env.example .env` en daarna `notepad .env`
- **Mac:** `cp .env.example .env` en daarna `open -e .env`

Vervang in de regel `WIKI_USER_AGENT` het voorbeeldadres door je eigen e-mailadres, of door een URL waar je te bereiken bent (zoals je GitHub-pagina). Met het voorbeeldadres weigert de sync. `.env` blijft op je eigen computer.

### 4. De eerste sync

De quests, kaartpunten en beloningen zitten al in het project. De kaarttegels en iconen (zo'n 45 MB) haalt Ash Log één keer zelf op bij de wiki. Dat kan op twee manieren:

- Start Ash Log (zie hieronder) en klik rechtsboven op **Wiki bijwerken** (de knop met de pijlen).
- Of in de terminal: `npm run sync`

De eerste keer duurt dat een paar minuten, want Ash Log vraagt de wiki rustig om de beurt om elk bestand. Daarna gaat een sync veel sneller: alleen wat op de wiki veranderd is, komt opnieuw binnen.

## Op Windows

```
npm run app:install
```

Dit zet **Ash Log** en **Ash Log stoppen** in je Startmenu, met het Ash Log-icoon. Ook een icoon op je bureaublad? Gebruik dan `npm run app:install -- --desktop`. Je hebt er geen beheerdersrechten voor nodig.

- **Starten:** klik op Ash Log. De eerste keer bouwt Ash Log eerst de app, dat duurt even. Daarna opent het Logboek in een eigen venster (Edge of Chrome in app-modus, los van je gewone browser).
- **Stoppen:** sluit het venster. Staat Live op wifi aan, dan vraagt Ash Log eerst of hij moet blijven draaien voor je telefoon. Je kunt ook **Ash Log stoppen** in het Startmenu kiezen.
- **Weghalen:** `npm run app:uninstall`. Je voortgang blijft staan.

Verplaats je de projectmap of installeer je een andere versie van Node? Draai `npm run app:install` dan opnieuw.

Meer over het venster, de firewall en problemen op Windows: [scripts/windows/README.md](scripts/windows/README.md).

## Op een Mac

```
npm run app:install
```

Dit bouwt **Ash Log.app** en zet hem in de map Programma's van je gebruiker (`~/Applications`). Zoek hem met Spotlight of sleep hem naar je Dock.

- **Starten:** klik op het icoon. De app start de server en toont het Logboek in een eigen venster.
- **Venster sluiten** (Cmd+W): de server blijft draaien, zodat je telefoon er nog bij kan.
- **Stoppen:** Cmd+Q, of rechtsklik op het icoon in het Dock en kies Stop.

macOS vraagt een paar keer om toestemming: voor je map Documenten (als het project daar staat), voor inkomende verbindingen van node (bij Live op wifi) en voor apparaten op je lokale netwerk. Kies steeds Sta toe.

Meer over de Mac-app, het icoon en problemen: [scripts/desktop/README.md](scripts/desktop/README.md).

### Zonder app-icoon

Op beide systemen (en op Linux) kan het ook vanuit de terminal:

```
npm run app
```

Open daarna `http://localhost:5199` in je browser. Ctrl+C in de terminal stopt Ash Log.

## Op je telefoon

Met **Live op wifi** gebruik je Ash Log op je telefoon: noteren en opzoeken naast je game. Je voortgang blijft op je computer staan; je telefoon kijkt mee via je wifi.

### Voordat je begint

- Je computer en je telefoon zitten op **hetzelfde wifi**. Een gastnetwerk, of wifi waar apparaten elkaar niet mogen zien (zoals op veel kantoren en hotels), werkt niet.
- Doe het koppelen **thuis**, op je eigen wifi.
- **Windows:** zet je wifi op **Privénetwerk**. Ga naar Instellingen > Netwerk en internet > Wi-Fi, kies je netwerk en zet onder **Netwerkprofieltype** de optie **Privénetwerk** aan. Op een openbaar netwerk houdt de firewall je telefoon tegen.
- Live op wifi staat na elke start uit. Alleen de computer zelf kan het aanzetten.

### Eén keer per telefoon

1. Start Ash Log op je computer, klik rechtsboven op **Live** en zet **Live op wifi** aan.
2. De eerste keer vraagt je computer of node (Node.js) verbindingen mag ontvangen. Op Windows vink je alleen privénetwerken aan en sta je het toe. Op een Mac kies je Sta toe.
3. Kies in het Live-venster bij **Welke telefoon?** voor iPhone of Android.
4. **Certificaat installeren.** Je telefoon praat via een beveiligde verbinding met je computer. Daarvoor installeer je één keer het certificaat van Ash Log. Ash Log maakt dat certificaat zelf, en het geldt alleen voor adressen in je eigen netwerk, nooit voor echte websites.
   - **iPhone:** scan de QR-code met de camera en download het profiel op de pagina die opent (Sta toe). Open Instellingen, tik op **Profiel gedownload** en installeer het; de melding "niet ondertekend" hoort erbij. Zet daarna Ash Log aan bij Instellingen > Algemeen > Info > **Instellingen voor certificaatvertrouwen**.
   - **Android:** scan de QR-code en tik op **Certificaat downloaden**. Open Instellingen > Beveiliging en privacy > Meer beveiligingsinstellingen > Versleuteling en inloggegevens > Certificaat installeren > **CA-certificaat**, tik op **Toch installeren** en kies `ash-log-ca.crt` uit je Downloads. Heten de menu's op jouw telefoon anders? Zoek in Instellingen op "CA-certificaat". Je hebt een schermvergrendeling nodig, en gebruik Chrome: andere browsers vertrouwen het certificaat niet altijd.
5. **Koppelen.** Klik op je computer op **Koppel een apparaat**. Je krijgt een QR-code die 10 minuten geldig is. Scan hem en open de link in Safari (iPhone) of Chrome (Android). Lukt scannen niet? Open het adres dat erbij staat en typ de 6 cijfers.
6. **Op je beginscherm zetten.** iPhone: tik in Safari op Deel > **Zet op beginscherm**. Android: tik in Chrome op de drie puntjes > **Toevoegen aan startscherm**.

Open daarna Quests, Kaart en Verzamelingen één keer terwijl je computer bereikbaar is. Dan heeft je telefoon alles in huis.

### Daarna

- Zet Live op wifi aan op je computer en open Ash Log vanaf je beginscherm. Meer hoeft niet.
- Zolang Live op wifi aan staat, gaat je computer niet vanzelf slapen (het scherm wel). Klap je een laptop dicht, dan slaapt hij toch.
- Is je computer uit, in slaap of staat Live op wifi uit, dan zie je na een paar seconden **Ash Log is niet bereikbaar**. Met **Laatst bekende gegevens bekijken** lees je alles terug, maar vinkjes zetten kan dan niet. Komt je computer terug, dan gaat Ash Log vanzelf verder.
- Gekoppelde apparaten zie je in het Live-venster op je computer. Daar kun je ze ook ontkoppelen.

### Het adres van je telefoon

- **Mac met iPhone:** de naam van je Mac, zoals `https://Mijn-MacBook.local:5199`. Die blijft altijd hetzelfde.
- **Windows, Linux, of een Android-telefoon:** het adres van je computer in je netwerk, zoals `https://192.168.1.23:5199`.

Krijgt je computer van de router een ander adres, dan werkt het icoon op je beginscherm niet meer. Koppel je telefoon dan opnieuw (stap 5 en 6; het certificaat hoeft niet opnieuw). Voorkomen kan door in je router een vast adres voor je computer in te stellen (dat heet vaak "DHCP-reservering" of "vast IP-adres").

Wil je zelf kiezen? Zet in `.env` de regel `LIVE_ADDRESS=name` (altijd de naam van je computer, `.local`) of `LIVE_ADDRESS=ip` (altijd het adres). De naam werkt alleen als je telefoon `.local`-namen kent: iPhones wel, Android pas vanaf versie 12.

## Bijwerken

Met Git:

```
git pull
npm install
npm run app:install
```

Stop Ash Log eerst. Klik daarna in Ash Log op **Wiki bijwerken** om de nieuwste spelinhoud van de wiki op te halen.

Zonder Git: download de nieuwe ZIP en pak hem uit naar een nieuwe map. Kopieer uit je oude map `.env`, `data/progress.json`, `data/overrides.json` en de map `.local` (je gekoppelde telefoons en het certificaat) naar de nieuwe map. Draai daar `npm install` en `npm run app:install`.

## Je gegevens

Alles blijft op je eigen computer:

| Bestand | Wat erin staat |
|---|---|
| `data/progress.json` | je vinkjes: queststappen, kaartpunten, unlocks en vaults |
| `data/overrides.json` | je eigen correcties, zoals een questlocatie die je zelf op de kaart hebt gezet |
| `.env` | je contactgegevens voor de wiki en eventueel een andere poort |
| `.local/` | gekoppelde telefoons, het certificaat van Ash Log en het logbestand |

Deze bestanden staan niet in Git en gaan dus nooit mee naar GitHub. Maak af en toe een kopie van `data/progress.json`: dat is je voortgang.

## Problemen

- **Wat doet de server?** Alles staat in `.local/server.log` (op Windows `.local\server.log`).
- **Poort bezet:** een ander programma gebruikt poort 5199. Sluit dat, of zet in `.env` een andere poort, bijvoorbeeld `APP_PORT=5200`. Draai op een Mac daarna `npm run app:install` opnieuw.
- **De sync weigert:** zet je eigen e-mailadres of URL in `WIKI_USER_AGENT` in `.env` (zie [stap 3](#3-je-contactgegevens-voor-de-wiki)).
- **Je telefoon kan er niet bij:** staat Live op wifi aan (de knop Live heeft dan een gouden stip)? Zitten beide op hetzelfde wifi, en is dat geen gastnetwerk? Op Windows: staat je wifi op Privénetwerk en mag Node.js door de firewall? Kijk in Windows-beveiliging > Firewall- en netwerkbeveiliging > Een app doorlaten door de firewall. Op een Mac: Systeeminstellingen > Netwerk > Firewall > Opties.
- **"Deze verbinding is niet privé" op je telefoon:** het certificaat is niet (helemaal) geïnstalleerd. Doe stap 4 van [Op je telefoon](#op-je-telefoon) opnieuw. Op een iPhone vergeet je makkelijk de laatste stap: Instellingen voor certificaatvertrouwen.
- **Het icoon op je beginscherm werkt niet meer:** waarschijnlijk heeft je computer een ander adres gekregen. Zie [Het adres van je telefoon](#het-adres-van-je-telefoon).
- **npm geeft in PowerShell een fout over scripts:** gebruik `npm.cmd` in plaats van `npm`, of de Opdrachtprompt.

## Ontwikkelen

```
npm run dev         ontwikkelserver met hot reload op http://localhost:5173
npm test            alle tests (tegen opgeslagen voorbeelden, nooit tegen de echte wiki)
npm run typecheck   TypeScript controleren
npm run sync        spelinhoud ophalen; ook --only=quests,rewards, --full en --no-tiles
```

Gebouwd met Vite, Vue 3, TypeScript, Pinia, Tailwind CSS en Leaflet. De afspraken voor de code staan in [CLAUDE.md](CLAUDE.md), het oorspronkelijke plan en de beslissingen in [docs/](docs/).

Bijdragen zijn welkom. Houd je aan de regels voor de wiki in CLAUDE.md: een eigen User-Agent met contactgegevens, verzoeken één voor één, en alleen de API.

## Bron en licentie

- **Code:** MIT-licentie, zie [LICENSE](LICENSE).
- **Spelinhoud:** de quests, kaartpunten, beloningen, afbeeldingen en kaarttegels komen van de [RuneScape: Dragonwilds Wiki](https://dragonwilds.runescape.wiki) en vallen onder [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/). Dat geldt ook voor `data/wiki`, de zeetexturen in `src/assets/sea` (gemaakt uit de kaarttegels) en de Ash Logs-sprite in het icoon. Gebruik die dus alleen niet-commercieel, met bronvermelding en onder dezelfde licentie.
- *RuneScape* en *RuneScape: Dragonwilds* zijn van Jagex. Ash Log is een onofficiële fantool en is niet verbonden aan of goedgekeurd door Jagex of de wiki.
