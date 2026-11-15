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
fn test_clause_1_downcast_ref_align_64() {
    let error = Error::new(BigAlign(7));
    assert_eq!(7, error.downcast_ref::<BigAlign>().unwrap().0);
}

#[test]
fn test_clause_2_downcast_mut_display_drop_align_64() {
    let mut error = Error::new(BigAlign(7));
    assert_eq!("big 7", error.to_string());
    error.downcast_mut::<BigAlign>().unwrap().0 = 9;
    assert_eq!("big 9", error.to_string());
    assert_eq!(9, error.downcast::<BigAlign>().unwrap().0);
}

#[test]
fn test_clause_3_downcast_owned_align_64() {
    let error = Error::new(BigAlign(3));
    assert_eq!(3, error.downcast::<BigAlign>().unwrap().0);
}

// Clauses 4-7 are doc comments, not call sites: they need no change.
#[test]
fn test_clause_4_5_6_7_unaffected_io_error_downcast() {
    let error = bail_error().unwrap_err();
    assert!(error.downcast_ref::<io::Error>().is_some());
}
