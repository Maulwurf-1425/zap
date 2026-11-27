//! Controlling other apps for ZAPs: list windows, read a window's buttons
//! and fields, click, type and press keys. Uses Windows UI Automation (what
//! screen readers use) through PowerShell, so ZAP works with named controls
//! instead of guessing screen coordinates.
//!
//! Reading needs no OK; clicking, typing and keys go through the same
//! approval as PowerShell commands.

use std::time::Duration;

use serde_json::{json, Value};

use crate::provider::{ToolCall, ToolSpec};
use crate::state::AppState;
use crate::system_tools::{self, truncate_output};
use crate::tools::{ToolActivity, ToolCtx};

pub const WINDOWS: &str = "ui_windows";
pub const READ: &str = "ui_read";
pub const CLICK: &str = "ui_click";
pub const TYPE: &str = "ui_type";
pub const KEYS: &str = "ui_keys";
pub const NAMES: &[&str] = &[WINDOWS, READ, CLICK, TYPE, KEYS];

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_CHARS: usize = 8_000;

pub fn tool_specs() -> Vec<ToolSpec> {
    let window = json!({ "type": "string", "description": "Window title (or part of it), or a handle from ui_windows" });
    vec![
        ToolSpec {
            name: WINDOWS,
            description: "List the open windows (title, app, handle).",
            parameters: json!({ "type": "object", "properties": {} }),
        },
        ToolSpec {
            name: READ,
            description: "Read a window: its buttons, fields, menus, list items and texts with their names. Call this before clicking or typing.",
            parameters: json!({
                "type": "object",
                "properties": { "window": window },
                "required": ["window"]
            }),
        },
        ToolSpec {
            name: CLICK,
            description: "Click a control (button, menu item, list item, link, checkbox) in a window, by its name or id from ui_read.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "window": window,
                    "element": { "type": "string", "description": "Name or automation id of the control, as shown by ui_read" }
                },
                "required": ["window", "element"]
            }),
        },
        ToolSpec {
            name: TYPE,
            description: "Type text into a window: into the named field if given, otherwise where the cursor is.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "window": window,
                    "text": { "type": "string", "description": "The text to type" },
                    "element": { "type": "string", "description": "Optional: name or id of the input field" }
                },
                "required": ["window", "text"]
            }),
        },
        ToolSpec {
            name: KEYS,
            description: "Press keys or a shortcut in a window, e.g. \"enter\", \"ctrl+s\", \"alt+f4\", \"tab tab enter\" (several separated by spaces).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "window": window,
                    "keys": { "type": "string", "description": "Keys like enter, tab, esc, ctrl+s, ctrl+shift+n, f5, up, down" }
                },
                "required": ["window", "keys"]
            }),
        },
    ]
}

pub fn system_prompt() -> String {
    "The ui_ tools control other apps. Work like this: open the app (open_app) if needed, then ui_read the \
window to see its controls, then ui_click / ui_type / ui_keys by the names ui_read showed. Read again after \
each change of screen. Prefer keyboard shortcuts for menus (ui_keys). Never type passwords or confirm \
purchases, deletions or messages to other people unless the task clearly says so."
        .into()
}

/// "ctrl+shift+s tab enter" → SendKeys syntax ("^+s{TAB}{ENTER}").
pub fn to_sendkeys(keys: &str) -> Option<String> {
    let mut out = String::new();
    for combo in keys.split_whitespace() {
        let parts: Vec<String> = combo.split('+').map(|p| p.trim().to_lowercase()).collect();
        let (key, mods) = parts.split_last()?;
        for m in mods {
            out.push_str(match m.as_str() {
                "ctrl" | "control" | "strg" => "^",
                "shift" | "umschalt" => "+",
                "alt" => "%",
                _ => return None,
            });
        }
        let named = match key.as_str() {
            "enter" | "return" => "{ENTER}",
            "tab" => "{TAB}",
            "esc" | "escape" => "{ESC}",
            "backspace" => "{BACKSPACE}",
            "delete" | "del" | "entf" => "{DELETE}",
            "insert" | "ins" => "{INSERT}",
            "up" => "{UP}",
            "down" => "{DOWN}",
            "left" => "{LEFT}",
            "right" => "{RIGHT}",
            "home" | "pos1" => "{HOME}",
            "end" => "{END}",
            "pageup" | "pgup" => "{PGUP}",
            "pagedown" | "pgdn" => "{PGDN}",
            "space" => " ",
            k if k.len() > 1
                && k.starts_with('f')
                && k[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) =>
            {
                out.push_str(&format!("{{{}}}", k.to_uppercase()));
                continue;
            }
            k if k.chars().count() == 1 => {
                let c = k.chars().next()?;
                // Characters SendKeys treats specially go in braces.
                if "+^%~(){}[]".contains(c) {
                    out.push_str(&format!("{{{c}}}"));
                } else {
                    out.push(c);
                }
                continue;
            }
            _ => return None,
        };
        out.push_str(named);
    }
    (!out.is_empty()).then_some(out)
}

