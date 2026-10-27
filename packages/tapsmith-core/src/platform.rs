/// Target platform for a connected device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Android,
    Ios,
    /// The Mac the daemon runs on (host-local, never discovered unasked).
    MacOs,
}

impl Platform {
    pub fn as_str(&self) -> &'static str {
        match self {
            Platform::Android => "android",
            Platform::Ios => "ios",
            Platform::MacOs => "macos",
        }
    }
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_as_str() {
        assert_eq!(Platform::MacOs.as_str(), "macos");
        assert_eq!(Platform::MacOs.to_string(), "macos");
    }
}
