//! Starts scheduled ZAPs: on app start, every N minutes, or daily at a time
//! (optionally only on some weekdays). A daily slot missed while ZAP was
//! closed runs once when ZAP is back. Changing a ZAP restarts its schedule,
//! so a new 08:00 schedule saved at 10:00 first runs tomorrow.

use std::time::Duration;

use chrono::{DateTime, Datelike, Days, Local, NaiveTime, TimeZone};
use tauri::{AppHandle, Manager};

use crate::db::{self, Zap, ZapSchedule};
use crate::engine;
use crate::provider::{parse_model_key, ProviderStatus};
use crate::state::AppState;
use crate::zaps;

const TICK: Duration = Duration::from_secs(30);
/// Engines need a moment after ZAP starts.
const STARTUP_DELAY: Duration = Duration::from_secs(10);
/// How long "on app start" ZAPs wait for their engine.
const STARTUP_WAIT: Duration = Duration::from_secs(180);

fn slot_on(s: &ZapSchedule, date: chrono::NaiveDate, time: NaiveTime) -> Option<DateTime<Local>> {
    let weekday = date.weekday().num_days_from_monday() as u8;
    if !s.days.is_empty() && !s.days.contains(&weekday) {
        return None;
    }
    // Skipped when the time doesn't exist that day (DST change).
    Local.from_local_datetime(&date.and_time(time)).earliest()
}

/// Latest daily slot at or before `now`.
fn last_slot(s: &ZapSchedule, now: DateTime<Local>) -> Option<DateTime<Local>> {
    let time = NaiveTime::parse_from_str(&s.time, "%H:%M").ok()?;
    (0..8)
        .filter_map(|back| now.date_naive().checked_sub_days(Days::new(back)))
        .filter_map(|date| slot_on(s, date, time))
        .find(|at| *at <= now)
}

/// First daily slot after `now`.
fn next_slot(s: &ZapSchedule, now: DateTime<Local>) -> Option<DateTime<Local>> {
    let time = NaiveTime::parse_from_str(&s.time, "%H:%M").ok()?;
    (0..9)
        .filter_map(|ahead| now.date_naive().checked_add_days(Days::new(ahead)))
        .filter_map(|date| slot_on(s, date, time))
        .find(|at| *at > now)
}

/// Whether a ZAP should start now. `anchor` is when the schedule was last
/// changed, `last` the start of its latest scheduled run (Unix ms).
pub fn is_due(s: &ZapSchedule, anchor: i64, last: Option<i64>, now: DateTime<Local>) -> bool {
    let base = last.unwrap_or(0).max(anchor);
    match s.kind.as_str() {
        "interval" => {
            s.every_min > 0 && now.timestamp_millis() - base >= i64::from(s.every_min) * 60_000
        }
        "daily" => last_slot(s, now).is_some_and(|slot| slot.timestamp_millis() > base),
        _ => false,
    }
}

/// When the ZAP will start next (Unix ms); `None` when it has no timed schedule.
pub fn next_run(
    s: &ZapSchedule,
    anchor: i64,
    last: Option<i64>,
    now: DateTime<Local>,
) -> Option<i64> {
    if is_due(s, anchor, last, now) {
        return Some(now.timestamp_millis());
    }
    match s.kind.as_str() {
        "interval" if s.every_min > 0 => {
            Some(last.unwrap_or(0).max(anchor) + i64::from(s.every_min) * 60_000)
        }
        "daily" => next_slot(s, now).map(|t| t.timestamp_millis()),
        _ => None,
    }
}

/// Model for a ZAP started by the schedule: its own, the default model, or
/// the one used last in a chat.
pub fn model_for(state: &AppState, zap: &Zap) -> Option<String> {
    if let Some(m) = zap.model.clone().filter(|m| !m.trim().is_empty()) {
        return Some(m);
    }
    let conn = state.db();
    db::get_settings(&conn)
        .ok()
        .and_then(|s| s.default_model)
        .filter(|m| !m.trim().is_empty())
        .or_else(|| db::last_chat_model(&conn).ok().flatten())
}

fn engine_ready(state: &AppState, model: &str) -> bool {
    state.status(parse_model_key(model).0) == ProviderStatus::Running
}

fn running(state: &AppState, zap_id: &str) -> bool {
    db::active_runs(&state.db()).is_ok_and(|runs| runs.iter().any(|r| r.zap_id == zap_id))
}

fn start(app: &AppHandle, zap: &Zap, model: &str) {
    let state = app.state::<AppState>();
    if let Err(err) = zaps::start(app, &state, &zap.id, None, "schedule", Some(model)) {
        zaps::notify_failed_start(app, zap, &err.to_string());
    }
}