/// Escapes text for SendKeys (each special character in braces).
fn sendkeys_text(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '+' | '^' | '%' | '~' | '(' | ')' | '{' | '}' | '[' | ']' => format!("{{{c}}}"),
            '\n' => "{ENTER}".into(),
            c => c.to_string(),
        })
        .collect()
}

/// Shared PowerShell helpers: assemblies, finding windows and controls.
const PS_PRELUDE: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, Microsoft.VisualBasic
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$All = [System.Windows.Automation.Condition]::TrueCondition
function Get-Windows {
  $AE::RootElement.FindAll($TS::Children, $All) | Where-Object { $_.Current.Name -and -not $_.Current.IsOffscreen }
}
function Find-Window([string]$q) {
  $wins = @(Get-Windows)
  if ($q -match '^\d+$') { $w = $wins | Where-Object { $_.Current.NativeWindowHandle -eq [int]$q } | Select-Object -First 1; if ($w) { return $w } }
  $w = $wins | Where-Object { $_.Current.Name -eq $q } | Select-Object -First 1
  if (-not $w) { $w = $wins | Where-Object { $_.Current.Name -like "*$q*" } | Select-Object -First 1 }
  if (-not $w) { throw "window_not_found" }
  return $w
}
function Focus-Window($w) {
  try { [Microsoft.VisualBasic.Interaction]::AppActivate([int]$w.Current.ProcessId) } catch {}
  try { $w.SetFocus() } catch {}
  Start-Sleep -Milliseconds 250
}
function Find-Element($w, [string]$q) {
  $all = $w.FindAll($TS::Descendants, $All)
  $hit = $all | Where-Object { $_.Current.AutomationId -eq $q -or $_.Current.Name -eq $q } | Where-Object { $_.Current.IsEnabled } | Select-Object -First 1
  if (-not $hit) { $hit = $all | Where-Object { $_.Current.Name -like "*$q*" -and $_.Current.IsEnabled } | Select-Object -First 1 }
  if (-not $hit) { throw "element_not_found" }
  return $hit
}
"#;

fn script(body: &str, args: &Value) -> String {
    // Arguments travel as JSON in a single-quoted string: no injection.
    let json = args.to_string().replace('\'', "''");
    format!("{PS_PRELUDE}\n$A = ConvertFrom-Json '{json}'\n{body}")
}

const PS_WINDOWS: &str = r#"
Get-Windows | ForEach-Object {
  $p = try { (Get-Process -Id $_.Current.ProcessId).ProcessName } catch { '' }
  "{0} | {1} | handle {2}" -f $_.Current.Name, $p, $_.Current.NativeWindowHandle
}
"#;

const PS_READ: &str = r#"
$w = Find-Window $A.window
"Window: " + $w.Current.Name
$types = 'Button','Edit','MenuItem','ListItem','TabItem','CheckBox','RadioButton','ComboBox','Hyperlink','Document','Text','TreeItem','DataItem','MenuBar','SplitButton','Pane'
$n = 0
foreach ($e in $w.FindAll($TS::Descendants, $All)) {
  $c = $e.Current
  $type = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
  if ($types -notcontains $type) { continue }
  if (-not $c.Name -and -not $c.AutomationId) { continue }
  # Older apps (Windows Forms) show controls as named panes; skip unnamed containers.
  if ($type -eq 'Pane' -and -not $c.Name) { continue }
  if ($c.IsOffscreen) { continue }
  $value = ''
  try { $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $value = $vp.Current.Value } catch {}
  if ($value.Length -gt 80) { $value = $value.Substring(0, 80) + '…' }
  $line = "- $type `"$($c.Name)`""
  if ($c.AutomationId) { $line += " id=$($c.AutomationId)" }
  if (-not $c.IsEnabled) { $line += ' (disabled)' }
  if ($value) { $line += " value=`"$value`"" }
  $line
  $n++
  if ($n -ge 150) { '… (more controls not shown)'; break }
}
"#;

