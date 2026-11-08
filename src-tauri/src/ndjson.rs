//! Incremental line decoding for streamed HTTP bodies: NDJSON (Ollama) and
//! Server-Sent Events (OpenAI-compatible servers such as LM Studio).
//!
//! HTTP chunks can split a line anywhere, including in the middle of a
//! multi-byte UTF-8 sequence. We therefore buffer raw bytes and only decode
//! once a full line (terminated by `\n`) is available.

use serde::de::DeserializeOwned;

/// Splits a byte stream into complete lines (without `\n` / `\r\n`).
#[derive(Default)]
pub struct LineDecoder {
    buf: Vec<u8>,
}

impl LineDecoder {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(4096),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut start = 0;
        while let Some(rel) = self.buf[start..].iter().position(|b| *b == b'\n') {
            let end = start + rel;
            out.push(trim_cr(&self.buf[start..end]).to_vec());
            start = end + 1;
        }
        self.buf.drain(..start);
        out
    }

    /// The final line if the stream ended without a trailing newline.
    pub fn finish(&mut self) -> Option<Vec<u8>> {
        let rest = std::mem::take(&mut self.buf);
        let line = trim_cr(&rest);
        (!line.is_empty()).then(|| line.to_vec())
    }
}

fn trim_cr(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// Newline-delimited JSON. Lines that are not valid `T` are skipped.
#[derive(Default)]
pub struct NdjsonDecoder {
    lines: LineDecoder,
}

impl NdjsonDecoder {
    pub fn new() -> Self {
        Self {
            lines: LineDecoder::new(),
        }
    }

    pub fn push<T: DeserializeOwned>(&mut self, chunk: &[u8]) -> Vec<T> {
        self.lines
            .push(chunk)
            .into_iter()
            .filter(|l| !l.is_empty())
            .filter_map(|l| serde_json::from_slice(&l).ok())
            .collect()
    }

    pub fn finish<T: DeserializeOwned>(&mut self) -> Option<T> {
        self.lines
            .finish()
            .and_then(|l| serde_json::from_slice(&l).ok())
    }
}

#[derive(Debug, PartialEq)]
pub enum SseEvent<T> {
    Data(T),
    /// `data: [DONE]`, the OpenAI end-of-stream marker.
    Done,
}

/// Server-Sent Events carrying JSON in `data:` lines. Comments, `event:`
/// and `id:` lines are ignored, as are payloads that are not valid `T`.
#[derive(Default)]
pub struct SseDecoder {
    lines: LineDecoder,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self {
            lines: LineDecoder::new(),
        }
    }

    pub fn push<T: DeserializeOwned>(&mut self, chunk: &[u8]) -> Vec<SseEvent<T>> {
        self.lines
            .push(chunk)
            .iter()
            .filter_map(|l| parse_sse_line(l))
            .collect()
    }

    pub fn finish<T: DeserializeOwned>(&mut self) -> Option<SseEvent<T>> {
        self.lines.finish().and_then(|l| parse_sse_line(&l))
    }
}

fn parse_sse_line<T: DeserializeOwned>(line: &[u8]) -> Option<SseEvent<T>> {
    let payload = line.strip_prefix(b"data:")?;
    let payload = payload.strip_prefix(b" ").unwrap_or(payload);
    if payload == b"[DONE]" {
        return Some(SseEvent::Done);
    }
    serde_json::from_slice(payload).ok().map(SseEvent::Data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Line {
        content: Option<String>,
        error: Option<String>,
    }

    fn line(content: &str) -> Line {
        Line {
            content: Some(content.into()),
            error: None,
        }
    }

    #[test]
    fn splits_complete_lines_and_keeps_rest() {
        let mut d = NdjsonDecoder::new();
        let out: Vec<Line> = d.push(b"{\"content\":\"a\"}\r\n{\"content\":\"b\"}\n{\"cont");
        assert_eq!(out, vec![line("a"), line("b")]);
        let out: Vec<Line> = d.push(b"ent\":\"c\"}\n");
        assert_eq!(out, vec![line("c")]);
    }

    #[test]
    fn line_split_across_many_chunks() {
        let mut d = NdjsonDecoder::new();
        let raw = b"{\"content\":\"hello world\"}\n";
        let mut got: Vec<Line> = Vec::new();
        for byte in raw.iter() {
            got.extend(d.push::<Line>(std::slice::from_ref(byte)));
        }
        assert_eq!(got, vec![line("hello world")]);
    }

    #[test]
    fn unicode_split_inside_codepoint() {
        let raw = "{\"content\":\"Grüße ⚡ 日本\"}\n".as_bytes();
        // Split inside the 3-byte "⚡" sequence.
        let cut = raw.iter().position(|b| *b == 0xE2).unwrap() + 1;
        let mut d = NdjsonDecoder::new();
        let first: Vec<Line> = d.push(&raw[..cut]);
        assert!(first.is_empty());
        let second: Vec<Line> = d.push(&raw[cut..]);
        assert_eq!(second, vec![line("Grüße ⚡ 日本")]);
    }

    #[test]
    fn error_lines_are_parsed() {
        let mut d = NdjsonDecoder::new();
        let out: Vec<Line> = d.push(b"{\"error\":\"model 'x' not found\"}\n");
        assert_eq!(out[0].error.as_deref(), Some("model 'x' not found"));
    }

    #[test]
    fn invalid_lines_are_skipped() {
        let mut d = NdjsonDecoder::new();
        let out: Vec<Line> = d.push(b"not json\n\n{\"content\":\"ok\"}\n");
        assert_eq!(out, vec![line("ok")]);
    }

    #[test]
    fn finish_returns_trailing_line() {
        let mut d = NdjsonDecoder::new();
        let none: Vec<Line> = d.push(b"{\"content\":\"tail\"}");
        assert!(none.is_empty());
        assert_eq!(d.finish::<Line>(), Some(line("tail")));
        assert_eq!(d.finish::<Line>(), None);
    }

    #[test]
    fn sse_data_lines_and_done() {
        let mut d = SseDecoder::new();
        let raw = b": keep-alive\nevent: message\ndata: {\"content\":\"a\"}\n\ndata:{\"content\":\"b\"}\r\n\r\ndata: [DONE]\n\n";
        let out: Vec<SseEvent<Line>> = d.push(raw);
        assert_eq!(
            out,
            vec![
                SseEvent::Data(line("a")),
                SseEvent::Data(line("b")),
                SseEvent::Done
            ]
        );
    }

    #[test]
    fn sse_split_inside_codepoint() {
        let raw = "data: {\"content\":\"Süß ⚡\"}\n\n".as_bytes();
        let cut = raw.iter().position(|b| *b == 0xC3).unwrap() + 1;
        let mut d = SseDecoder::new();
        assert!(d.push::<Line>(&raw[..cut]).is_empty());
        assert_eq!(
            d.push::<Line>(&raw[cut..]),
            vec![SseEvent::Data(line("Süß ⚡"))]
        );
    }
}
