# ZAP – Design System

ZAP is a fast, friendly, local-first AI chat app for Windows. The look is energetic and sporty: deep court-blue backgrounds, crisp white type, glassy cards, and one hot coral accent. Think "sports brand meets modern AI chat" – bold, airy, fast.

Reference mood: large light-weight headlines, translucent glass cards, motion-blur energy, speed lines in coral.

---

## 1. Brand

- **Name:** ZAP (always uppercase in the logo, "ZAP" in UI text)
- **Personality:** quick, confident, friendly, no corporate stiffness
- **Tone of voice:** short sentences, active verbs, informal German ("du"). No jargon.
- **Logo:** wordmark "ZAP" in Inter Semibold, tracking +4%, with a small coral lightning-bolt glyph. Monochrome white version on blue backgrounds.
- **UI language:** German. Code, tokens and comments in English.

---

## 2. Color

Three core colors. Everything else is a tint, shade or opacity of these.

| Role | Name | Hex | Share |
|---|---|---|---|
| Background | Azure Navy | `#3283BE` | ~60 % |
| Text & surfaces | Snowy White | `#FEFDFE` | ~30 % |
| Accent | Coral Red | `#FD614B` | ~10 % |

### 2.1 Tokens

```css
:root {
  /* Core */
  --azure: #3283BE;
  --snow: #FEFDFE;
  --coral: #FD614B;

  /* Derived blues (depth) */
  --azure-700: #1F5F94;   /* panels, sidebar */
  --azure-800: #17487A;   /* gradient end, pressed */
  --azure-900: #0F3157;   /* deepest, text-on-light */
  --azure-300: #7DB4DD;   /* subtle lines, icons */

  /* Ink for text on coral / light surfaces (AA-safe) */
  --ink: #0B2540;

  /* Derived coral */
  --coral-600: #E84A34;   /* hover */
  --coral-700: #C93A27;   /* pressed */
  --coral-glow: rgba(253, 97, 75, 0.45);

  /* Semantic: DARK is the default theme */
  color-scheme: dark;
  --bg: #0A1F36;
  --bg-gradient: radial-gradient(ellipse 100% 70% at 50% 0%, #17487A 0%, #0F3157 45%, #0A1F36 100%);
  --surface-sidebar: rgba(15, 49, 87, 0.55);
  --surface-1: rgba(254, 253, 254, 0.05);   /* cards, composer */
  --surface-2: rgba(254, 253, 254, 0.09);   /* hover, user bubble */
  --surface-3: rgba(254, 253, 254, 0.14);   /* active, pressed */
  --border: rgba(254, 253, 254, 0.12);
  --border-strong: rgba(254, 253, 254, 0.24);
  --fg: var(--snow);
  --fg-muted: rgba(254, 253, 254, 0.72);
  --fg-subtle: rgba(254, 253, 254, 0.50);
  --dot: rgba(254, 253, 254, 0.16);          /* dot-grid color */
  --accent: var(--coral);
  --accent-hover: var(--coral-600);
  --accent-pressed: var(--coral-700);
  --on-accent: var(--ink);
  --selection: rgba(50, 131, 190, 0.45);     /* text selection, focus fills */

  /* Glass */
  --glass: rgba(254, 253, 254, 0.08);
  --glass-strong: rgba(254, 253, 254, 0.14);
  --glass-border: rgba(254, 253, 254, 0.22);
  --glass-blur: 18px;

  /* Status */
  --success: #4ADE80;
  --warning: #FBBF24;
  --danger: #FF8A7A;       /* lighter coral, never the accent itself */
}
```

### 2.2 Themes

Three modes: **Dark (default)**, **Light**, **System** (follows Windows). Set via `data-theme="dark|light"` on `<html>`; the first launch uses Dark regardless of the OS unless the user picks System. Persist the choice.

