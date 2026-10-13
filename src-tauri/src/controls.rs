//! Управление Windows: громкость, Wi-Fi и Bluetooth, тема, ночной режим, медиа-плеер.
//! Без зависимостей от Tauri — модуль можно собирать и проверять отдельно.

use crate::night::night_ramp;
use crate::util::quiet;
use serde::Serialize;
use std::ffi::c_void;
use std::process::Command;
use std::sync::Mutex;

use windows::core::Interface;
use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlayStatus,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::Graphics::Gdi::{GetDC, ReleaseDC};
use windows::Win32::UI::ColorSystem::SetDeviceGammaRamp;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Каждый поток, который говорит с COM/WinRT, должен один раз его инициализировать.
/// Повторный вызов безвреден (вернёт S_FALSE), ошибку игнорируем.
fn com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

// ───────────────────────── обои ─────────────────────────

pub fn set_wallpaper(path: &str) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_SETDESKWALLPAPER,
    };
    if !std::path::Path::new(path).is_file() {
        return Err("Файл не найден".into());
    }
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            Some(wide.as_ptr() as *mut c_void),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
        .map_err(err)
    }
}

// ───────────────────────── громкость ─────────────────────────

#[derive(Serialize)]
pub struct VolumeState {
    /// 0.0 .. 1.0
    pub level: f32,
    pub muted: bool,
}

fn endpoint() -> Result<IAudioEndpointVolume, String> {
    com();
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(err)?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(err)?;
        device
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .map_err(err)
    }
}

pub fn get_volume() -> Result<VolumeState, String> {
    let ep = endpoint()?;
    unsafe {
        Ok(VolumeState {
            level: ep.GetMasterVolumeLevelScalar().map_err(err)?,
            muted: ep.GetMute().map_err(err)?.as_bool(),
        })
    }
}

pub fn set_volume(level: f32) -> Result<(), String> {
    let ep = endpoint()?;
    unsafe {
        ep.SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null())
            .map_err(err)?;
        // Если двигаем ползунок при выключенном звуке — включаем звук обратно
        if level > 0.0 && ep.GetMute().map_err(err)?.as_bool() {
            ep.SetMute(false, std::ptr::null()).map_err(err)?;
        }
    }
    Ok(())
}

pub fn set_mute(muted: bool) -> Result<(), String> {
    let ep = endpoint()?;
    unsafe { ep.SetMute(muted, std::ptr::null()).map_err(err) }
}

// ───────────────────────── Wi-Fi и Bluetooth ─────────────────────────

#[derive(Serialize)]
pub struct RadioInfo {
    /// "wifi" или "bluetooth"
    pub kind: String,
    pub on: bool,
}

fn kind_name(k: RadioKind) -> Option<&'static str> {
    if k == RadioKind::WiFi {
        Some("wifi")
    } else if k == RadioKind::Bluetooth {
        Some("bluetooth")
    } else {
        None
    }
}

pub fn get_radios() -> Result<Vec<RadioInfo>, String> {
    com();
    let radios = Radio::GetRadiosAsync().map_err(err)?.get().map_err(err)?;
    let mut out: Vec<RadioInfo> = Vec::new();
    for r in radios {
        let Some(name) = kind_name(r.Kind().map_err(err)?) else { continue };
        let on = r.State().map_err(err)? == RadioState::On;
        // несколько адаптеров одного типа считаем включёнными, если включён хоть один
        if let Some(existing) = out.iter_mut().find(|x| x.kind == name) {
            existing.on = existing.on || on;
        } else {
            out.push(RadioInfo { kind: name.to_string(), on });
        }
    }
    Ok(out)
}

pub fn set_radio(kind: &str, on: bool) -> Result<(), String> {
    com();
    let access = Radio::RequestAccessAsync().map_err(err)?.get().map_err(err)?;
    if access != RadioAccessStatus::Allowed {
        return Err("Windows не разрешил приложению управлять радио. Проверьте «Параметры → Конфиденциальность → Радио».".into());
    }
    let radios = Radio::GetRadiosAsync().map_err(err)?.get().map_err(err)?;
    let target = if on { RadioState::On } else { RadioState::Off };
    let mut found = false;
    for r in radios {
        if kind_name(r.Kind().map_err(err)?) == Some(kind) {
            found = true;
            let status = r.SetStateAsync(target).map_err(err)?.get().map_err(err)?;
            if status != RadioAccessStatus::Allowed {
                return Err("Не удалось переключить: доступ запрещён".into());
            }
        }
    }
    if found { Ok(()) } else { Err("Такого адаптера в компьютере нет".into()) }
}

// ───────────────────────── тема Windows ─────────────────────────

const PERSONALIZE: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

/// true — светлая тема приложений
pub fn get_theme_light() -> bool {
    let out = quiet(Command::new("reg").args(["query", PERSONALIZE, "/v", "AppsUseLightTheme"])).output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains("0x1"),
        Err(_) => false,
    }
}

pub fn set_theme_light(light: bool) -> Result<(), String> {
    let v = if light { "1" } else { "0" };
    for name in ["AppsUseLightTheme", "SystemUsesLightTheme"] {
        let st = quiet(Command::new("reg").args(["add", PERSONALIZE, "/v", name, "/t", "REG_DWORD", "/d", v, "/f"]))
            .status()
            .map_err(err)?;
        if !st.success() {
            return Err("Не удалось записать тему в реестр (возможно, запрещено политикой)".into());
        }
    }
    broadcast_theme_change();
    Ok(())
}

/// Сообщаем окнам, что тема поменялась, чтобы панель задач и приложения перерисовались сразу
fn broadcast_theme_change() {
    use windows::core::w;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    unsafe {
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(w!("ImmersiveColorSet").as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            300,
            None,
        );
    }
}