const PS_CLICK: &str = r#"
$w = Find-Window $A.window
Focus-Window $w
$e = Find-Element $w $A.element
$done = $false
foreach ($pat in @([System.Windows.Automation.InvokePattern]::Pattern, [System.Windows.Automation.TogglePattern]::Pattern, [System.Windows.Automation.SelectionItemPattern]::Pattern, [System.Windows.Automation.ExpandCollapsePattern]::Pattern)) {
  try {
    $p = $e.GetCurrentPattern($pat)
    switch ($pat.ProgrammaticName) {
      'InvokePatternIdentifiers.Pattern' { $p.Invoke() }
      'TogglePatternIdentifiers.Pattern' { $p.Toggle() }
      'SelectionItemPatternIdentifiers.Pattern' { $p.Select() }
      'ExpandCollapsePatternIdentifiers.Pattern' { $p.Expand() }
    }
    $done = $true; break
  } catch {}
}
if (-not $done) {
  Add-Type -Namespace Zap -Name Mouse -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e);'
  # Real pixels, also on scaled displays.
  [Zap.Mouse]::SetProcessDPIAware() | Out-Null
  $r = $e.Current.BoundingRectangle
  if ($r.IsEmpty) { throw 'not_clickable' }
  [Zap.Mouse]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) | Out-Null
  [Zap.Mouse]::mouse_event(2, 0, 0, 0, [System.UIntPtr]::Zero); [Zap.Mouse]::mouse_event(4, 0, 0, 0, [System.UIntPtr]::Zero)
}
Start-Sleep -Milliseconds 400
"Clicked: " + $e.Current.Name
"#;

const PS_TYPE: &str = r#"
$w = Find-Window $A.window
Focus-Window $w
if ($A.element) {
  $e = Find-Element $w $A.element
  $set = $false
  try { $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); if (-not $vp.Current.IsReadOnly) { $vp.SetValue($A.text); $set = $true } } catch {}
  if (-not $set) { $e.SetFocus(); Start-Sleep -Milliseconds 150; [System.Windows.Forms.SendKeys]::SendWait($A.keys) }
} else {
  [System.Windows.Forms.SendKeys]::SendWait($A.keys)
}
Start-Sleep -Milliseconds 300
"Typed into: " + $w.Current.Name
"#;

const PS_KEYS: &str = r#"
$w = Find-Window $A.window
Focus-Window $w
[System.Windows.Forms.SendKeys]::SendWait($A.keys)
Start-Sleep -Milliseconds 400
"Pressed keys in: " + $w.Current.Name
"#;

/// Runs a UI script; returns (ok, text for the model).
async fn run_script(ctx: &ToolCtx<'_>, body: &str, args: &Value) -> (bool, String) {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("C:\\"));
    match system_tools::run_powershell(&script(body, args), &home, TIMEOUT, ctx.cancel).await {
        Ok(r) if r.timed_out => (false, "Error: the app did not respond in time.".into()),
        Ok(r) => {
            let out = r.output.trim();
            if r.exit_code == Some(0) {
                (true, truncate_output(out, MAX_OUTPUT_CHARS))
            } else if out.contains("window_not_found") {
                (
                    false,
                    "Error: no such window. Use ui_windows to see the open windows.".into(),
                )
            } else if out.contains("element_not_found") {
                (
                    false,
                    "Error: no such control in that window. Use ui_read to see its controls."
                        .into(),
                )
            } else {
                (false, format!("Error: {}", truncate_output(out, 600)))
            }
        }
        Err(e) if e == "cancelled" => (false, "Error: cancelled.".into()),
        Err(_) => (false, "Error: PowerShell could not be started.".into()),
    }
}

