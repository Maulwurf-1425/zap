# Changelog

Each release has a `## <version>` heading, optionally followed by ` – <update name>`,
and one `### English` and one `### Deutsch` section. The release workflow publishes the
section of the tagged version, and ZAP shows it before and after updating.

## 0.5.0 – Welcome ZAPs!

### English

- **ZAPs:** small agents that do a task by themselves in the background. Give one a job in your
  own words and the tools it may use: PowerShell commands, opening apps, files and links, web
  research, and your files. Watch every step live, stop it any time, and look back at earlier
  runs with their report.
- **Ask the chat:** "Create a ZAP that sorts my downloads every morning" – the chat sets it up,
  starts, stops or deletes ZAPs for you. Creating and deleting always need your OK.
- **You stay in control:** choose whether every command needs your OK or ZAPs may run freely.
  Commands that could damage Windows or wipe data always ask, no matter what.
- **Schedules:** start a ZAP when ZAP starts, every few minutes or hours, or daily at a set time
  (only on chosen weekdays, if you like).
- **Runs in the background:** closing the window keeps ZAP in the tray, it can start with Windows,
  and a notification tells you when a ZAP is done or waits for your OK. Click it to jump right
  to that ZAP.
- **Fast and frugal:** thinking can be switched off per ZAP (much faster, far fewer tokens), and
  limits for tokens and runtime stop a ZAP that runs too long. Every run shows its runtime and
  tokens, live and in total.
- **Avatars:** every ZAP gets its own face (generated on your PC with DiceBear), or keeps the ZAP
  bolt.
- **Resources at a glance (F5):** press F5 anywhere to see CPU, RAM, graphics card and tokens used
  by ZAP, Ollama, LM Studio and SearXNG, and unload models you don't need.
- **Smarter model choice:** ZAP warns when a model won't fit into your graphics memory or can't
  use tools, and unloads idle models after a time you choose.
- **Nicer menus:** dropdowns now match the rest of ZAP.

### Deutsch

- **ZAPs:** kleine Agents, die eine Aufgabe selbstständig im Hintergrund erledigen. Gib einem ZAP
  einen Auftrag in deinen Worten und die Werkzeuge, die er nutzen darf: PowerShell-Befehle, Apps,
  Dateien und Links öffnen, Web-Recherche und deine Dateien. Du siehst jeden Schritt live, kannst
  jederzeit stoppen und frühere Läufe mit ihrem Bericht nachlesen.
- **Einfach den Chat fragen:** „Leg einen ZAP an, der jeden Morgen meine Downloads sortiert“ –
  der Chat richtet ihn ein, startet, stoppt oder löscht ZAPs für dich. Anlegen und Löschen
  brauchen immer dein OK.
- **Du behältst die Kontrolle:** Entscheide, ob jeder Befehl dein OK braucht oder ZAPs frei
  arbeiten dürfen. Befehle, die Windows beschädigen oder Daten löschen könnten, fragen immer.
- **Zeitpläne:** Starte einen ZAP beim Start von ZAP, alle paar Minuten oder Stunden oder täglich
  zu einer festen Uhrzeit (auf Wunsch nur an bestimmten Wochentagen).
- **Läuft im Hintergrund:** Beim Schließen bleibt ZAP im Infobereich, es kann mit Windows starten,
  und eine Benachrichtigung sagt dir, wenn ein ZAP fertig ist oder auf dein OK wartet. Ein Klick
  darauf bringt dich direkt zu diesem ZAP.
- **Schnell und sparsam:** Nachdenken lässt sich pro ZAP abschalten (viel schneller, deutlich
  weniger Tokens), und Grenzen für Tokens und Laufzeit stoppen einen ZAP, der zu lange läuft. Jeder
  Lauf zeigt Laufzeit und Tokens, live und insgesamt.
- **Avatare:** Jeder ZAP bekommt ein eigenes Gesicht (auf deinem PC mit DiceBear erzeugt) oder
  behält den ZAP-Blitz.
- **Ressourcen auf einen Blick (F5):** Drück überall F5 und sieh CPU, RAM, Grafikkarte und Tokens
  von ZAP, Ollama, LM Studio und SearXNG, und entlade Modelle, die du gerade nicht brauchst.
- **Klügere Modellwahl:** ZAP warnt, wenn ein Modell nicht in deinen Grafikspeicher passt oder
  keine Tools kann, und entlädt unbenutzte Modelle nach einer Zeit, die du festlegst.
- **Schönere Menüs:** Auswahllisten passen jetzt zum Rest von ZAP.

## 0.4.1 – Small Detail Improvements

### English

- **Restart engines:** Ollama and LM Studio can be restarted from Settings → Models, e.g. when
  they hang.
- **Control SearXNG:** start, stop and restart the SearXNG container under Settings → Web search
  ("Start" also opens Docker Desktop when needed).
- **Versions at a glance:** Settings → About now shows the versions of Ollama, LM Studio and
  Docker Desktop, and tells you when an update is out, with a button to open the app.
