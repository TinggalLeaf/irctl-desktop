mod hardware;

use hardware::{
    ir_close, ir_detect, ir_erase_all, ir_learn_cancel, ir_learn_start, ir_open, ir_read_slot,
    ir_scene_power_on_query, ir_scene_query, ir_scene_run, ir_scene_set, ir_scene_set_power_on,
    ir_scene_stop, ir_test, ir_transmit_blob, ir_transmit_slot, ir_write_slot, list_serial_ports,
    SerialManager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SerialManager::new())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            ir_detect,
            ir_open,
            ir_close,
            ir_test,
            ir_learn_start,
            ir_learn_cancel,
            ir_transmit_slot,
            ir_read_slot,
            ir_write_slot,
            ir_transmit_blob,
            ir_erase_all,
            ir_scene_set,
            ir_scene_query,
            ir_scene_set_power_on,
            ir_scene_power_on_query,
            ir_scene_run,
            ir_scene_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
