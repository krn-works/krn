mod common;
mod drop;

use self::common::*;
use self::drop::DetectDrop;
use anyhow::Error;
use std::io;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering::SeqCst;
use std::sync::Arc;

#[test]
fn test_downcast() {
    assert_eq!(
        "oh no!",
        bail_literal().unwrap_err().downcast::<&str>().unwrap(),
    );
    assert_eq!(
        "oh no!",
        bail_fmt().unwrap_err().downcast::<String>().unwrap(),
    );
    assert_eq!(
        "oh no!",
        bail_error()
            .unwrap_err()
            .downcast::<io::Error>()
            .unwrap()
            .to_string(),
    );
}

#[test]
fn test_downcast_ref() {
    assert_eq!(
        "oh no!",
        *bail_literal().unwrap_err().downcast_ref::<&str>().unwrap(),
    );
    assert_eq!(
        "oh no!",
        bail_fmt().unwrap_err().downcast_ref::<String>().unwrap(),
    );
    assert_eq!(
        "oh no!",
        bail_error()
            .unwrap_err()
            .downcast_ref::<io::Error>()
            .unwrap()
            .to_string(),
    );
}

#[test]
fn test_downcast_mut() {
    assert_eq!(
        "oh no!",
        *bail_literal().unwrap_err().downcast_mut::<&str>().unwrap(),
    );
    assert_eq!(
        "oh no!",
        bail_fmt().unwrap_err().downcast_mut::<String>().unwrap(),
    );
    assert_eq!(
        "oh no!",
        bail_error()
            .unwrap_err()
            .downcast_mut::<io::Error>()
            .unwrap()
            .to_string(),
    );
}

#[test]
fn test_drop() {
    let has_dropped = Arc::new(AtomicBool::new(false));
    let error = Error::new(DetectDrop::new(&has_dropped));
    drop(error.downcast::<DetectDrop>().unwrap());
    assert!(has_dropped.load(SeqCst));
}

#[repr(align(64))]
#[derive(Debug)]
struct BigAlign(u8);

impl std::fmt::Display for BigAlign {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "big {}", self.0)
    }
}

impl std::error::Error for BigAlign {}

#[test]
fn test_clause_1_downcast_ref_large_alignment() {
    let mut error = Error::new(BigAlign(7));
    assert_eq!("big 7", error.to_string());
    let r = error.downcast_ref::<BigAlign>().unwrap();
    assert_eq!(0, r as *const BigAlign as usize % 64);
    assert_eq!(7, r.0);
    error.downcast_mut::<BigAlign>().unwrap().0 = 9;
    assert_eq!("big 9", format!("{}", error));
    assert_eq!(9, error.downcast::<BigAlign>().unwrap().0);
}

#[test]
fn test_clause_2_large_alignment_behaviour_unchanged() {
    let error = Error::new(BigAlign(3));
    assert_eq!("big 3", error.to_string());
    assert_eq!(3, error.downcast::<BigAlign>().unwrap().0);
}

fn assert_context_path() {
    let error = Error::new(BigAlign(1)).context("ctx");
    assert_eq!("ctx", error.to_string());
    assert_eq!(1, error.root_cause().downcast_ref::<BigAlign>().unwrap().0);
}

#[test]
fn test_clause_4_root_cause_large_alignment() {
    assert_context_path();
}

#[test]
fn test_clause_5_root_cause_large_alignment() {
    assert_context_path();
}

#[test]
fn test_clause_6_context_large_alignment() {
    assert_context_path();
}

#[test]
fn test_clause_7_large_alignment() {
    assert_eq!(
        5,
        Error::new(BigAlign(5))
            .downcast_ref::<BigAlign>()
            .unwrap()
            .0
    );
}

#[test]
fn test_clause_3_downcast_mut_large_alignment() {
    let mut error = Error::new(BigAlign(2));
    error.downcast_mut::<BigAlign>().unwrap().0 = 4;
    assert_eq!(4, error.downcast_ref::<BigAlign>().unwrap().0);
}

#[derive(Debug)]
struct ZeroSized;

impl std::fmt::Display for ZeroSized {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "")
    }
}

impl std::error::Error for ZeroSized {}

#[test]
fn test_clause_2_zero_sized_error_edge_case() {
    // Edge case: a zero-sized error, downcast repeatedly, plus a wrong type.
    let error = Error::new(ZeroSized);
    assert_eq!("", error.to_string());
    assert!(error.downcast_ref::<ZeroSized>().is_some());
    assert!(error.downcast_ref::<ZeroSized>().is_some());
    assert!(error.downcast_ref::<BigAlign>().is_none());
    assert!(error.downcast::<ZeroSized>().is_ok());
}
