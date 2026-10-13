//! Математика ночного режима: температура цвета → таблица гаммы.
//! Чистые функции без обращения к Windows, поэтому покрыты тестами.

/// Цвет чёрного тела по температуре (алгоритм Таннера Хелланда), компоненты 0..1
pub fn kelvin_rgb(kelvin: f32) -> (f32, f32, f32) {
    let t = kelvin.clamp(1000.0, 40000.0) / 100.0;
    let r = if t <= 66.0 { 255.0 } else { 329.698_73 * (t - 60.0).powf(-0.133_204_76) };
    let g = if t <= 66.0 {
        99.470_8 * t.ln() - 161.119_57
    } else {
        288.122_17 * (t - 60.0).powf(-0.075_514_85)
    };
    let b = if t >= 66.0 {
        255.0
    } else if t <= 19.0 {
        0.0
    } else {
        138.517_73 * (t - 10.0).ln() - 305.044_8
    };
    ((r.clamp(0.0, 255.0)) / 255.0, (g.clamp(0.0, 255.0)) / 255.0, (b.clamp(0.0, 255.0)) / 255.0)
}

/// Множители каналов для силы ночного режима 0..1 (0 — без изменений)
pub fn night_factors(strength: f32) -> (f32, f32, f32) {
    let s = strength.clamp(0.0, 1.0);
    let (r, g, b) = kelvin_rgb(3400.0);
    (1.0 + (r - 1.0) * s, 1.0 + (g - 1.0) * s, 1.0 + (b - 1.0) * s)
}

/// Строит таблицу гаммы: три канала по 256 значений u16
pub fn night_ramp(strength: f32) -> [[u16; 256]; 3] {
    let (fr, fg, fb) = night_factors(strength);
    let mut ramp = [[0u16; 256]; 3];
    for i in 0..256usize {
        let base = i as f32 * 257.0;
        ramp[0][i] = (base * fr).round().clamp(0.0, 65535.0) as u16;
        ramp[1][i] = (base * fg).round().clamp(0.0, 65535.0) as u16;
        ramp[2][i] = (base * fb).round().clamp(0.0, 65535.0) as u16;
    }
    ramp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_point_is_neutral_at_zero_strength() {
        let (r, g, b) = night_factors(0.0);
        assert_eq!((r, g, b), (1.0, 1.0, 1.0));
        let ramp = night_ramp(0.0);
        assert_eq!(ramp[0][255], 65535);
        assert_eq!(ramp[2][128], 128 * 257);
    }

    #[test]
    fn night_mode_reduces_blue_more_than_green() {
        let (r, g, b) = night_factors(1.0);
        assert!(r > 0.99);
        assert!(g < r && b < g, "r={r} g={g} b={b}");
        assert!(b > 0.35, "синий не должен гаснуть слишком сильно: {b}");
    }

    #[test]
    fn ramp_is_monotonic_and_bounded() {
        for s in [0.0, 0.3, 0.7, 1.0] {
            let ramp = night_ramp(s);
            for ch in 0..3 {
                assert_eq!(ramp[ch][0], 0);
                for i in 1..256 {
                    assert!(ramp[ch][i] >= ramp[ch][i - 1]);
                }
            }
        }
    }

    #[test]
    fn kelvin_known_points() {
        let (r, g, b) = kelvin_rgb(6600.0);
        assert!(r > 0.99 && g > 0.95 && b > 0.99);
        let (r, g, b) = kelvin_rgb(2000.0);
        assert!(r > 0.99 && g < 0.6 && b < 0.1, "{r} {g} {b}");
    }
}
