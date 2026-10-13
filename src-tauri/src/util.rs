//! Мелкие помощники для запуска системных команд

use std::process::Command;

/// Запускать консольную утилиту без мигающего чёрного окна
#[cfg(windows)]
pub fn quiet(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub fn quiet(cmd: &mut Command) -> &mut Command {
    cmd
}