pub async fn run(
    state: &AppState,
    ctx: &ToolCtx<'_>,
    call: &ToolCall,
    mut activity: ToolActivity,
) -> (ToolActivity, String) {
    let args = &call.arguments;
    let window = args["window"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    let (body, script_args, needs_ok) = match call.name.as_str() {
        WINDOWS => (PS_WINDOWS, json!({}), false),
        READ => (PS_READ, json!({ "window": window }), false),
        CLICK => {
            let element = args["element"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            activity.preview = Some(format!("{window} → {element}"));
            (
                PS_CLICK,
                json!({ "window": window, "element": element }),
                true,
            )
        }
        TYPE => {
            let text = args["text"].as_str().unwrap_or_default().to_string();
            let element = args["element"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            activity.preview = Some(format!(
                "{window}{}\n\n{text}",
                if element.is_empty() {
                    String::new()
                } else {
                    format!(" → {element}")
                }
            ));
            (
                PS_TYPE,
                json!({ "window": window, "element": element, "text": text, "keys": sendkeys_text(&text) }),
                true,
            )
        }
        KEYS => {
            let keys = args["keys"].as_str().unwrap_or_default().trim().to_string();
            let Some(sendkeys) = to_sendkeys(&keys) else {
                return (activity.failed("failed"), format!("Error: unknown keys \"{keys}\". Use names like enter, tab, ctrl+s, alt+f4."));
            };
            activity.preview = Some(format!("{window} ⌨ {keys}"));
            (PS_KEYS, json!({ "window": window, "keys": sendkeys }), true)
        }
        other => {
            return (
                activity.failed("unknown_tool"),
                format!("Error: unknown tool \"{other}\"."),
            )
        }
    };
    if call.name != WINDOWS && window.is_empty() {
        return (activity.failed("failed"), "Error: missing window.".into());
    }
    activity.input = window.clone();
    if needs_ok && !system_tools::approve(state, ctx, &mut activity, false).await {
        activity.status = "denied".into();
        return (activity, "The user did not allow this step. Don't retry it; continue without it or explain what you need.".into());
    }
    ctx.emit(&activity);
    let (ok, text) = run_script(ctx, body, &script_args).await;
    if ok {
        if call.name == READ || call.name == WINDOWS {
            activity.preview = Some(text.clone());
        }
        (activity.done(Vec::new()), text)
    } else {
        (activity.failed("ui_failed"), text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_names_become_sendkeys() {
        assert_eq!(to_sendkeys("ctrl+s").as_deref(), Some("^s"));
        assert_eq!(to_sendkeys("ctrl+shift+n").as_deref(), Some("^+n"));
        assert_eq!(to_sendkeys("alt+f4").as_deref(), Some("%{F4}"));
        assert_eq!(
            to_sendkeys("tab tab enter").as_deref(),
            Some("{TAB}{TAB}{ENTER}")
        );
        assert_eq!(to_sendkeys("Strg+A").as_deref(), Some("^a"));
        assert_eq!(to_sendkeys("ctrl++").as_deref(), None);
        assert_eq!(to_sendkeys("hyper+x"), None);
        assert_eq!(to_sendkeys(""), None);
    }

    #[test]
    fn text_is_escaped_for_sendkeys() {
        assert_eq!(sendkeys_text("1+1=2 (ok)"), "1{+}1=2 {(}ok{)}");
        assert_eq!(sendkeys_text("a\nb"), "a{ENTER}b");
    }

    #[test]
    fn arguments_cannot_break_out_of_the_script() {
        let s = script("", &json!({ "window": "x'; Remove-Item C:\\ -Recurse; '" }));
        assert!(s.contains("'{\"window\":\"x''; Remove-Item"));
    }

    // Live check against a small test window (text field, button, label):
    // `cargo test live_ui_control -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_ui_control() {
        use tokio_util::sync::CancellationToken;
        const FORM: &str = "Add-Type -AssemblyName PresentationFramework; $x = [Windows.Markup.XamlReader]::Parse('<Window xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" Title=\"ZAP UI Test\" Width=\"420\" Height=\"220\"><StackPanel Margin=\"10\"><TextBox Name=\"input\" AutomationProperties.Name=\"Input\" Width=\"250\" HorizontalAlignment=\"Left\"/><Button Name=\"btn\" Content=\"Press me\" Width=\"120\" Margin=\"0,10\" HorizontalAlignment=\"Left\"/><TextBlock Name=\"result\" Text=\"waiting\"/></StackPanel></Window>'); $t = $x.FindName('input'); $r = $x.FindName('result'); $x.FindName('btn').Add_Click({ $r.Text = 'clicked: ' + $t.Text }); [void]$x.ShowDialog()";
        let mut form = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", FORM])
            .spawn()
            .unwrap();
        let cancel = CancellationToken::new();
        let home = dirs::home_dir().unwrap();
        let run = |body: &'static str, args: Value| {
            let cancel = cancel.clone();
            let home = home.clone();
            async move {
                let r = system_tools::run_powershell(&script(body, &args), &home, TIMEOUT, &cancel)
                    .await
                    .unwrap();
                println!(
                    "--- exit {:?}
{}",
                    r.exit_code,
                    truncate_output(&r.output, 1500)
                );
                r
            }
        };
        let win = json!({ "window": "ZAP UI Test" });
        let mut found = false;
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if run(READ_PROBE, win.clone()).await.exit_code == Some(0) {
                found = true;
                break;
            }
        }
        assert!(found, "test window should open");
        assert_eq!(run(PS_READ, win.clone()).await.exit_code, Some(0));
        let text = "Hello (1+1)";
        let typed = run(
            PS_TYPE,
            json!({ "window": "ZAP UI Test", "element": "Input", "text": text, "keys": sendkeys_text(text) }),
        )
        .await;
        assert_eq!(typed.exit_code, Some(0));
        let clicked = run(
            PS_CLICK,
            json!({ "window": "ZAP UI Test", "element": "Press me" }),
        )
        .await;
        assert_eq!(clicked.exit_code, Some(0));
        let after = run(PS_READ, win.clone()).await;
        assert!(
            after.output.contains("clicked: Hello (1+1)"),
            "the click should show the typed text"
        );
        run(
            PS_KEYS,
            json!({ "window": "ZAP UI Test", "keys": to_sendkeys("alt+f4").unwrap() }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(800)).await;
        let _ = form.kill();
        let _ = form.wait();
    }

    /// Succeeds once the window exists.
    const READ_PROBE: &str = "$null = Find-Window $A.window";
}
