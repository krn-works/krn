package reset

import (
	"context"
	"math"
	"time"
)

type Backend interface {
	CheckHost(context.Context) error
	Configuration(context.Context, bool) (map[string]string, error)
	CheckHA(context.Context) error
	CheckPolicy(context.Context) error
	Rollback(context.Context) error
	Stopped(context.Context) (bool, error)
	Start(context.Context) error
	Stop(context.Context) error
	BootID(context.Context) (string, error)
}

type Receipt struct {
	SchemaVersion  int    `json:"schema_version"`
	OK             bool   `json:"ok"`
	Phase          string `json:"phase"`
	InstallationID string `json:"installation_id,omitempty"`
	VMID           int    `json:"vmid,omitempty"`
	RequestID      string `json:"request_id,omitempty"`
	Generation     uint64 `json:"generation"`
	ManifestSHA256 string `json:"manifest_sha256,omitempty"`
	BootID         string `json:"boot_id,omitempty"`
	SnapshotSHA256 string `json:"snapshot_sha256,omitempty"`
	PolicySHA256   string `json:"policy_sha256,omitempty"`
	CompletedAt    string `json:"completed_at,omitempty"`
	Error          string `json:"error,omitempty"`
	RunnerStopped  bool   `json:"runner_stopped,omitempty"`
}

type Service struct {
	Manifest Manifest
	Store    Store
	Backend  Backend
	Now      func() time.Time
}

func (s Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Execute never allocates a VM or runs job code. A receipt belongs to exactly
// one upstream attempt (RequestID), not to a later job. An uncertain attempt
// cannot be replayed as ready; a new reset must acknowledge its generation.
func (s Service) Execute(ctx context.Context, request Request) (Receipt, error) {
	if err := s.Manifest.Validate(); err != nil {
		return Receipt{}, err
	}
	if !uuidPattern.MatchString(request.RequestID) || request.ManifestSHA256 != s.Manifest.Digest() {
		return Receipt{}, failure("REQUEST_MANIFEST_MISMATCH")
	}
	unlock, err := s.Store.Lock()
	if err != nil {
		return Receipt{}, err
	}
	defer unlock()
	state, err := s.Store.Load()
	if err != nil {
		return Receipt{}, err
	}
	rejected := func(code string) (Receipt, error) {
		return Receipt{SchemaVersion: 1, OK: false, Phase: "blocked", Generation: state.Generation, Error: code}, failure(code)
	}
	if request.RequestID == state.RequestID {
		if state.Phase != "ready" || state.Receipt == nil {
			return rejected("REQUEST_NOT_COMMITTED")
		}
		if request.ExpectedGeneration == math.MaxUint64 || request.ExpectedGeneration+1 != state.Generation || request.ManifestSHA256 != state.ManifestSHA256 {
			return rejected("REQUEST_REPLAY_MISMATCH")
		}
		return *state.Receipt, nil
	}
	if request.ExpectedGeneration != state.Generation {
		return rejected("STALE_GENERATION")
	}
	if state.Generation == math.MaxUint64 {
		return rejected("GENERATION_EXHAUSTED")
	}
	now := s.now()
	if state.LastAttemptUnix != 0 && now.Unix()-state.LastAttemptUnix < int64(s.Manifest.MinResetIntervalSeconds) {
		return rejected("RESET_RATE_LIMIT")
	}
	previousBoot := state.LastBootID
	state.Generation++
	state.Phase = "resetting"
	state.RequestID = request.RequestID
	state.ManifestSHA256 = request.ManifestSHA256
	state.LastAttemptUnix = now.Unix()
	state.Receipt = nil
	if err := s.Store.Save(state); err != nil {
		return Receipt{}, err
	} // durable before effects
	identityVerified := false
	quarantine := func(cause error) (Receipt, error) {
		stopped := false
		if identityVerified {
			stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if stopErr := s.Backend.Stop(stopCtx); stopErr == nil {
				stopped, _ = s.Backend.Stopped(stopCtx)
			}
			cancel()
		}
		state.Phase = "blocked"
		state.Receipt = nil
		if saveErr := s.Store.Save(state); saveErr != nil {
			return Receipt{}, saveErr
		}
		return Receipt{SchemaVersion: 1, OK: false, Phase: "blocked", RequestID: request.RequestID, Generation: state.Generation, Error: codeOf(cause), RunnerStopped: stopped}, cause
	}
	if err = s.Backend.CheckHost(ctx); err != nil {
		return quarantine(err)
	}
	current, err := s.Backend.Configuration(ctx, false)
	if err != nil {
		return quarantine(err)
	}
	if err = VerifyIdentity(current, s.Manifest); err != nil {
		return quarantine(err)
	}
	identityVerified = true
	if err = VerifyConfiguration(current, s.Manifest); err != nil {
		return quarantine(err)
	}
	if err = s.Backend.CheckHA(ctx); err != nil {
		return quarantine(err)
	}
	clean, err := s.Backend.Configuration(ctx, true)
	if err != nil {
		return quarantine(err)
	}
	if err = VerifyConfiguration(clean, s.Manifest); err != nil {
		return quarantine(err)
	}
	if SnapshotDigest(clean) != s.Manifest.SnapshotSHA256 {
		return quarantine(failure("SNAPSHOT_DIGEST_MISMATCH"))
	}
	if err = s.Backend.CheckPolicy(ctx); err != nil {
		return quarantine(err)
	}
	if err = s.Backend.Rollback(ctx); err != nil {
		return quarantine(err)
	}
	stopped, err := s.Backend.Stopped(ctx)
	if err != nil {
		return quarantine(err)
	}
	if !stopped {
		return quarantine(failure("ROLLBACK_NOT_STOPPED"))
	}
	restored, err := s.Backend.Configuration(ctx, false)
	if err != nil {
		return quarantine(err)
	}
	if err = VerifyConfiguration(restored, s.Manifest); err != nil {
		return quarantine(err)
	}
	if SnapshotDigest(restored) != s.Manifest.SnapshotSHA256 {
		return quarantine(failure("RESTORE_CONFIG_MISMATCH"))
	}
	if err = s.Backend.CheckPolicy(ctx); err != nil {
		return quarantine(err)
	}
	if err = s.Backend.Start(ctx); err != nil {
		return quarantine(err)
	}
	bootID, err := s.Backend.BootID(ctx)
	if err != nil {
		return quarantine(err)
	}
	if !uuidPattern.MatchString(bootID) || bootID == previousBoot {
		return quarantine(failure("BOOT_ID_NOT_FRESH"))
	}
	if err = s.Backend.CheckPolicy(ctx); err != nil {
		return quarantine(err)
	}
	receipt := Receipt{SchemaVersion: 1, OK: true, Phase: "ready", InstallationID: s.Manifest.InstallationID, VMID: s.Manifest.VMID, RequestID: request.RequestID, Generation: state.Generation, ManifestSHA256: request.ManifestSHA256, BootID: bootID, SnapshotSHA256: s.Manifest.SnapshotSHA256, PolicySHA256: s.Manifest.NFT.SHA256, CompletedAt: s.now().UTC().Format(time.RFC3339Nano)}
	state.Phase = "ready"
	state.LastBootID = bootID
	state.Receipt = &receipt
	if err = s.Store.Save(state); err != nil {
		return quarantine(err)
	}
	return receipt, nil
}
