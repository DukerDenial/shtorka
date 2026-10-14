mod night;
mod stats;
mod util;

#[cfg(windows)]
mod controls;
#[cfg(not(windows))]
#[path = "controls_stub.rs"]
mod controls;

use serde::Serialize;
use std::{fs, path::PathBuf, process::Command, sync::Mutex, time::SystemTime};
use tauri::{Manager, State};
use util::quiet;

/// Размер свёрнутой полоски (~0,5 см) — должен совпадать с SIZES.compact в app.js
const COMPACT_W: f64 = 72.0;
const COMPACT_H: f64 = 8.0;

/// Выполняет блокирующую работу (COM/WinRT) в отдельном потоке, не задерживая интерфейс
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(r) => r,
        Err(e) => Err(e.to_string()),
    }
}

// ───────────────────────── окно ─────────────────────────

/// Ставит окно по центру верхнего края монитора.
/// `width <= 0` — растянуть на всю ширину монитора.
fn place_window(window: &tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let monitor = match window.current_monitor().map_err(|e| e.to_string())? {
        Some(m) => m,
        None => window
            .primary_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("монитор не найден")?,
    };
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();

    let max_w = size.width as f64 / scale;
    let width = if width <= 0.0 { max_w } else { width.min(max_w) };
    let phys_w = (width * scale).round() as i32;
    let x = pos.x + (size.width as i32 - phys_w) / 2;

    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(x, pos.y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_shutter(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    place_window(&window, width, height)
}

// ───────────────────────── нагрузка ─────────────────────────

#[tauri::command]
fn get_stats(state: State<'_, Mutex<stats::SysState>>, full: bool) -> stats::Stats {
    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
    stats::collect(&mut st, full)
}

// ───────────────────────── обои ─────────────────────────

#[derive(Serialize)]
struct Wallpaper {
    name: String,
    path: String,
}

/// Картинки jpg/png/bmp из папки. Превью разрешаем только для этой папки.
fn scan_wallpapers(app: &tauri::AppHandle, dir: &PathBuf, by_name: bool) -> Result<Vec<Wallpaper>, String> {
    if !dir.is_dir() {
        return Err("Папка не найдена".into());
    }
    app.asset_protocol_scope()
        .allow_directory(dir, false)
        .map_err(|e| e.to_string())?;

    let mut items: Vec<(SystemTime, Wallpaper)> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "bmp") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        items.push((
            modified,
            Wallpaper {
                name: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: path.to_string_lossy().to_string(),
            },
        ));
    }
    if by_name {
        items.sort_by(|a, b| a.1.name.cmp(&b.1.name));
    } else {
        items.sort_by(|a, b| b.0.cmp(&a.0)); // свежие первыми
    }
    Ok(items.into_iter().take(300).map(|(_, w)| w).collect())
}

#[tauri::command]
fn list_wallpapers(app: tauri::AppHandle, folder: String) -> Result<Vec<Wallpaper>, String> {
    scan_wallpapers(&app, &PathBuf::from(folder), false)
}

/// Обои вшиты прямо в программу — работают и из установщика, и из одиночного .exe
const WALLPAPERS: &[(&str, &[u8])] = &[
    ("colors-ember.jpg", include_bytes!("../wallpapers/colors-ember.jpg")),
    ("colors-forest.jpg", include_bytes!("../wallpapers/colors-forest.jpg")),
    ("colors-graphite.jpg", include_bytes!("../wallpapers/colors-graphite.jpg")),
    ("colors-light.jpg", include_bytes!("../wallpapers/colors-light.jpg")),
    ("colors-lilac.jpg", include_bytes!("../wallpapers/colors-lilac.jpg")),
    ("colors-sand.jpg", include_bytes!("../wallpapers/colors-sand.jpg")),
    ("geometry-orbs.jpg", include_bytes!("../wallpapers/geometry-orbs.jpg")),
    ("geometry-rings.jpg", include_bytes!("../wallpapers/geometry-rings.jpg")),
    ("geometry-synthwave.jpg", include_bytes!("../wallpapers/geometry-synthwave.jpg")),
    ("geometry-triangles.jpg", include_bytes!("../wallpapers/geometry-triangles.jpg")),
    ("landscapes-aurora.jpg", include_bytes!("../wallpapers/landscapes-aurora.jpg")),
    ("landscapes-dunes.jpg", include_bytes!("../wallpapers/landscapes-dunes.jpg")),
    ("landscapes-mist.jpg", include_bytes!("../wallpapers/landscapes-mist.jpg")),
    ("landscapes-moonpath.jpg", include_bytes!("../wallpapers/landscapes-moonpath.jpg")),
    ("sea-deep.jpg", include_bytes!("../wallpapers/sea-deep.jpg")),
    ("sea-lagoon.jpg", include_bytes!("../wallpapers/sea-lagoon.jpg")),
    ("sea-sunset.jpg", include_bytes!("../wallpapers/sea-sunset.jpg")),
    ("space-galaxy.jpg", include_bytes!("../wallpapers/space-galaxy.jpg")),
    ("space-nebula.jpg", include_bytes!("../wallpapers/space-nebula.jpg")),
    ("space-planet.jpg", include_bytes!("../wallpapers/space-planet.jpg")),
    ("textures-marble.jpg", include_bytes!("../wallpapers/textures-marble.jpg")),
    ("textures-paper.jpg", include_bytes!("../wallpapers/textures-paper.jpg")),
    ("textures-waves.jpg", include_bytes!("../wallpapers/textures-waves.jpg")),
];

