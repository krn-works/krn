package reset

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

type State struct {
	Generation      uint64   `json:"generation"`
	Phase           string   `json:"phase"`
	RequestID       string   `json:"request_id"`
	ManifestSHA256  string   `json:"manifest_sha256"`
	LastBootID      string   `json:"last_boot_id"`
	LastAttemptUnix int64    `json:"last_attempt_unix"`
	Receipt         *Receipt `json:"receipt"`
}

type Store struct{ Directory string }

func (s Store) Lock() (func(), error) {
	if err := os.MkdirAll(s.Directory, 0700); err != nil {
		return nil, err
	}
	fd, err := syscall.Open(filepath.Join(s.Directory, "reset.lock"), syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		syscall.Close(fd)
		return nil, failure("RESET_BUSY")
	}
	return func() { _ = syscall.Close(fd) }, nil
}

func (s Store) Load() (State, error) {
	state := State{Phase: "blocked"}
	fd, err := syscall.Open(filepath.Join(s.Directory, "state.json"), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, failure("UNREADABLE_LEDGER")
	}
	file := os.NewFile(uintptr(fd), "state.json")
	defer file.Close()
	metadata, err := file.Stat()
	if err != nil || metadata.Size() > 65536 {
		return state, failure("UNREADABLE_LEDGER")
	}
	data := make([]byte, metadata.Size())
	if _, err = file.ReadAt(data, 0); err != nil {
		return state, failure("UNREADABLE_LEDGER")
	}
	if err = decodeStrict(data, &state); err != nil {
		return state, failure("CORRUPT_LEDGER")
	}
	if state.Phase != "blocked" && state.Phase != "ready" && state.Phase != "resetting" {
		return state, failure("CORRUPT_LEDGER")
	}
	if state.Generation > 0 && (!uuidPattern.MatchString(state.RequestID) || !hashPattern.MatchString(state.ManifestSHA256)) {
		return state, failure("CORRUPT_LEDGER")
	}
	if state.LastBootID != "" && !uuidPattern.MatchString(state.LastBootID) {
		return state, failure("CORRUPT_LEDGER")
	}
	if state.Phase == "ready" && (state.Receipt == nil || !state.Receipt.OK || state.Receipt.Generation != state.Generation || state.Receipt.RequestID != state.RequestID || state.Receipt.ManifestSHA256 != state.ManifestSHA256 || state.Receipt.BootID != state.LastBootID) {
		return state, failure("CORRUPT_LEDGER")
	}
	return state, nil
}

func (s Store) Save(state State) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(s.Directory, ".state-")
	if err != nil {
		return err
	}
	path := file.Name()
	defer os.Remove(path)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(append(data, '\n'))
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(path, filepath.Join(s.Directory, "state.json")); err != nil {
		return err
	}
	dir, err := os.Open(s.Directory)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
