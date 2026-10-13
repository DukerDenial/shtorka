//! Сбор нагрузки компьютера. Без зависимостей от Tauri, чтобы модуль
//! можно было проверять и тестировать отдельно.

use serde::Serialize;
use std::collections::HashMap;
use std::time::Instant;
use sysinfo::{Disks, Networks, ProcessesToUpdate, System};

#[derive(Serialize, Clone)]
pub struct DiskInfo {
    pub name: String,
    pub total: u64,
    pub used: u64,
}

#[derive(Serialize, Clone)]
pub struct ProcInfo {
    pub name: String,
    /// Загрузка процессора в процентах от всего процессора (0..100)
    pub cpu: f32,
    /// Занятая память в байтах
    pub mem: u64,
}

#[derive(Serialize)]
pub struct Stats {
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    /// Скорость сети, байт в секунду
    pub net_down: f64,
    pub net_up: f64,
    pub disks: Vec<DiskInfo>,
    pub top_cpu: Vec<ProcInfo>,
    pub top_mem: Vec<ProcInfo>,
}

pub struct SysState {
    sys: System,
    nets: Networks,
    net_at: Option<Instant>,
    disks_cache: Vec<DiskInfo>,
    disks_at: Option<Instant>,
}

impl SysState {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self {
            sys,
            nets: Networks::new_with_refreshed_list(),
            net_at: None,
            disks_cache: Vec::new(),
            disks_at: None,
        }
    }
}

impl Default for SysState {
    fn default() -> Self {
        Self::new()
    }
}

/// `full == false` — лёгкий режим (только процессор и память) для таблетки
/// в свёрнутом виде. `full == true` — всё, включая процессы, диски и сеть.
pub fn collect(st: &mut SysState, full: bool) -> Stats {
    st.sys.refresh_cpu_usage();
    st.sys.refresh_memory();

    let cpu = st.sys.global_cpu_usage();
    let mem_used = st.sys.used_memory();
    let mem_total = st.sys.total_memory();

    if !full {
        return Stats {
            cpu,
            mem_used,
            mem_total,
            net_down: 0.0,
            net_up: 0.0,
            disks: Vec::new(),
            top_cpu: Vec::new(),
            top_mem: Vec::new(),
        };
    }

    // Процессы: складываем по имени (у браузера их десятки)
    st.sys.refresh_processes(ProcessesToUpdate::All, true);
    let cores = st.sys.cpus().len().max(1) as f32;
    let mut by_name: HashMap<String, (f32, u64)> = HashMap::new();
    for p in st.sys.processes().values() {
        let name = p.name().to_string_lossy().to_string();
        let e = by_name.entry(name).or_insert((0.0, 0));
        e.0 += p.cpu_usage() / cores;
        e.1 += p.memory();
    }
    let all: Vec<ProcInfo> = by_name
        .into_iter()
        .map(|(name, (cpu, mem))| ProcInfo { name, cpu, mem })
        .collect();

    let mut top_cpu = all.clone();
    top_cpu.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
    top_cpu.truncate(5);

    let mut top_mem = all;
    top_mem.sort_by(|a, b| b.mem.cmp(&a.mem));
    top_mem.truncate(5);

    // Диски меняются редко, обновляем раз в 15 секунд
    let stale = st
        .disks_at
        .map(|t| t.elapsed().as_secs() > 15)
        .unwrap_or(true);
    if stale {
        let disks = Disks::new_with_refreshed_list();
        st.disks_cache = disks
            .iter()
            .filter(|d| d.total_space() > 0)
            .map(|d| DiskInfo {
                name: d.mount_point().to_string_lossy().to_string(),
                total: d.total_space(),
                used: d.total_space().saturating_sub(d.available_space()),
            })
            .collect();
        st.disks_at = Some(Instant::now());
    }

    // Сеть: прирост байт с прошлого обновления / прошедшее время
    st.nets.refresh(true);
    let now = Instant::now();
    let (rx, tx) = st
        .nets
        .iter()
        .fold((0u64, 0u64), |(r, t), (_, n)| (r + n.received(), t + n.transmitted()));
    let (net_down, net_up) = match st.net_at {
        Some(prev) => {
            let dt = now.duration_since(prev).as_secs_f64().max(0.001);
            (rx as f64 / dt, tx as f64 / dt)
        }
        None => (0.0, 0.0),
    };
    st.net_at = Some(now);

    Stats {
        cpu,
        mem_used,
        mem_total,
        net_down,
        net_up,
        disks: st.disks_cache.clone(),
        top_cpu,
        top_mem,
    }
}
