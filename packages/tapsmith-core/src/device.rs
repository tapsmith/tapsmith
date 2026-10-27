use anyhow::{bail, Result};
use tracing::{debug, info, warn};

use crate::adb;
use crate::ios;
use crate::macos;
use crate::platform::Platform;

/// Connection state of a tracked device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    /// Device detected but not yet selected.
    Discovered,
    /// Device is the active target.
    Active,
    /// Device was previously active but has disconnected.
    Disconnected,
}

/// Information about a connected device (Android or iOS).
#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub serial: String,
    pub model: String,
    pub is_emulator: bool,
    pub state: ConnectionState,
    pub platform: Platform,
    /// Human-friendly OS version ("14", "18.1", "26.2.1"). Empty when unknown.
    /// Android: filled from `ro.build.version.release`. iOS sim: runtime
    /// version parsed from simctl. iOS physical: left blank here and filled
    /// CLI-side via devicectl (daemon has no cheap path).
    pub os_version: String,
}

/// An Android device adb lists but cannot use: unauthorized (the USB-debugging
/// prompt was not accepted), offline, `no permissions (…)` (Linux without udev
/// rules), or any other state but `device`. Reported by ListDevices so the user
/// is told it is there and why it cannot be used, but kept out of
/// [`DeviceManager`]'s device list so it can never be selected or auto-picked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnusableDevice {
    pub serial: String,
    /// adb's whole state string, e.g. `unauthorized` or `no permissions (…)`.
    pub state: String,
    /// The `model:` descriptor from `adb devices -l`; usually empty, since adb
    /// omits it for devices it cannot talk to.
    pub model: String,
    pub is_emulator: bool,
}

/// Split `adb devices` entries into usable devices and [`UnusableDevice`]s.
fn partition_adb_devices(
    adb_devices: Vec<adb::AdbDevice>,
) -> (Vec<adb::AdbDevice>, Vec<UnusableDevice>) {
    let (online, unusable): (Vec<_>, Vec<_>) = adb_devices.into_iter().partition(|d| d.is_online());
    let unusable = unusable
        .into_iter()
        .map(|d| UnusableDevice {
            is_emulator: d.is_emulator(),
            serial: d.serial,
            state: d.state,
            model: d.model,
        })
        .collect();
    (online, unusable)
}

