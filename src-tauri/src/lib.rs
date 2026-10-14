mod night;
mod stats;
mod util;

#[cfg(windows)]
mod controls;
#[cfg(not(windows))]
#[path = "controls_stub.rs"]
mod controls;

use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime},
};
use tauri::{Emitter, Manager, State};
use util::quiet;

/// Язычок в свёрнутом виде (логические px) — должен совпадать с CSS (#shell clip-path) в style.css
const PILL_W: f64 = 56.0;
const PILL_H: f64 = 6.0;
/// Окно всегда нужного размера (чтобы раскрытие было плавным и без изменения размера окна)
const START_W: f64 = 940.0;
const START_H: f64 = 560.0;

/// Раскрыта ли шторка. Пока свёрнута, окно «прозрачно» для мыши, а наведение на язычок ловит поток ниже.
static OPEN: AtomicBool = AtomicBool::new(false);

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
fn set_open(window: tauri::WebviewWindow, open: bool) -> Result<(), String> {
    OPEN.store(open, Ordering::Relaxed);
    window.set_ignore_cursor_events(!open).map_err(|e| e.to_string())
}

/// Следит за курсором: пока шторка свёрнута, сообщает интерфейсу, что мышь на язычке
fn spawn_hover_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(30));
        if OPEN.load(Ordering::Relaxed) {
            continue;
        }
        let Some(win) = app.get_webview_window("main") else { continue };
        let (Ok(cur), Ok(pos), Ok(size), Ok(scale)) = (
            win.cursor_position(),
            win.outer_position(),
            win.outer_size(),
            win.scale_factor(),
        ) else {
            continue;
        };
        let half = PILL_W * scale / 2.0 + 4.0;
        let cx = pos.x as f64 + size.width as f64 / 2.0;
        let top = pos.y as f64;
        let inside = cur.x >= cx - half
            && cur.x <= cx + half
            && cur.y >= top - 2.0
            && cur.y <= top + (PILL_H + 3.0) * scale;
        if inside {
            let _ = app.emit("pill-hover", ());
        }
    });
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
    ("asia-01.jpg", include_bytes!("../wallpapers/asia-01.jpg")),
    ("asia-13.jpg", include_bytes!("../wallpapers/asia-13.jpg")),
    ("latin-01.jpg", include_bytes!("../wallpapers/latin-01.jpg")),
    ("latin-13.jpg", include_bytes!("../wallpapers/latin-13.jpg")),
    ("rising-01.jpg", include_bytes!("../wallpapers/rising-01.jpg")),
    ("rising-13.jpg", include_bytes!("../wallpapers/rising-13.jpg")),
    ("geometry-01.jpg", include_bytes!("../wallpapers/geometry-01.jpg")),
    ("geometry-12.jpg", include_bytes!("../wallpapers/geometry-12.jpg")),
    ("cities-01.jpg", include_bytes!("../wallpapers/cities-01.jpg")),
    ("cities-22.jpg", include_bytes!("../wallpapers/cities-22.jpg")),
    ("life-01.jpg", include_bytes!("../wallpapers/life-01.jpg")),
    ("life-22.jpg", include_bytes!("../wallpapers/life-22.jpg")),
    ("art-01.jpg", include_bytes!("../wallpapers/art-01.jpg")),
    ("art-29.jpg", include_bytes!("../wallpapers/art-29.jpg")),
    ("sea-01.jpg", include_bytes!("../wallpapers/sea-01.jpg")),
    ("sea-18.jpg", include_bytes!("../wallpapers/sea-18.jpg")),
    ("solid-01.jpg", include_bytes!("../wallpapers/solid-01.jpg")),
    ("solid-13.jpg", include_bytes!("../wallpapers/solid-13.jpg")),
    ("landscapes-01.jpg", include_bytes!("../wallpapers/landscapes-01.jpg")),
    ("landscapes-31.jpg", include_bytes!("../wallpapers/landscapes-31.jpg")),
    ("textures-01.jpg", include_bytes!("../wallpapers/textures-01.jpg")),
    ("textures-18.jpg", include_bytes!("../wallpapers/textures-18.jpg")),
    ("black-01.jpg", include_bytes!("../wallpapers/black-01.jpg")),
    ("black-15.jpg", include_bytes!("../wallpapers/black-15.jpg")),
    ("earth-01.jpg", include_bytes!("../wallpapers/earth-01.jpg")),
    ("earth-24.jpg", include_bytes!("../wallpapers/earth-24.jpg")),
    ("lgbtq-01.jpg", include_bytes!("../wallpapers/lgbtq-01.jpg")),
    ("lgbtq-11.jpg", include_bytes!("../wallpapers/lgbtq-11.jpg")),
    ("native-01.jpg", include_bytes!("../wallpapers/native-01.jpg")),
    ("native-12.jpg", include_bytes!("../wallpapers/native-12.jpg")),
];

