//! Заглушка для не-Windows систем: приложение рассчитано на Windows,
//! но проект должен собираться и на других ОС (например, для разработки интерфейса).

use serde::Serialize;

const MSG: &str = "Эта функция работает только в Windows";

#[derive(Serialize)]
pub struct VolumeState { pub level: f32, pub muted: bool }
#[derive(Serialize)]
pub struct RadioInfo { pub kind: String, pub on: bool }
#[derive(Serialize)]
pub struct MediaInfo {
    pub title: String, pub artist: String, pub app: String, pub playing: bool,
    pub position: f64, pub duration: f64, pub can_prev: bool, pub can_next: bool,
}

pub fn set_wallpaper(_path: &str) -> Result<(), String> { Err(MSG.into()) }
pub fn get_volume() -> Result<VolumeState, String> { Err(MSG.into()) }
pub fn set_volume(_level: f32) -> Result<(), String> { Err(MSG.into()) }
pub fn set_mute(_muted: bool) -> Result<(), String> { Err(MSG.into()) }
pub fn get_radios() -> Result<Vec<RadioInfo>, String> { Err(MSG.into()) }
pub fn set_radio(_kind: &str, _on: bool) -> Result<(), String> { Err(MSG.into()) }
pub fn get_theme_light() -> bool { false }
pub fn set_theme_light(_light: bool) -> Result<(), String> { Err(MSG.into()) }
pub fn set_night(_strength: f32) -> Result<(), String> { Err(MSG.into()) }
pub fn media_state() -> Result<Option<MediaInfo>, String> { Ok(None) }
pub fn media_cmd(_cmd: &str) -> Result<(), String> { Err(MSG.into()) }
pub fn media_thumb() -> Result<Option<String>, String> { Ok(None) }