// ───────────────────────── ночной режим ─────────────────────────

/// Программный «ночной свет»: сдвигает цвета экрана в тёплую сторону.
/// strength 0 возвращает обычные цвета. Действует на основной монитор.
pub fn set_night(strength: f32) -> Result<(), String> {
    let ramp = night_ramp(strength);
    unsafe {
        let hdc = GetDC(None);
        let ok = SetDeviceGammaRamp(hdc, ramp.as_ptr() as *const c_void);
        ReleaseDC(None, hdc);
        if ok.as_bool() {
            Ok(())
        } else {
            Err("Драйвер видеокарты не принял настройку цвета".into())
        }
    }
}

// ───────────────────────── медиа-плеер ─────────────────────────

#[derive(Serialize)]
pub struct MediaInfo {
    pub title: String,
    pub artist: String,
    /// например «Spotify.exe» или «chrome.exe»
    pub app: String,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub can_prev: bool,
    pub can_next: bool,
}

fn current_session() -> Result<Option<Session>, String> {
    com();
    let mgr = Manager::RequestAsync().map_err(err)?.get().map_err(err)?;
    // если сеансов нет, Windows возвращает пустой указатель — для нас это «ничего не играет»
    Ok(mgr.GetCurrentSession().ok())
}

pub fn media_state() -> Result<Option<MediaInfo>, String> {
    let Some(s) = current_session()? else { return Ok(None) };
    let props = s.TryGetMediaPropertiesAsync().map_err(err)?.get().map_err(err)?;
    let info = s.GetPlaybackInfo().map_err(err)?;
    let playing = info.PlaybackStatus().map_err(err)? == PlayStatus::Playing;
    let (can_prev, can_next) = match info.Controls() {
        Ok(c) => (c.IsPreviousEnabled().unwrap_or(true), c.IsNextEnabled().unwrap_or(true)),
        Err(_) => (true, true),
    };

    // позиция: Windows обновляет её только при событиях, дальше досчитываем сами
    let mut position = 0.0;
    let mut duration = 0.0;
    if let Ok(tl) = s.GetTimelineProperties() {
        let start = tl.StartTime().map(|t| t.Duration).unwrap_or(0);
        let end = tl.EndTime().map(|t| t.Duration).unwrap_or(0);
        let pos = tl.Position().map(|t| t.Duration).unwrap_or(0);
        duration = (end - start).max(0) as f64 / 1e7;
        position = (pos - start).max(0) as f64 / 1e7;
        if playing {
            if let Ok(upd) = tl.LastUpdatedTime() {
                // DateTime — это 100-нс интервалы с 1601 года
                const UNIX_TO_FILETIME: i64 = 116_444_736_000_000_000;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos() as i64 / 100)
                    .unwrap_or(0)
                    + UNIX_TO_FILETIME;
                let passed = ((now - upd.UniversalTime).max(0)) as f64 / 1e7;
                if passed < 6.0 * 3600.0 {
                    position += passed;
                }
            }
        }
        if duration > 0.0 {
            position = position.min(duration);
        }
    }

    Ok(Some(MediaInfo {
        title: props.Title().map(|h| h.to_string()).unwrap_or_default(),
        artist: props.Artist().map(|h| h.to_string()).unwrap_or_default(),
        app: s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default(),
        playing,
        position,
        duration,
        can_prev,
        can_next,
    }))
}

/// "toggle" | "next" | "prev"
pub fn media_cmd(cmd: &str) -> Result<(), String> {
    let Some(s) = current_session()? else { return Err("Сейчас ничего не играет".into()) };
    let op = match cmd {
        "toggle" => s.TryTogglePlayPauseAsync(),
        "next" => s.TrySkipNextAsync(),
        "prev" => s.TrySkipPreviousAsync(),
        _ => return Err("Неизвестная команда плеера".into()),
    };
    op.map_err(err)?.get().map_err(err)?;
    Ok(())
}

static THUMB_CACHE: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

/// Обложка текущего трека в виде data-URI. Кэшируется по названию трека.
pub fn media_thumb() -> Result<Option<String>, String> {
    use base64::Engine;
    let Some(s) = current_session()? else { return Ok(None) };
    let props = s.TryGetMediaPropertiesAsync().map_err(err)?.get().map_err(err)?;
    let key = format!(
        "{}|{}",
        props.Title().map(|h| h.to_string()).unwrap_or_default(),
        props.Artist().map(|h| h.to_string()).unwrap_or_default()
    );
    if let Ok(guard) = THUMB_CACHE.lock() {
        if let Some((k, v)) = guard.as_ref() {
            if *k == key {
                return Ok(v.clone());
            }
        }
    }

    let thumb: Option<String> = (|| -> Result<Option<String>, String> {
        let Ok(reference) = props.Thumbnail() else { return Ok(None) };
        let stream = reference.OpenReadAsync().map_err(err)?.get().map_err(err)?;
        let size = stream.Size().map_err(err)? as u32;
        if size == 0 || size > 8 * 1024 * 1024 {
            return Ok(None);
        }
        let mime = stream
            .ContentType()
            .map(|h| h.to_string())
            .ok()
            .filter(|m| m.starts_with("image/"))
            .unwrap_or_else(|| "image/jpeg".to_string());
        let reader = DataReader::CreateDataReader(&stream).map_err(err)?;
        reader.LoadAsync(size).map_err(err)?.get().map_err(err)?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf).map_err(err)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        Ok(Some(format!("data:{mime};base64,{b64}")))
    })()
    .unwrap_or(None);

    if let Ok(mut guard) = THUMB_CACHE.lock() {
        *guard = Some((key, thumb.clone()));
    }
    Ok(thumb)
}
