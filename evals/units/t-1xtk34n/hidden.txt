package cmd_test

import (
	"encoding/json"
	"os/exec"
	"testing"

	"github.com/git-pkgs/git-pkgs/cmd"
)

func TestVulnsExposureUsesSelectedBranchTip(t *testing.T) {
	for _, checkout := range []string{"ancestor", "divergent"} {
		t.Run(checkout, func(t *testing.T) {
			repoDir := createTestRepo(t)
			addFileAndCommit(t, repoDir, "README.md", "# Test repository\n", "Initial commit")
			gitCmd := exec.Command("git", "checkout", "-b", "feature")
			gitCmd.Dir = repoDir
			if output, err := gitCmd.CombinedOutput(); err != nil {
				t.Fatalf("creating feature branch: %v\n%s", err, output)
			}
			addFileAndCommit(t, repoDir, "package.json", packageJSON, "Add package.json")
			addFileAndCommit(t, repoDir, "package-lock.json", packageLockJSON, "Add package-lock.json")

			cleanup := chdir(t, repoDir)
			defer cleanup()
			if _, _, err := runCmd(t, "init", "--branch", "feature", "--no-hooks"); err != nil {
				t.Fatalf("init feature: %v", err)
			}
			vuln := insertTestNPMVulnerability(t, repoDir, "GHSA-issue-354")

			gitCmd = exec.Command("git", "checkout", "main")
			gitCmd.Dir = repoDir
			if output, err := gitCmd.CombinedOutput(); err != nil {
				t.Fatalf("checking out main: %v\n%s", err, output)
			}
			if checkout == "divergent" {
				addFileAndCommit(t, repoDir, "README.md", "# Main branch\n", "Diverge from feature")
			}
			if _, _, err := runCmd(t, "branch", "add", "main"); err != nil {
				t.Fatalf("indexing main: %v", err)
			}

			tests := []struct {
				name string
				args []string
				want int
			}{
				{name: "explicit branch", args: []string{"--branch", "feature"}, want: 1},
				{name: "default database branch", want: 1},
				{name: "explicit feature ref", args: []string{"--branch", "feature", "--ref", "feature"}, want: 1},
				{name: "explicit historical ref", args: []string{"--branch", "feature", "--ref", "feature~1"}, want: 0},
				{name: "explicit HEAD", args: []string{"--branch", "feature", "--ref", "HEAD"}, want: 0},
				{name: "all time", args: []string{"--branch", "feature", "--all-time"}, want: 1},
				{name: "main has no vulnerabilities", args: []string{"--branch", "main"}, want: 0},
			}
			for _, tt := range tests {
				t.Run(tt.name, func(t *testing.T) {
					args := append([]string{"vulns", "exposure", "--format", "json"}, tt.args...)
					stdout, _, err := runCmd(t, args...)
					if err != nil {
						t.Fatalf("vulns exposure: %v", err)
					}
					var entries []cmd.VulnExposureEntry
					if err := json.Unmarshal([]byte(stdout), &entries); err != nil {
						t.Fatalf("parsing exposure JSON: %v", err)
					}
					if len(entries) != tt.want {
						t.Fatalf("exposure entries = %+v, want %d", entries, tt.want)
					}
					if tt.want > 0 && (entries[0].VulnID != vuln.ID || entries[0].Package != "express" || entries[0].IntroducedBy != "Test User") {
						t.Fatalf("unexpected exposure entry: %+v", entries[0])
					}
				})
			}
		})
	}
}