```css
[data-theme="light"] {
  color-scheme: light;
  --bg: #F3F8FC;
  --bg-gradient: radial-gradient(ellipse 100% 70% at 50% 0%, #DCEBF7 0%, #F3F8FC 60%, #FEFDFE 100%);
  --surface-sidebar: rgba(254, 253, 254, 0.7);
  --surface-1: rgba(11, 37, 64, 0.04);
  --surface-2: rgba(11, 37, 64, 0.07);
  --surface-3: rgba(11, 37, 64, 0.11);
  --border: rgba(11, 37, 64, 0.12);
  --border-strong: rgba(11, 37, 64, 0.24);
  --fg: var(--ink);
  --fg-muted: rgba(11, 37, 64, 0.72);
  --fg-subtle: rgba(11, 37, 64, 0.52);
  --dot: rgba(11, 37, 64, 0.10);
  --selection: rgba(50, 131, 190, 0.30);
  --glass: rgba(254, 253, 254, 0.70);
  --glass-strong: rgba(254, 253, 254, 0.90);
  --glass-border: rgba(11, 37, 64, 0.12);
}
```

Rules for both themes:
- The **dot grid** (`radial-gradient(var(--dot) 1.1px, transparent 1.3px)` at 8 px, faded with a radial mask) is the signature background texture: used in the empty state and as a very subtle layer on the main background. Never behind long text; keep it under 12 % visibility in the message area.
- **Coral** stays the only hot color in both themes. In Dark it may also be used for small text links (contrast ≈ 5.5:1 on `--bg`); in Light use `--coral-700` for text links.
- **Azure** is the brand tint: selection, focus fills, gradient glow at the top of the window, hover tints. It is not used for large flat panels in Dark.
- Switching theme animates `background-color`/`color` over 200 ms; no flash on startup (set `data-theme` before first paint).

### 2.3 Usage rules

**Azure Navy (background)**
- Marketing / logo surfaces use the bright `--azure` gradient (`#3283BE` → `#17487A`).
- In the app, the background is `--bg-gradient` of the active theme (deep navy in Dark), never a flat fill only.
- Never used as text color on white surfaces; use `--azure-900` there.

**Snowy White (text, structure)**
- All text on blue is white or white at reduced opacity (`--fg`, `--fg-muted`, `--fg-subtle`).
- Glass cards, borders, dividers, icons.

**Coral Red (accent, max ~10 % of any screen)**
- Primary button (Send, "Modell laden"), focus ring highlights, active-state indicators, speed-line decorations, progress bars, the lightning glyph.
- Exactly one coral primary action per view.
- Never for body text, large surfaces or error states.

### 2.4 Contrast (WCAG AA)

- White on `--azure` is ~4.1:1: fine for large text (≥ 18 px, or ≥ 14 px bold), **not** for small body text. Place small text on `--azure-700` or darker, or on `--glass-strong` over the gradient's darker area.
- White on coral is only ~3:1: **button labels on coral use `--ink`** (≈ 5:1), semibold 15–16 px.
- Always test new combinations; minimum 4.5:1 for body text, 3:1 for large text and UI icons.

---

## 3. Typography

- **Font:** Inter (variable). Fallback: `system-ui, "Segoe UI", sans-serif`.
- **Mono (code):** JetBrains Mono, fallback `Cascadia Code, Consolas, monospace`.
- Headlines are light (300–400), tight tracking; UI labels and buttons are medium/semibold.

| Style | Size / Line | Weight | Tracking | Use |
|---|---|---|---|---|
| Display | 64 / 64 px | 300 | -3 % | Empty-state hero ("Los geht's.") |
| H1 | 32 / 38 px | 400 | -2 % | Screen titles |
| H2 | 22 / 28 px | 500 | -1 % | Section titles, modal titles |
| Body | 16 / 26 px | 400 | 0 | Chat messages |
| UI | 14 / 20 px | 500 | 0 | Buttons, menus, labels |
| Caption | 12 / 16 px | 400 | +1 % | Timestamps, hints |
| Code | 14 / 22 px | 400 | 0 | Code blocks, inline code |

Large display words may be uppercase (e.g. "ZAP", "LOS GEHT'S"); body text never.

---

## 4. Spacing, Radius, Elevation

