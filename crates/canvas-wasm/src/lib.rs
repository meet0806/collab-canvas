use std::alloc::{alloc, dealloc, Layout};
use std::slice;

const HEADER_BYTES: usize = 4;

#[no_mangle]
pub extern "C" fn alloc_bytes(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }

    let layout = Layout::from_size_align(len, 8).expect("valid allocation layout");
    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc_bytes(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }

    let layout = Layout::from_size_align(len, 8).expect("valid allocation layout");
    unsafe {
        dealloc(ptr, layout);
    }
}

#[no_mangle]
pub extern "C" fn clear(buffer_ptr: *mut u8, buffer_len: usize, r: u8, g: u8, b: u8, a: u8) {
    if buffer_ptr.is_null() || buffer_len < HEADER_BYTES {
        return;
    }

    let pixels = unsafe { slice::from_raw_parts_mut(buffer_ptr, buffer_len) };
    for chunk in pixels.chunks_exact_mut(4) {
        chunk[0] = r;
        chunk[1] = g;
        chunk[2] = b;
        chunk[3] = a;
    }
}

#[no_mangle]
pub extern "C" fn rasterize_stroke(
    points_ptr: *const f32,
    point_count: usize,
    width: usize,
    height: usize,
    rgba: u32,
    base_radius: f32,
    buffer_ptr: *mut u8,
    buffer_len: usize,
) {
    if points_ptr.is_null()
        || buffer_ptr.is_null()
        || point_count == 0
        || width == 0
        || height == 0
        || buffer_len < width.saturating_mul(height).saturating_mul(4)
    {
        return;
    }

    let points = unsafe { slice::from_raw_parts(points_ptr, point_count.saturating_mul(3)) };
    let buffer = unsafe { slice::from_raw_parts_mut(buffer_ptr, buffer_len) };

    let color = Color {
        r: ((rgba >> 24) & 0xff) as u8,
        g: ((rgba >> 16) & 0xff) as u8,
        b: ((rgba >> 8) & 0xff) as u8,
        a: (rgba & 0xff) as u8,
    };

    if point_count == 1 {
        let x = points[0];
        let y = points[1];
        let pressure = pressure_at(points[2]);
        draw_disc(buffer, width, height, x, y, base_radius * pressure, color);
        return;
    }

    for index in 0..(point_count - 1) {
        let start = index * 3;
        let end = (index + 1) * 3;

        let x0 = points[start];
        let y0 = points[start + 1];
        let p0 = pressure_at(points[start + 2]);
        let x1 = points[end];
        let y1 = points[end + 1];
        let p1 = pressure_at(points[end + 2]);

        let dx = x1 - x0;
        let dy = y1 - y0;
        let distance = (dx * dx + dy * dy).sqrt();
        let steps = distance.max(1.0).ceil() as usize;

        for step in 0..=steps {
            let t = step as f32 / steps as f32;
            let x = x0 + dx * t;
            let y = y0 + dy * t;
            let pressure = p0 + (p1 - p0) * t;
            draw_disc(buffer, width, height, x, y, base_radius * pressure, color);
        }
    }
}

#[no_mangle]
pub extern "C" fn stroke_bounds(
    points_ptr: *const f32,
    point_count: usize,
    radius: f32,
    out_ptr: *mut f32,
) {
    if points_ptr.is_null() || out_ptr.is_null() || point_count == 0 {
        return;
    }

    let points = unsafe { slice::from_raw_parts(points_ptr, point_count.saturating_mul(3)) };
    let out = unsafe { slice::from_raw_parts_mut(out_ptr, 4) };

    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN;
    let mut max_y = f32::MIN;

    for point in points.chunks_exact(3) {
        min_x = min_x.min(point[0] - radius);
        min_y = min_y.min(point[1] - radius);
        max_x = max_x.max(point[0] + radius);
        max_y = max_y.max(point[1] + radius);
    }

    out[0] = min_x;
    out[1] = min_y;
    out[2] = max_x;
    out[3] = max_y;
}

#[derive(Clone, Copy)]
struct Color {
    r: u8,
    g: u8,
    b: u8,
    a: u8,
}

fn pressure_at(value: f32) -> f32 {
    value.clamp(0.25, 1.75)
}

fn draw_disc(
    buffer: &mut [u8],
    width: usize,
    height: usize,
    center_x: f32,
    center_y: f32,
    radius: f32,
    color: Color,
) {
    let radius = radius.max(0.5);
    let min_x = (center_x - radius).floor().max(0.0) as usize;
    let max_x = (center_x + radius).ceil().min((width - 1) as f32) as usize;
    let min_y = (center_y - radius).floor().max(0.0) as usize;
    let max_y = (center_y + radius).ceil().min((height - 1) as f32) as usize;
    let radius_sq = radius * radius;

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let dx = x as f32 + 0.5 - center_x;
            let dy = y as f32 + 0.5 - center_y;
            let distance_sq = dx * dx + dy * dy;

            if distance_sq > radius_sq {
                continue;
            }

            let edge = (radius - distance_sq.sqrt()).clamp(0.0, 1.0);
            let alpha = (color.a as f32 / 255.0) * edge;
            blend_pixel(buffer, width, x, y, color, alpha);
        }
    }
}

fn blend_pixel(buffer: &mut [u8], width: usize, x: usize, y: usize, color: Color, alpha: f32) {
    let offset = (y * width + x) * 4;
    let inverse = 1.0 - alpha;

    buffer[offset] = ((color.r as f32 * alpha) + (buffer[offset] as f32 * inverse)) as u8;
    buffer[offset + 1] = ((color.g as f32 * alpha) + (buffer[offset + 1] as f32 * inverse)) as u8;
    buffer[offset + 2] = ((color.b as f32 * alpha) + (buffer[offset + 2] as f32 * inverse)) as u8;
    buffer[offset + 3] = 255;
}