/// Runs "on app start" ZAPs once, then checks timed schedules every 30 s.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        let state = app.state::<AppState>();
        let startup: Vec<Zap> = db::list_zaps(&state.db())
            .unwrap_or_default()
            .into_iter()
            .filter(|z| z.schedule.kind == "startup")
            .collect();
        for zap in startup {
            let Some(model) = model_for(&state, &zap) else {
                zaps::notify_failed_start(&app, &zap, "no_model");
                continue;
            };
            let waited = tokio::time::Instant::now();
            while !engine_ready(&state, &model) && waited.elapsed() < STARTUP_WAIT {
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            if !running(&state, &zap.id) {
                start(&app, &zap, &model);
            }
        }

        loop {
            let now = Local::now();
            let zaps: Vec<Zap> = db::list_zaps(&state.db()).unwrap_or_default();
            for zap in zaps
                .iter()
                .filter(|z| matches!(z.schedule.kind.as_str(), "interval" | "daily"))
            {
                let last = db::last_scheduled_run(&state.db(), &zap.id).ok().flatten();
                if !is_due(&zap.schedule, zap.updated_at, last, now) || running(&state, &zap.id) {
                    continue;
                }
                match model_for(&state, zap) {
                    // Engine still starting (or stopped): try again next tick.
                    Some(model) if !engine_ready(&state, &model) => {
                        if state.status(parse_model_key(&model).0) != ProviderStatus::Starting {
                            let _ = engine::ensure(&app, parse_model_key(&model).0).await;
                        }
                    }
                    Some(model) => start(&app, zap, &model),
                    None => {
                        zaps::notify_failed_start(&app, zap, "no_model");
                        // Don't repeat the notice every 30 s: count it as a run attempt.
                        zaps::record_skipped(&state, &zap.id, "no_model");
                    }
                }
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .earliest()
            .unwrap()
    }

    fn daily(time: &str, days: Vec<u8>) -> ZapSchedule {
        ZapSchedule {
            kind: "daily".into(),
            time: time.into(),
            days,
            ..Default::default()
        }
    }

    #[test]
    fn interval_waits_from_last_run_or_change() {
        let s = ZapSchedule {
            kind: "interval".into(),
            every_min: 60,
            ..Default::default()
        };
        let now = at(2026, 11, 11, 12, 0);
        let hour = 3_600_000;
        let t = now.timestamp_millis();
        assert!(!is_due(&s, t - hour / 2, None, now));
        assert!(is_due(&s, t - hour, None, now));
        assert!(!is_due(&s, t - 5 * hour, Some(t - 10 * 60_000), now));
        assert_eq!(next_run(&s, t - hour / 2, None, now), Some(t + hour / 2));
    }

    #[test]
    fn daily_runs_once_per_slot_and_not_before_the_change() {
        let s = daily("08:00", vec![]);
        let now = at(2026, 11, 11, 10, 0);
        let slot = at(2026, 11, 11, 8, 0).timestamp_millis();
        // Saved yesterday, nothing ran today yet: due (also catches up a missed slot).
        assert!(is_due(&s, slot - 86_400_000, None, now));
        // Already ran at 08:00 today.
        assert!(!is_due(&s, 0, Some(slot), now));
        // Schedule saved at 09:00 today: first run tomorrow.
        let saved = at(2026, 11, 11, 9, 0).timestamp_millis();
        assert!(!is_due(&s, saved, None, now));
        assert_eq!(
            next_run(&s, saved, None, now),
            Some(at(2026, 11, 12, 8, 0).timestamp_millis())
        );
    }

    #[test]
    fn daily_respects_weekdays() {
        // 2026-11-11 is a Wednesday (2); only Mondays (0).
        let s = daily("08:00", vec![0]);
        let now = at(2026, 11, 11, 10, 0);
        assert_eq!(
            next_run(&s, now.timestamp_millis(), None, now),
            Some(at(2026, 11, 16, 8, 0).timestamp_millis())
        );
        // Last Monday's slot was before the change: not due.
        assert!(!is_due(
            &s,
            at(2026, 11, 10, 0, 0).timestamp_millis(),
            None,
            now
        ));
    }

    #[test]
    fn off_and_bad_times_never_run() {
        let now = at(2026, 11, 11, 10, 0);
        assert!(!is_due(&ZapSchedule::default(), 0, None, now));
        assert!(!is_due(&daily("25:99", vec![]), 0, None, now));
        assert_eq!(next_run(&ZapSchedule::default(), 0, None, now), None);
    }
}