/// Раскладывает вшитые обои в папку данных программы и возвращает её путь
fn bundled_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("wallpapers");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // убираем обои прежних версий, которых больше нет в комплекте
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if !WALLPAPERS.iter().any(|(k, _)| *k == n) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
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

/// Значки сразу для нескольких программ или ярлыков (PNG в base64), один запуск PowerShell на пачку
fn icons_for(paths: &[String]) -> Vec<Option<String>> {
    const PS: &str = r#"
Add-Type -AssemblyName System.Drawing
$ws = New-Object -ComObject WScript.Shell
foreach ($p in ($env:SH_PATHS -split '\|')) {
  $res = ''
  try {
    $q = $p
    if ($p -like '*.lnk') {
      $t = $ws.CreateShortcut($p)
      $p2 = $null
      if ($t.IconLocation -and $t.IconLocation -notlike ',*') {
        $loc = $t.IconLocation.Split(',')[0]
        if ($loc -and (Test-Path -LiteralPath $loc)) { $p2 = $loc }
      }
      if (-not $p2 -and $t.TargetPath -and (Test-Path -LiteralPath $t.TargetPath)) { $p2 = $t.TargetPath }
      if ($p2) { $q = $p2 }
    }
    $ic = [System.Drawing.Icon]::ExtractAssociatedIcon($q)
    $bmp = New-Object System.Drawing.Bitmap 48, 48
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.DrawImage($ic.ToBitmap(), 0, 0, 48, 48)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $res = [Convert]::ToBase64String($ms.ToArray())
  } catch { }
  Write-Output $res
}
"#;
    let joined = paths.join("|");
    let out = quiet(
        Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS])
            .env("SH_PATHS", joined),
    )
    .output();
    let text = match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => String::new(),
    };
    let mut lines = text.lines();
    paths
        .iter()
        .map(|_| {
            let l = lines.next().unwrap_or("").trim();
            if l.len() > 40 { Some(format!("data:image/png;base64,{l}")) } else { None }
        })
        .collect()
}

/// Настоящие значки для списка программ (порядок сохраняется, где значка нет — null)
#[tauri::command]
async fn app_icons(paths: Vec<String>) -> Result<Vec<Option<String>>, String> {
    if paths.is_empty() {
        return Ok(vec![]);
    }
    blocking(move || Ok(icons_for(&paths))).await
}

#[derive(Serialize)]
struct StartApp {
    name: String,
    path: String,
}

fn walk_lnk(dir: &PathBuf, depth: u32, out: &mut Vec<StartApp>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth < 4 {
                walk_lnk(&p, depth + 1, out);
            }
            continue;
        }
        if p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("lnk")) != Some(true) {
            continue;
        }
        let name = p.file_stem().and_then(|x| x.to_str()).unwrap_or("").to_string();
        let low = name.to_lowercase();
        const SKIP: [&str; 10] = [
            "uninstall", "удал", "readme", "справк", "help", "documentation", "license", "лицензи", "website", "веб-сайт",
        ];
        if name.is_empty() || SKIP.iter().any(|w| low.contains(w)) {
            continue;
        }
        out.push(StartApp { name, path: p.to_string_lossy().to_string() });
    }
}

/// Установленные программы: ярлыки из меню «Пуск» (общие и пользовательские)
#[tauri::command]
async fn list_start_apps() -> Result<Vec<StartApp>, String> {
    blocking(|| {
        let mut out = Vec::new();
        for var in ["ProgramData", "APPDATA"] {
            if let Ok(base) = std::env::var(var) {
                let dir = PathBuf::from(base).join("Microsoft").join("Windows").join("Start Menu").join("Programs");
                walk_lnk(&dir, 0, &mut out);
            }
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out.dedup_by(|a, b| a.name.to_lowercase() == b.name.to_lowercase());
        Ok(out)
    })
    .await
}

/// Запускает программу или ярлык от имени администратора (покажется окно UAC)
#[tauri::command]
fn run_as_admin(path: String) -> Result<(), String> {
    if !PathBuf::from(&path).exists() {
        return Err("Файл не найден — возможно, программу удалили или переместили".into());
    }
    quiet(
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "Start-Process -FilePath $env:SH_T -Verb RunAs",
            ])
            .env("SH_T", &path),
    )
    .spawn()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Показывает файл в Проводнике
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    quiet(Command::new("explorer.exe").arg(format!("/select,{path}")))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

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
    // основной путь — цветовой фильтр Windows (Magnification API); если он недоступен — тёплая плёнка поверх экрана
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
            set_open,
            get_stats,
            list_wallpapers,
            list_bundled_wallpapers,
            set_wallpaper,
            open_target,
            run_as_admin,
            reveal_in_folder,
            app_icons,
            list_start_apps,
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
                let _ = place_window(&win, START_W, START_H);
                let _ = win.set_ignore_cursor_events(true);
                let _ = win.show();
            }
            spawn_hover_watcher(app.handle().clone());
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
