package cmd_test

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/git-pkgs/git-pkgs/internal/database"
)

func TestVulnsBlameResolvesHEAD(t *testing.T) {
	vuln := setupVulnerableNPMRepo(t)

	stdout, _, err := runCmd(t, "vulns", "blame", "--format", "json")
	if err != nil {
		t.Fatalf("vulns blame failed: %v", err)
	}

	var entries []struct {
		VulnID  string `json:"vuln_id"`
		Package string `json:"package"`
		AddedBy string `json:"added_by"`
	}
	if err := json.Unmarshal([]byte(stdout), &entries); err != nil {
		t.Fatalf("parsing vulns blame output: %v", err)
	}

	for _, entry := range entries {
		if entry.VulnID == vuln.ID && entry.Package == "express" && entry.AddedBy == "Test User" {
			return
		}
	}

	t.Fatalf("expected express vulnerability blame entry, got: %#v", entries)
}

func TestVulnsBlameUsesSelectedBranchTip(t *testing.T) {
	repoDir := createTestRepo(t)
	addFileAndCommit(t, repoDir, "README.md", "# Test repository\n", "Initial commit")

	gitCmd := exec.Command("git", "checkout", "-b", "feature")
	gitCmd.Dir = repoDir
	if err := gitCmd.Run(); err != nil {
		t.Fatalf("creating feature branch: %v", err)
	}
	addFileAndCommit(t, repoDir, "package.json", packageJSON, "Add package.json")
	addFileAndCommit(t, repoDir, "package-lock.json", packageLockJSON, "Add package-lock.json")

	cleanup := chdir(t, repoDir)
	defer cleanup()

	if _, _, err := runCmd(t, "init", "--branch", "feature", "--no-hooks"); err != nil {
		t.Fatalf("init feature failed: %v", err)
	}
	vuln := insertTestNPMVulnerability(t, repoDir, "GHSA-issue-346")

	gitCmd = exec.Command("git", "checkout", "main")
	gitCmd.Dir = repoDir
	if err := gitCmd.Run(); err != nil {
		t.Fatalf("checking out main: %v", err)
	}

	tests := []struct {
		name string
		args []string
	}{
		{name: "explicit branch", args: []string{"vulns", "blame", "--branch", "feature", "--format", "json"}},
		{name: "default database branch", args: []string{"vulns", "blame", "--format", "json"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stdout, _, err := runCmd(t, tt.args...)
			if err != nil {
				t.Fatalf("vulns blame failed: %v", err)
			}

			var entries []struct {
				VulnID  string `json:"vuln_id"`
				Package string `json:"package"`
			}
			if err := json.Unmarshal([]byte(stdout), &entries); err != nil {
				t.Fatalf("parsing vulns blame output: %v", err)
			}
			for _, entry := range entries {
				if entry.VulnID == vuln.ID && entry.Package == "express" {
					return
				}
			}
			t.Fatalf("expected express vulnerability from feature branch, got: %#v", entries)
		})
	}
}

func TestVulnsExposureResolvesHEAD(t *testing.T) {
	vuln := setupVulnerableNPMRepo(t)

	stdout, _, err := runCmd(t, "vulns", "exposure", "--format", "json")
	if err != nil {
		t.Fatalf("vulns exposure failed: %v", err)
	}

	var entries []struct {
		VulnID       string `json:"vuln_id"`
		Package      string `json:"package"`
		IntroducedBy string `json:"introduced_by"`
	}
	if err := json.Unmarshal([]byte(stdout), &entries); err != nil {
		t.Fatalf("parsing vulns exposure output: %v", err)
	}

	for _, entry := range entries {
		if entry.VulnID == vuln.ID && entry.Package == "express" && entry.IntroducedBy == "Test User" {
			return
		}
	}

	t.Fatalf("expected express vulnerability exposure entry, got: %#v", entries)
}

func setupVulnerableNPMRepo(t *testing.T) database.Vulnerability {
	t.Helper()

	repoDir := createTestRepo(t)
	addFileAndCommit(t, repoDir, "package.json", packageJSON, "Add package.json")
	addFileAndCommit(t, repoDir, "package-lock.json", packageLockJSON, "Add package-lock.json")

	cleanup := chdir(t, repoDir)
	t.Cleanup(cleanup)

	if _, _, err := runCmd(t, "init"); err != nil {
		t.Fatalf("init failed: %v", err)
	}

	return insertTestNPMVulnerability(t, repoDir, "GHSA-issue-299")
}

func insertTestNPMVulnerability(t *testing.T, repoDir, id string) database.Vulnerability {
	t.Helper()
	db, err := database.Open(filepath.Join(repoDir, ".git", "pkgs.sqlite3"))
	if err != nil {
		t.Fatalf("opening database: %v", err)
	}

	vuln := database.Vulnerability{
		ID:        id,
		Severity:  "high",
		Summary:   "Test vulnerability",
		FetchedAt: time.Now().Format(time.RFC3339),
	}
	if err := db.InsertVulnerability(vuln); err != nil {
		_ = db.Close()
		t.Fatalf("inserting vulnerability: %v", err)
	}
	if err := db.InsertVulnerabilityPackage(database.VulnerabilityPackage{
		VulnerabilityID: vuln.ID,
		Ecosystem:       "npm",
		PackageName:     "express",
		FixedVersions:   "4.19.0",
	}); err != nil {
		_ = db.Close()
		t.Fatalf("inserting vulnerability package: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("closing database: %v", err)
	}

	return vuln
}