- **Token counts:** stopped or interrupted answers now count their tokens too.
- **Clearer buttons:** every button reacts visibly when you hover or click it.
- **Fixes:** the settings scrollbar no longer sticks out over the rounded corners, and the
  read-aloud button lines up with the other answer buttons.

### Deutsch

- **Engines neu starten:** Ollama und LM Studio lassen sich unter Einstellungen → Modelle neu
  starten, z. B. wenn sie hängen.
- **SearXNG steuern:** Den SearXNG-Container unter Einstellungen → Websuche starten, stoppen und
  neu starten („Starten“ öffnet bei Bedarf auch Docker Desktop).
- **Versionen auf einen Blick:** Einstellungen → Über ZAP zeigt jetzt die Versionen von Ollama,
  LM Studio und Docker Desktop und sagt dir, wenn es ein Update gibt, mit einem Knopf zum Öffnen
  der App.
- **Token-Zählung:** Gestoppte oder abgebrochene Antworten zählen ihre Tokens jetzt auch.
- **Deutlichere Knöpfe:** Jeder Knopf reagiert sichtbar, wenn du drüberfährst oder klickst.
- **Korrekturen:** Die Scrollleiste in den Einstellungen ragt nicht mehr über die runden Ecken,
  und der Vorlese-Knopf sitzt auf einer Linie mit den anderen Antwort-Knöpfen.

## 0.4.0 – The Voice arrival

### English

- **Dictation:** click or hold the new microphone button and speak; ZAP writes it down. Runs
  entirely on your PC (Whisper), German and English.
- **Read aloud:** a speaker button on every answer, with natural local voices (Piper). Pick your
  voices and speed under Settings → Voice, or let ZAP read new answers automatically.
- **Show in Discord:** "Playing ZAP" with what ZAP is doing right now, never your chats. Turn it
  on under Settings → General.
- **Install engines from ZAP:** Ollama or LM Studio missing? ZAP installs them for you, with
  live progress.
- **Paste a link:** ZAP reads the page so every model can talk about it.
- **Smarter web search:** the model knows today's date, cites its sources and falls back to the
  built-in search when another service is down. If SearXNG isn't running, ZAP asks whether to
  start Docker.
- **Fixes:** Qwen models with web search work again; fewer odd answers from small models.

### Deutsch

- **Diktieren:** Klick oder halte den neuen Mikrofon-Knopf und sprich, ZAP schreibt es auf. Läuft
  komplett auf deinem PC (Whisper), Deutsch und Englisch.
- **Vorlesen:** ein Lautsprecher-Knopf an jeder Antwort, mit natürlichen lokalen Stimmen (Piper).
  Stimmen und Tempo wählst du unter Einstellungen → Sprache & Stimme, oder ZAP liest neue
  Antworten automatisch vor.
- **In Discord anzeigen:** „Spielt ZAP“ mit dem, was ZAP gerade macht, nie deine Chats. Einschalten
  unter Einstellungen → Allgemein.
- **Engines aus ZAP installieren:** Fehlt Ollama oder LM Studio, installiert ZAP es für dich, mit
  Live-Fortschritt.
- **Link einfügen:** ZAP liest die Seite, damit jedes Modell darüber sprechen kann.
- **Klügere Websuche:** Das Modell kennt das heutige Datum, nennt seine Quellen und weicht auf die
  eingebaute Suche aus, wenn ein anderer Dienst nicht geht. Läuft SearXNG nicht, fragt ZAP, ob es
  Docker starten soll.
- **Korrekturen:** Qwen-Modelle mit Websuche funktionieren wieder; weniger seltsame Antworten
  kleiner Modelle.

## 0.3.1 – Fancyness Update

### English

- **Color themes:** 8 ready-made themes (e.g. Midnight, Forest, Ember) or your own colors
  with a color picker, each in dark and light. Settings → Appearance.
- **More control over text:** font, size (12–24 px), line, letter and paragraph spacing.
- **Blueprints:** the suggestions in a new chat are now yours. Up to 6 cards with title,
  text and icon, optionally sent right away. Settings → Chat.
- **Chat groups:** sort chats into folders (drag & drop or the "…" menu), collapse them and
  give them a color.
- **What's new:** ZAP now shows these notes before and after an update.

### Deutsch

- **Farbschemata:** 8 fertige Themes (z. B. Mitternacht, Wald, Glut) oder eigene Farben mit
  Farbwähler, jeweils in Dunkel und Hell. Einstellungen → Darstellung.
- **Mehr Kontrolle über Text:** Schriftart, Größe (12–24 px), Zeilen-, Buchstaben- und
  Absatzabstand.
- **Blueprints:** Die Vorschläge im neuen Chat sind jetzt deine eigenen. Bis zu 6 Karten mit
  Titel, Text und Symbol, auf Wunsch sofort gesendet. Einstellungen → Chat.
- **Chat-Gruppen:** Chats in Ordner sortieren (per Drag & Drop oder über das „…"-Menü),
  einklappen und farbig markieren.
- **Was ist neu:** ZAP zeigt diese Hinweise jetzt vor und nach einem Update.

## 0.3.0

### English

- First public release, with automatic updates.

### Deutsch

- Erste öffentliche Version, mit automatischen Updates.