/// "R5CR1234XYZ (unauthorized), emulator-5556 (offline)".
fn describe_unusable(devices: &[UnusableDevice]) -> String {
    devices
        .iter()
        .map(|d| format!("{} ({})", d.serial, d.state))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Manages the set of known devices and tracks the active device.
#[derive(Debug)]
pub struct DeviceManager {
    devices: Vec<DeviceInfo>,
    /// Android devices adb lists but cannot use, as of the last refresh. Never
    /// part of `devices`, so never selectable.
    unusable: Vec<UnusableDevice>,
    active_serial: Option<String>,
    /// When set, only discover devices of this platform.
    platform_filter: Option<Platform>,
}

impl DeviceManager {
    #[cfg(test)]
    pub fn new() -> Self {
        Self {
            devices: Vec::new(),
            unusable: Vec::new(),
            active_serial: None,
            platform_filter: None,
        }
    }

    /// Create a DeviceManager that only discovers devices of the given platform.
    pub fn with_platform_filter(platform: Option<Platform>) -> Self {
        Self {
            devices: Vec::new(),
            unusable: Vec::new(),
            active_serial: None,
            platform_filter: platform,
        }
    }

    /// Whether discovery should list devices of `platform`. With no filter
    /// that is Android and iOS only: the host Mac is always there, so listing
    /// it unasked would break single-device auto-pick (see `auto_pick`).
    fn wants(&self, platform: Platform) -> bool {
        match self.platform_filter {
            Some(filter) => filter == platform,
            None => platform != Platform::MacOs,
        }
    }

    /// Refresh the list of devices from ADB, iOS simulators/devices and, under
    /// `--platform macos`, the host Mac.
    pub async fn refresh(&mut self) -> Result<&[DeviceInfo]> {
        // Collect the serials of every device present, across the wanted platforms
        let mut current_serials: Vec<String> = Vec::new();
        let mut unusable: Vec<UnusableDevice> = Vec::new();

        // ─── Android devices via ADB ───
        if self.wants(Platform::Android) {
            if let Ok(adb_devices) = adb::list_devices().await {
                let (online, not_usable) = partition_adb_devices(adb_devices);
                unusable = not_usable;
                for adb_dev in &online {
                    current_serials.push(adb_dev.serial.clone());

                    if let Some(existing) =
                        self.devices.iter_mut().find(|d| d.serial == adb_dev.serial)
                    {
                        if existing.state == ConnectionState::Disconnected {
                            existing.state =
                                if self.active_serial.as_deref() == Some(&adb_dev.serial) {
                                    ConnectionState::Active
                                } else {
                                    ConnectionState::Discovered
                                };
                            debug!(serial = %existing.serial, "Device reconnected");
                        }
                    } else {
                        // Fetch model and OS version concurrently so a slow
                        // getprop call doesn't double the cost per new device.
                        let (model, os_version) = tokio::join!(
                            adb::get_device_model(&adb_dev.serial),
                            adb::get_device_os_version(&adb_dev.serial),
                        );
                        let model = model.unwrap_or_else(|_| "unknown".to_string());
                        let os_version = os_version.unwrap_or_default();

                        self.devices.push(DeviceInfo {
                            serial: adb_dev.serial.clone(),
                            model,
                            is_emulator: adb_dev.is_emulator(),
                            state: ConnectionState::Discovered,
                            platform: Platform::Android,
                            os_version,
                        });
                        debug!(serial = %adb_dev.serial, "New Android device discovered");
                    }
                }
            }
        }

        // ─── iOS devices via xcrun simctl / devicectl ───
        if self.wants(Platform::Ios) {
            // Surface listing errors instead of silently swallowing — a broken
            // simctl install or hung devicectl call would otherwise produce a
            // mysteriously empty device list with no clue why.
            let ios_devices = match ios::device::list_all_devices().await {
                Ok(devices) => devices,
                Err(e) => {
                    warn!(error = %e, "Failed to list iOS devices via simctl/devicectl");
                    Vec::new()
                }
            };
            for ios_dev in &ios_devices {
                if ios_dev.is_simulator && !ios_dev.is_booted() {
                    continue; // Only show booted simulators
                }
                current_serials.push(ios_dev.udid.clone());

                if let Some(existing) = self.devices.iter_mut().find(|d| d.serial == ios_dev.udid) {
                    if existing.state == ConnectionState::Disconnected {
                        existing.state = if self.active_serial.as_deref() == Some(&ios_dev.udid) {
                            ConnectionState::Active
                        } else {
                            ConnectionState::Discovered
                        };
                        debug!(serial = %existing.serial, "iOS device reconnected");
                    }
                } else {
                    self.devices.push(DeviceInfo {
                        serial: ios_dev.udid.clone(),
                        model: ios_dev.name.clone(),
                        is_emulator: ios_dev.is_simulator,
                        state: ConnectionState::Discovered,
                        platform: Platform::Ios,
                        os_version: ios_dev.os_version.clone(),
                    });
                    debug!(serial = %ios_dev.udid, name = %ios_dev.name, "New iOS device discovered");
                }
            }
        }

        // ─── This Mac (only when asked for: see `wants`) ───
        if self.wants(Platform::MacOs) {
            let serial = macos::device::HOST_SERIAL;
            if self.devices.iter().any(|d| d.serial == serial) {
                // The host never goes away; no need to re-read its model.
                current_serials.push(serial.to_string());
            } else {
                match macos::device::host_device().await {
                    Ok(host) => {
                        current_serials.push(host.serial.clone());
                        debug!(model = %host.model, "macOS host device discovered");
                        self.devices.push(host);
                    }
                    Err(e) => warn!(error = %e, "Failed to describe the macOS host device"),
                }
            }
        }

        // A device adb lists but cannot use is absent from `current_serials`,
        // so an active device that turns unauthorized or offline is marked
        // Disconnected below, exactly like one that was unplugged.
        self.unusable = unusable;
        self.mark_absent(&current_serials);

        Ok(&self.devices)
    }

    /// Mark tracked devices missing from `current_serials` as disconnected, and
    /// forget the disconnected ones that are not the active device.
    fn mark_absent(&mut self, current_serials: &[String]) {
        for device in &mut self.devices {
            if !current_serials.contains(&device.serial) {
                if device.state == ConnectionState::Active {
                    info!(serial = %device.serial, "Active device disconnected");
                }
                device.state = ConnectionState::Disconnected;
            }
        }

        // Remove long-gone disconnected devices that aren't active
        self.devices.retain(|d| {
            d.state != ConnectionState::Disconnected
                || self.active_serial.as_deref() == Some(&d.serial)
        });
    }

    /// Set the active device by serial.
    pub fn set_active(&mut self, serial: &str) -> Result<()> {
        // Checked first: an active device that turned unauthorized is still in
        // `devices` (kept as Disconnected), and must not be made Active again.
        // The SDK retries device selection on "is attached but not usable"
        // (worker-protocol.ts isRetryableDeviceSelectionError) — keep the text.
        // A present, usable device with the same serial wins: cheap phones can
        // share one (`0123456789ABCDEF`), and adb lists each transport.
        let usable_present = self
            .devices
            .iter()
            .any(|d| d.serial == serial && d.state != ConnectionState::Disconnected);
        if let Some(unusable) = self
            .unusable
            .iter()
            .find(|d| d.serial == serial && !usable_present)
        {
            bail!(
                "Device {serial} is attached but not usable: adb reports it \"{}\". \
                 Run `tapsmith list-devices` to see how to fix it.",
                unusable.state
            );
        }
        let device = self.devices.iter_mut().find(|d| d.serial == serial);

        match device {
            Some(_) => {
                // Deactivate the current device
                if let Some(ref prev) = self.active_serial {
                    if let Some(prev_dev) = self.devices.iter_mut().find(|d| &d.serial == prev) {
                        prev_dev.state = ConnectionState::Discovered;
                    }
                }

                self.active_serial = Some(serial.to_string());
                if let Some(dev) = self.devices.iter_mut().find(|d| d.serial == serial) {
                    dev.state = ConnectionState::Active;
                }
                info!(serial, "Device set as active");
                Ok(())
            }
            None => {
                bail!(
                    "Device {serial} not found. Run ListDevices first to refresh the device list."
                );
            }
        }
    }

    /// Get the serial of the active device, if any.
    pub fn active_serial(&self) -> Option<&str> {
        self.active_serial.as_deref()
    }

    /// Get the active device info.
    #[allow(dead_code)]
    pub fn active_device(&self) -> Option<&DeviceInfo> {
        self.active_serial
            .as_ref()
            .and_then(|s| self.devices.iter().find(|d| &d.serial == s))
    }

    /// Get all known devices.
    pub fn devices(&self) -> &[DeviceInfo] {
        &self.devices
    }

    /// Android devices adb listed but cannot use, as of the last refresh.
    pub fn unusable_devices(&self) -> &[UnusableDevice] {
        &self.unusable
    }

    /// Add a device directly (for testing purposes).
    #[cfg(test)]
    pub(crate) fn add_device(&mut self, info: DeviceInfo) {
        self.devices.push(info);
    }

    /// Resolve the device serial to use for an operation.
    /// Returns the active device serial, or if there's exactly one device, auto-selects it.
    pub async fn resolve_serial(&mut self) -> Result<String> {
        if let Some(serial) = &self.active_serial {
            return Ok(serial.clone());
        }

        self.refresh().await?;
        self.auto_pick()
    }

    /// Select the only usable device, or explain why there is not exactly one.
    /// Unusable devices are never candidates, only named when nothing else is.
    fn auto_pick(&mut self) -> Result<String> {
        let online: Vec<_> = self
            .devices
            .iter()
            .filter(|d| d.state != ConnectionState::Disconnected)
            .collect();

        match online.len() {
            0 if self.unusable.is_empty() => {
                bail!("No devices connected. Connect a device or start an emulator.")
            }
            0 => bail!(
                "No usable devices connected. Attached but not usable: {}. \
                 Run `tapsmith list-devices` to see how to fix each.",
                describe_unusable(&self.unusable)
            ),
            1 => {
                let serial = online[0].serial.clone();
                self.set_active(&serial)?;
                info!(serial = %serial, "Auto-selected the only connected device");
                Ok(serial)
            }
            n => {
                bail!("{n} devices connected but none selected. Use SetDevice to choose one.");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_device(serial: &str, state: ConnectionState) -> DeviceInfo {
        DeviceInfo {
            serial: serial.to_string(),
            model: "TestModel".to_string(),
            is_emulator: serial.starts_with("emulator-"),
            state,
            platform: Platform::Android,
            os_version: String::new(),
        }
    }

    #[test]
    fn macos_filter_wants_only_macos() {
        let dm = DeviceManager::with_platform_filter(Some(Platform::MacOs));
        assert!(!dm.wants(Platform::Android));
        assert!(!dm.wants(Platform::Ios));
        assert!(dm.wants(Platform::MacOs));
    }

    #[test]
    fn no_filter_never_wants_macos() {
        // The host Mac is always present, so listing it unasked would turn
        // every single-device auto-pick into "2 devices connected".
        let dm = DeviceManager::with_platform_filter(None);
        assert!(dm.wants(Platform::Android));
        assert!(dm.wants(Platform::Ios));
        assert!(!dm.wants(Platform::MacOs));
    }

    #[test]
    fn ios_filter_wants_only_ios() {
        let dm = DeviceManager::with_platform_filter(Some(Platform::Ios));
        assert!(!dm.wants(Platform::Android));
        assert!(dm.wants(Platform::Ios));
        assert!(!dm.wants(Platform::MacOs));
    }

    #[test]
    fn new_manager_has_no_devices() {
        let dm = DeviceManager::new();
        assert!(dm.devices().is_empty());
        assert!(dm.active_serial().is_none());
        assert!(dm.active_device().is_none());
    }

    #[test]
    fn set_active_unknown_device_returns_error() {
        let mut dm = DeviceManager::new();
        let result = dm.set_active("nonexistent-serial");
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("not found"),
            "Error should mention 'not found': {msg}"
        );
    }

    #[test]
    fn set_active_known_device_succeeds() {
        let mut dm = DeviceManager::new();
        dm.add_device(make_device("ABC123", ConnectionState::Discovered));
        dm.add_device(make_device("DEF456", ConnectionState::Discovered));

        let result = dm.set_active("DEF456");
        assert!(result.is_ok());
        assert_eq!(dm.active_serial(), Some("DEF456"));

        let active = dm.active_device().unwrap();
        assert_eq!(active.serial, "DEF456");
        assert_eq!(active.state, ConnectionState::Active);
    }

    #[test]
    fn set_active_deactivates_previous() {
        let mut dm = DeviceManager::new();
        dm.add_device(make_device("dev-1", ConnectionState::Discovered));
        dm.add_device(make_device("dev-2", ConnectionState::Discovered));

        dm.set_active("dev-1").unwrap();
        assert_eq!(dm.active_serial(), Some("dev-1"));

        dm.set_active("dev-2").unwrap();
        assert_eq!(dm.active_serial(), Some("dev-2"));

        // dev-1 should be back to Discovered
        let dev1 = dm.devices().iter().find(|d| d.serial == "dev-1").unwrap();
        assert_eq!(dev1.state, ConnectionState::Discovered);

        let dev2 = dm.devices().iter().find(|d| d.serial == "dev-2").unwrap();
        assert_eq!(dev2.state, ConnectionState::Active);
    }

    #[test]
    fn devices_returns_correct_list() {
        let mut dm = DeviceManager::new();
        assert_eq!(dm.devices().len(), 0);

        dm.add_device(make_device("emulator-5554", ConnectionState::Discovered));
        dm.add_device(make_device("HVA123", ConnectionState::Discovered));
        assert_eq!(dm.devices().len(), 2);

        let serials: Vec<&str> = dm.devices().iter().map(|d| d.serial.as_str()).collect();
        assert!(serials.contains(&"emulator-5554"));
        assert!(serials.contains(&"HVA123"));
    }

    #[test]
    fn connection_state_equality() {
        assert_eq!(ConnectionState::Discovered, ConnectionState::Discovered);
        assert_eq!(ConnectionState::Active, ConnectionState::Active);
        assert_eq!(ConnectionState::Disconnected, ConnectionState::Disconnected);
        assert_ne!(ConnectionState::Discovered, ConnectionState::Active);
        assert_ne!(ConnectionState::Active, ConnectionState::Disconnected);
    }

    fn unusable(serial: &str, state: &str) -> UnusableDevice {
        UnusableDevice {
            serial: serial.to_string(),
            state: state.to_string(),
            model: String::new(),
            is_emulator: serial.starts_with("emulator-"),
        }
    }

    fn adb_dev(serial: &str, state: &str) -> adb::AdbDevice {
        adb::AdbDevice {
            serial: serial.to_string(),
            state: state.to_string(),
            model: String::new(),
        }
    }

    #[test]
    fn partition_keeps_non_online_devices_with_their_whole_state() {
        let (online, unusable_devs) = partition_adb_devices(vec![
            adb_dev("emulator-5554", "device"),
            adb_dev("R5CR1234XYZ", "unauthorized"),
            adb_dev("emulator-5556", "offline"),
            adb_dev(
                "0123ABCD",
                "no permissions (missing udev rules?); see [http://x]",
            ),
        ]);
        let online: Vec<&str> = online.iter().map(|d| d.serial.as_str()).collect();
        assert_eq!(online, vec!["emulator-5554"]);
        assert_eq!(
            unusable_devs,
            vec![
                unusable("R5CR1234XYZ", "unauthorized"),
                unusable("emulator-5556", "offline"),
                unusable(
                    "0123ABCD",
                    "no permissions (missing udev rules?); see [http://x]"
                ),
            ]
        );
    }

    #[test]
    fn auto_pick_ignores_unusable_devices_beside_a_usable_one() {
        let mut dm = DeviceManager::new();
        dm.add_device(make_device("emulator-5554", ConnectionState::Discovered));
        dm.unusable = vec![unusable("R5CR1234XYZ", "unauthorized")];
        assert_eq!(dm.auto_pick().unwrap(), "emulator-5554");
        assert_eq!(dm.active_serial(), Some("emulator-5554"));
    }

    #[test]
    fn auto_pick_never_selects_an_unusable_device_and_names_it() {
        let mut dm = DeviceManager::new();
        dm.unusable = vec![
            unusable("R5CR1234XYZ", "unauthorized"),
            unusable("emulator-5556", "offline"),
        ];
        let msg = dm.auto_pick().unwrap_err().to_string();
        assert!(dm.active_serial().is_none());
        assert!(msg.contains("R5CR1234XYZ (unauthorized)"), "{msg}");
        assert!(msg.contains("emulator-5556 (offline)"), "{msg}");
        assert!(msg.contains("tapsmith list-devices"), "{msg}");
    }

    #[test]
    fn auto_pick_with_nothing_attached_keeps_the_plain_message() {
        let mut dm = DeviceManager::new();
        let msg = dm.auto_pick().unwrap_err().to_string();
        assert!(msg.contains("No devices connected"), "{msg}");
    }

    #[test]
    fn set_active_refuses_an_unusable_device_naming_its_state() {
        let mut dm = DeviceManager::new();
        dm.unusable = vec![unusable("R5CR1234XYZ", "unauthorized")];
        let msg = dm.set_active("R5CR1234XYZ").unwrap_err().to_string();
        // The SDK retries on this exact phrase (worker-protocol.ts).
        assert!(msg.contains("is attached but not usable"), "{msg}");
        assert!(msg.contains("\"unauthorized\""), "{msg}");
        assert!(dm.active_serial().is_none());
        assert!(dm.devices().is_empty());
    }

    #[test]
    fn a_usable_device_sharing_its_serial_with_an_unusable_one_can_be_selected() {
        let mut dm = DeviceManager::new();
        dm.add_device(make_device("0123456789ABCDEF", ConnectionState::Discovered));
        dm.unusable = vec![unusable("0123456789ABCDEF", "unauthorized")];
        dm.set_active("0123456789ABCDEF").unwrap();
        assert_eq!(dm.active_device().unwrap().state, ConnectionState::Active);
    }

    #[test]
    fn active_device_turning_unauthorized_is_disconnected_not_dropped() {
        let mut dm = DeviceManager::new();
        dm.add_device(make_device("HT123", ConnectionState::Discovered));
        dm.add_device(make_device("HT456", ConnectionState::Discovered));
        dm.set_active("HT123").unwrap();

        // Next refresh: adb lists HT123 as unauthorized, HT456 is unplugged.
        dm.unusable = vec![unusable("HT123", "unauthorized")];
        dm.mark_absent(&[]);

        let dev = dm.active_device().expect("the active device stays tracked");
        assert_eq!(dev.state, ConnectionState::Disconnected);
        assert_eq!(dm.active_serial(), Some("HT123"));
        // The inactive one is forgotten, as before.
        assert_eq!(dm.devices().len(), 1);
        assert_eq!(dm.unusable_devices()[0].serial, "HT123");

        // Selecting it again is refused, rather than reviving the stale entry.
        let msg = dm.set_active("HT123").unwrap_err().to_string();
        assert!(msg.contains("not usable"), "{msg}");
        assert_eq!(
            dm.active_device().unwrap().state,
            ConnectionState::Disconnected
        );
    }

    #[test]
    fn active_device_returns_none_when_no_active() {
        let mut dm = DeviceManager::new();
        dm.add_device(make_device("dev-1", ConnectionState::Discovered));
        assert!(dm.active_device().is_none());
    }
}