- **Spacing scale (px):** 4, 8, 12, 16, 24, 32, 48, 64. Base unit 4.
- **Radius:** `--r-sm: 8px` (chips, inputs inner), `--r-md: 14px` (buttons, inputs), `--r-lg: 22px` (cards, message bubbles), `--r-xl: 28px` (modals, composer), `--r-full: 999px` (pills, avatars).
- **Elevation:** glass + soft shadow, no hard borders.
  - `--shadow-card: 0 8px 32px rgba(8, 30, 60, 0.28)`
  - `--shadow-pop: 0 16px 48px rgba(8, 30, 60, 0.40)`
  - `--shadow-coral: 0 0 24px var(--coral-glow)` (only on the primary button hover/active)

### Glass recipe

```css
.glass {
  background: var(--glass);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(var(--glass-blur)) saturate(140%);
  box-shadow: var(--shadow-card);
  border-radius: var(--r-lg);
}
```

---

## 5. Layout

```
┌──────────────┬────────────────────────────────────────────┐
│ Sidebar      │  Top bar: [Model ▾]            [Settings]  │
│ (280 px)     ├────────────────────────────────────────────┤
│ ⚡ ZAP       │                                            │
│ [+ Neuer     │   Message list (max-width 760 px, centered)│
│    Chat]     │                                            │
│ Search       │                                            │
│ ─────────    ├────────────────────────────────────────────┤
│ Chat list    │   Composer (glass, rounded-xl) [Senden ⚡] │
│ ...          │   Hint: "Enter senden · Shift+Enter Zeile" │
│ ─────────    │                                            │
│ Ollama: ● an │                                            │
└──────────────┴────────────────────────────────────────────┘
```

- Window min size: 900 × 600. Sidebar collapsible below 1000 px.
- Content column `max-width: 760px`, centered, 24 px side padding.
- Sidebar uses `--azure-700` at 70 % opacity + blur over the gradient.

---

## 6. Components

### 6.1 Buttons
- **Primary (coral):** bg `--coral`, text `--ink`, radius `--r-md`, height 44, padding 0 20, UI semibold. Trailing "↗" or ⚡ icon allowed. Hover `--coral-600` + `--shadow-coral`; pressed `--coral-700`, scale 0.98.
- **Secondary (glass):** `--glass-strong` bg, white text, glass border. Hover: opacity up.
- **Ghost:** transparent, white text, hover `--glass`.
- **Icon button:** 36 × 36, radius `--r-sm`, ghost style.
- Disabled: 40 % opacity, no hover effects.

### 6.2 Composer (message input)
- Glass container, radius `--r-xl`, auto-growing textarea (1–8 lines), white text, placeholder `--fg-subtle`: "Schreib etwas …".
- Send button (coral, icon ⚡/arrow) docked bottom-right. While generating it turns into a **Stop** button (glass, square icon).
- Focus: 2 px ring `--coral` at 60 % opacity + glow.
- Enter sends, Shift+Enter newline, Esc stops generation.

### 6.3 Messages
- **User:** right-aligned, `--glass-strong` bubble, radius `--r-lg` (tail corner `--r-sm`), max width 80 %.
- **Assistant:** left-aligned, **no bubble**, plain white text on the background, small ZAP bolt avatar (24 px, coral glyph on glass circle).
- Markdown: headings, lists, tables (glass rows), blockquote with coral 3 px left rule, links underlined white with coral underline on hover.
- **Code blocks:** `--azure-900` bg at 80 %, radius `--r-md`, header bar with language + "Kopieren" ghost button, syntax theme with white/azure-300 base and coral only for keywords.
- Streaming: soft blinking coral caret at end of text.
- Message actions (hover): copy, regenerate, delete – ghost icon buttons.

### 6.4 Sidebar
- Logo row (⚡ ZAP), "Neuer Chat" primary button full width.
- Chat items: 44 px height, radius `--r-md`, truncated title, hover `--glass`, active `--glass-strong` + 3 px coral left indicator.
- Context menu: umbenennen, löschen.
- Footer: Ollama status pill.

