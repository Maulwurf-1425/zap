use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Errors crossing the IPC boundary. The UI maps `code` to localized copy,
/// so `message` is only for debugging and never shown verbatim.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("model server is not reachable")]
    Unreachable,
    #[error("model not found: {0}")]
    ModelNotFound(String),
    #[error("disk full")]
    DiskFull,
    #[error("cancelled")]
    Cancelled,
    #[error("invalid file: {0}")]
    InvalidFile(String),
    #[error("not supported by this provider")]
    Unsupported,
    /// The model wrote a tool call the server could not parse.
    #[error("invalid tool call format: {0}")]
    ToolFormat(String),
    #[error("provider: {0}")]
    Provider(String),
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("http: {0}")]
    Http(reqwest::Error),
    #[error("{0}")]
    Other(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Unreachable => "provider_unreachable",
            AppError::ModelNotFound(_) => "model_not_found",
            AppError::DiskFull => "disk_full",
            AppError::Cancelled => "cancelled",
            AppError::InvalidFile(_) => "invalid_file",
            AppError::Unsupported => "unsupported",
            AppError::ToolFormat(_) => "tool_format",
            AppError::Provider(_) | AppError::Http(_) => "provider_error",
            AppError::Db(_) | AppError::Other(_) => "generic",
        }
    }

    /// Turns a provider error message (Ollama or LM Studio) into a typed error.
    pub fn from_provider_message(msg: &str) -> Self {
        let lower = msg.to_lowercase();
        if lower.contains("no space left")
            || lower.contains("not enough space")
            || lower.contains("disk full")
        {
            AppError::DiskFull
        } else if lower.contains("does not match the expected")
            || lower.contains("failed to parse tool")
            || lower.contains("tool call") && lower.contains("parse")
        {
            AppError::ToolFormat(msg.to_string())
        } else if lower.contains("not found")
            || lower.contains("file does not exist")
            || lower.contains("does not exist")
            || lower.contains("no models loaded")
            || lower.contains("model_not_found")
        {
            AppError::ModelNotFound(msg.to_string())
        } else {
            AppError::Provider(msg.to_string())
        }
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_connect() || err.is_timeout() || err.is_body() || err.is_decode() {
            // Not reachable, or the connection dropped mid-stream.
            AppError::Unreachable
        } else {
            AppError::Http(err)
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        // ERROR_HANDLE_DISK_FULL (39), ERROR_DISK_FULL (112), ENOSPC (28)
        match err.raw_os_error() {
            Some(39 | 112) if cfg!(windows) => AppError::DiskFull,
            Some(28) if cfg!(unix) => AppError::DiskFull,
            _ => AppError::Other(format!("io: {}", err.kind())),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_provider_messages() {
        let lm = "Engine protocol predict stream returned an error: The model produced output that does not match the expected peg-native format";
        assert_eq!(AppError::from_provider_message(lm).code(), "tool_format");
        assert_eq!(
            AppError::from_provider_message("model 'x' not found").code(),
            "model_not_found"
        );
        assert_eq!(
            AppError::from_provider_message("no space left on device").code(),
            "disk_full"
        );
    }
}