/// Раскладывает вшитые обои в папку данных программы и возвращает её путь
fn bundled_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("wallpapers");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, bytes) in WALLPAPERS.iter() {
        let p = dir.join(name);
        let same = fs::metadata(&p).map(|m| m.len() == bytes.len() as u64).unwrap_or(false);
        if !same {
            fs::write(&p, bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(dir)
}

#[tauri::command]
fn list_bundled_wallpapers(app: tauri::AppHandle) -> Result<Vec<Wallpaper>, String> {
    let dir = bundled_dir(&app)?;
    scan_wallpapers(&app, &dir, true)
}

#[tauri::command]
async fn set_wallpaper(path: String) -> Result<(), String> {
    blocking(move || controls::set_wallpaper(&path)).await
}

// ───────────────────────── запуск и питание ─────────────────────────

/// Открывает программу, ярлык, ссылку https или страницу настроек Windows (ms-settings:)
#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    let is_uri = target.starts_with("https://")
        || target.starts_with("http://")
        || target.starts_with("ms-settings:");
    if !is_uri && !PathBuf::from(&target).exists() {
        return Err("Файл не найден — возможно, программу удалили или переместили".into());
    }
    quiet(Command::new("explorer.exe").arg(&target))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn power_action(action: String) -> Result<(), String> {
    let (program, args): (&str, Vec<&str>) = match action.as_str() {
        "lock" => ("rundll32.exe", vec!["user32.dll,LockWorkStation"]),
        "logoff" => ("shutdown.exe", vec!["/l"]),
        "restart" => ("shutdown.exe", vec!["/r", "/t", "0"]),
        "shutdown" => ("shutdown.exe", vec!["/s", "/t", "0"]),
        _ => return Err("Неизвестное действие".into()),
    };
    quiet(Command::new(program).args(args))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ───────────────────────── центр управления ─────────────────────────

#[tauri::command]
async fn get_volume() -> Result<controls::VolumeState, String> {
    blocking(controls::get_volume).await
}

#[tauri::command]
async fn set_volume(level: f32) -> Result<(), String> {
    blocking(move || controls::set_volume(level)).await
}

#[tauri::command]
async fn set_mute(muted: bool) -> Result<(), String> {
    blocking(move || controls::set_mute(muted)).await
}

#[tauri::command]
async fn get_radios() -> Result<Vec<controls::RadioInfo>, String> {
    blocking(controls::get_radios).await
}

#[tauri::command]
async fn set_radio(kind: String, on: bool) -> Result<(), String> {
    blocking(move || controls::set_radio(&kind, on)).await
}

#[tauri::command]
async fn get_theme_light() -> bool {
    blocking(|| Ok(controls::get_theme_light())).await.unwrap_or(false)
}

#[tauri::command]
async fn set_theme_light(light: bool) -> Result<(), String> {
    blocking(move || controls::set_theme_light(light)).await
}

/// Тёплая полупрозрачная плёнка поверх экрана — запасной вариант, если драйвер не принял цвет
fn night_overlay(app: &tauri::AppHandle, strength: f32) -> Result<(), String> {
    let existing = app.get_webview_window("night");
    if strength <= 0.0 {
        if let Some(w) = existing {
            let _ = w.hide();
        }
        return Ok(());
    }
    let win = match existing {
        Some(w) => w,
        None => {
            let w = tauri::WebviewWindowBuilder::new(app, "night", tauri::WebviewUrl::App("night.html".into()))
                .title("Шторка: ночной режим")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .shadow(false)
                .focused(false)
                .visible(false)
                .build()
                .map_err(|e| e.to_string())?;
            let _ = w.set_ignore_cursor_events(true);
            w
        }
    };
    if let Some(m) = win.primary_monitor().map_err(|e| e.to_string())? {
        let _ = win.set_position(*m.position());
        // на пиксель ниже монитора, чтобы Windows не принял окно за полноэкранное приложение и не спрятал панель задач
        let _ = win.set_size(tauri::PhysicalSize::new(m.size().width, m.size().height.saturating_sub(1)));
    }
    let a = (strength.clamp(0.0, 1.0) * 0.42 * 1000.0).round() / 1000.0;
    let _ = win.eval(format!("document.documentElement.style.setProperty('--a','{}')", a));
    let _ = win.show();
    Ok(())
}

#[tauri::command]
async fn set_night(app: tauri::AppHandle, strength: f32) -> Result<(), String> {
    // сначала пробуем настоящую цветовую гамму; не приняли — накрываем экран тёплой плёнкой
    let gamma = blocking(move || controls::set_night(strength)).await;
    if gamma.is_ok() {
        let _ = night_overlay(&app, 0.0);
        return Ok(());
    }
    night_overlay(&app, strength)
}

#[tauri::command]
async fn media_state() -> Result<Option<controls::MediaInfo>, String> {
    blocking(controls::media_state).await
}

#[tauri::command]
async fn media_cmd(cmd: String) -> Result<(), String> {
    blocking(move || controls::media_cmd(&cmd)).await
}

#[tauri::command]
async fn media_thumb() -> Result<Option<String>, String> {
    blocking(controls::media_thumb).await
}

// ───────────────────────── запуск приложения ─────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .manage(Mutex::new(stats::SysState::new()))
        .invoke_handler(tauri::generate_handler![
            resize_shutter,
            get_stats,
            list_wallpapers,
            list_bundled_wallpapers,
            set_wallpaper,
            open_target,
            power_action,
            get_volume,
            set_volume,
            set_mute,
            get_radios,
            set_radio,
            get_theme_light,
            set_theme_light,
            set_night,
            media_state,
            media_cmd,
            media_thumb
        ])
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = place_window(&win, COMPACT_W, COMPACT_H);
                let _ = win.show();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("ошибка запуска приложения")
        .run(|_app, event| {
            // при выходе возвращаем нормальные цвета экрана
            if let tauri::RunEvent::Exit = event {
                let _ = controls::set_night(0.0);
            }
        });
}