### 6.5 Model selector
- Pill in the top bar: "llama3.2:3b ▾". Opens a glass popover (`--shadow-pop`).
- List rows: model name, size (e.g. "2.0 GB"), installed check. Not-installed models show "Laden" (secondary button).
- Bottom row: "Weitere Modelle laden …" opens the download dialog.

### 6.6 Download progress
- Row with model name, thin 6 px bar (track `--glass`, fill `--coral` with subtle shimmer), percentage + MB/s in Caption, cancel icon.

### 6.7 Status pill (Ollama)
- "● Ollama läuft" (dot `--success`), "● Startet …" (dot `--warning`, pulsing), "● Nicht gefunden" (dot `--danger`) with "Installieren" link.

### 6.8 Dialogs & toasts
- Modal: glass, radius `--r-xl`, scrim `rgba(8, 30, 60, 0.55)` + blur 6 px, enter with scale 0.96 → 1 and fade.
- Toasts: bottom-center glass pill, 4 s, one line.

### 6.9 Empty state
- Display text "Los geht's." (Display style, light), subline "Frag mich irgendwas. Läuft komplett auf deinem PC." (Body, `--fg-muted`).
- Three suggestion cards (glass, 3 columns): e.g. "Erkläre mir …", "Schreib eine E-Mail …", "Hilf mir beim Code …". Hover: lift 2 px, border brightens.
- Behind the hero: the dot grid, faded with a radial mask, and above the display text the **ZAP bolt built from coral dots** (the only coral element besides the send button). Decorative parts are `aria-hidden`.

---

## 7. Motion

- **Easing:** `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-expo-ish) for entrances; `cubic-bezier(0.4, 0, 0.2, 1)` for state changes.
- **Durations:** hover/press 120 ms, popovers/menus 180 ms, modals/page 260 ms, message appear 220 ms (fade + 8 px rise).
- Speed-line shimmer on the progress bar: 1.2 s linear loop.
- Typing indicator: three dots, staggered 120 ms.
- Respect `prefers-reduced-motion`: disable translate/scale and shimmer, keep fades ≤ 100 ms.

---

## 8. Iconography

- Lucide icons, 20 px default (16 px in dense rows), stroke 1.75, color `currentColor`.
- Brand glyph: lightning bolt, filled coral, used only for logo, assistant avatar and send button.

---

## 9. States & copy (German)

| Situation | Copy |
|---|---|
| Placeholder | "Schreib etwas …" |
| Generating | "ZAP denkt nach …" |
| Ollama missing | "Ollama wurde nicht gefunden. Installiere es, damit ZAP lokal antworten kann." |
| Ollama starting | "Ollama wird gestartet …" |
| No model installed | "Noch kein Modell geladen. Wähle eins, um loszulegen." |
| Download failed | "Download fehlgeschlagen. Prüfe deine Verbindung und versuch's nochmal." |
| Generic error | "Das hat nicht geklappt. Versuch's nochmal." |
| Delete confirm | "Diesen Chat löschen? Das lässt sich nicht rückgängig machen." |

Errors are shown inline in the chat (glass card with `--danger` icon) plus a "Nochmal versuchen" secondary button. Never blame the user, never show raw stack traces.

---

## 10. Accessibility

- All interactive elements keyboard reachable; visible focus ring (2 px `--coral` at 60 %, 2 px offset).
- Min click target 36 × 36 px.
- Contrast rules from section 2.4, verified in both Dark and Light.
- Message list is an `aria-live="polite"` region; the stop/send button has an `aria-label`.
- Do not rely on color alone for status: pair color with text or icon.

---

## 11. Do / Don't

**Do**
- Keep screens airy; let the gradient breathe.
- Use one coral primary action per view.
- Use glass for floating or secondary surfaces only.

**Don't**
- Don't add new hues (green/purple/etc.) beyond semantic status colors.
- Don't use coral for large areas, body text or errors.
- Don't use hard 1 px opaque borders or heavy drop shadows.
- Don't put small white text directly on the plain `--azure` mid-tone.
