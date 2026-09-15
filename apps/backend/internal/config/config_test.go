package config

import (
	"strings"
	"testing"
	"time"
)

func setRequiredTestEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://test:test@localhost:5432/test")
	t.Setenv("PRIVACY_OPERATOR_NAME", "")
	t.Setenv("PRIVACY_CONTACT_EMAIL", "")
	t.Setenv("AUTO_MIGRATE", "")
	t.Setenv("SANDBOX_ENABLED", "")
	t.Setenv("SANDBOX_RETENTION_DAYS", "")
	t.Setenv("SANDBOX_QRIS_AMOUNT", "")
	t.Setenv("SANDBOX_CLEANUP_INTERVAL", "")
	t.Setenv("SHUTDOWN_TIMEOUT", "")
	t.Setenv("SESSION_CACHE_TTL", "")
	t.Setenv("LOGIN_RATE_LIMIT", "")
	t.Setenv("LOGIN_RATE_WINDOW", "")
	t.Setenv("TRUSTED_PROXIES", "")
	t.Setenv("NEW_RELIC_APP_NAME", "")
	t.Setenv("NEW_RELIC_DISTRIBUTED_TRACING_ENABLED", "")
	t.Setenv("NEW_RELIC_LOG_FORWARDING_ENABLED", "")
}

func TestLoadUsesProductionSafeSandboxDefaults(t *testing.T) {
	setRequiredTestEnvironment(t)
	t.Setenv("NEW_RELIC_ENABLED", "false")
	t.Setenv("NEW_RELIC_LICENSE_KEY", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.SandboxEnabled {
		t.Fatal("sandbox must be disabled unless explicitly enabled")
	}
	if cfg.SandboxQRISAmountDeprecated {
		t.Fatal("an absent legacy amount setting must not cause a deprecation warning")
	}
	if cfg.SandboxRetentionDays != 30 || cfg.SandboxQRISAmount != 1_000 {
		t.Fatalf(
			"sandbox defaults = retention %d, QRIS %d",
			cfg.SandboxRetentionDays,
			cfg.SandboxQRISAmount,
		)
	}
	if cfg.SandboxCleanupInterval != 24*time.Hour {
		t.Fatalf("SandboxCleanupInterval = %s", cfg.SandboxCleanupInterval)
	}
}

func TestLoadPrivacyPageConfiguration(t *testing.T) {
	setRequiredTestEnvironment(t)
	t.Setenv("NEW_RELIC_ENABLED", "false")
	t.Setenv("NEW_RELIC_LICENSE_KEY", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PrivacyOperatorName != "Pengelola Wisata Telomoyo" || cfg.PrivacyContactEmail != "" {
		t.Fatal("privacy defaults must name the operator without inventing a contact")
	}
	t.Setenv("PRIVACY_OPERATOR_NAME", "  Pengelola Uji  ")
	t.Setenv("PRIVACY_CONTACT_EMAIL", "  privacy+telomoyo@example.org  ")
	cfg, err = Load()
	if err != nil || cfg.PrivacyOperatorName != "Pengelola Uji" || cfg.PrivacyContactEmail != "privacy+telomoyo@example.org" {
		t.Fatalf("unexpected privacy configuration: operator=%q email=%q err=%v", cfg.PrivacyOperatorName, cfg.PrivacyContactEmail, err)
	}
}

func TestLoadRejectsInvalidPrivacyEmail(t *testing.T) {
	for _, email := range []string{
		"not-an-email", "mailto:privacy@example.org", "Privacy <privacy@example.org>",
		"one@example.org,two@example.org", "privacy@example.org?bcc=other@example.org",
		"privacy@example.org\r\nBcc: other@example.org", "\"question?\"@example.org",
	} {
		t.Run(email, func(t *testing.T) {
			setRequiredTestEnvironment(t)
			t.Setenv("PRIVACY_CONTACT_EMAIL", email)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), "PRIVACY_CONTACT_EMAIL") {
				t.Fatalf("invalid contact was accepted: %v", err)
			}
		})
	}
}

func TestLoadAcceptsExplicitSandboxConfiguration(t *testing.T) {
	setRequiredTestEnvironment(t)
	t.Setenv("NEW_RELIC_ENABLED", "false")
	t.Setenv("NEW_RELIC_LICENSE_KEY", "")
	t.Setenv("SANDBOX_ENABLED", "true")
	t.Setenv("SANDBOX_RETENTION_DAYS", "45")
	t.Setenv("SANDBOX_QRIS_AMOUNT", "1000")
	t.Setenv("SANDBOX_CLEANUP_INTERVAL", "6h")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.SandboxQRISAmountDeprecated || !cfg.SandboxEnabled || cfg.SandboxRetentionDays != 45 ||
		cfg.SandboxQRISAmount != 1_000 || cfg.SandboxCleanupInterval != 6*time.Hour {
		t.Fatalf("unexpected sandbox config: %+v", cfg)
	}
}

func TestLoadRejectsUnsafeSandboxConfiguration(t *testing.T) {
	tests := map[string]struct {
		name  string
		value string
	}{
		"retention": {name: "SANDBOX_RETENTION_DAYS", value: "0"},
		"qris":      {name: "SANDBOX_QRIS_AMOUNT", value: "999"},
		"cleanup":   {name: "SANDBOX_CLEANUP_INTERVAL", value: "30s"},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			setRequiredTestEnvironment(t)
			t.Setenv("NEW_RELIC_ENABLED", "false")
			t.Setenv("NEW_RELIC_LICENSE_KEY", "")
			t.Setenv(test.name, test.value)
			if _, err := Load(); err == nil || !strings.Contains(err.Error(), test.name) {
				t.Fatalf("Load() error = %v, want %s validation", err, test.name)
			}
		})
	}
}

func TestLoadDisablesNewRelicWithoutLicenseByDefault(t *testing.T) {
	setRequiredTestEnvironment(t)
	t.Setenv("NEW_RELIC_ENABLED", "")
	t.Setenv("NEW_RELIC_LICENSE_KEY", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.NewRelicEnabled {
		t.Fatal("New Relic should be disabled when no license key is configured")
	}
	if cfg.NewRelicAppName != "sewa-motor-backend" {
		t.Fatalf("NewRelicAppName = %q", cfg.NewRelicAppName)
	}
}

func TestLoadRequiresLicenseWhenNewRelicEnabled(t *testing.T) {
	setRequiredTestEnvironment(t)
	t.Setenv("NEW_RELIC_ENABLED", "true")
	t.Setenv("NEW_RELIC_LICENSE_KEY", "")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "NEW_RELIC_LICENSE_KEY") {
		t.Fatalf("Load() error = %v, want missing New Relic license error", err)
	}
}

func TestLoadEnablesNewRelicWhenLicenseIsPresent(t *testing.T) {
	setRequiredTestEnvironment(t)
	t.Setenv("NEW_RELIC_ENABLED", "")
	t.Setenv("NEW_RELIC_LICENSE_KEY", "test-license")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.NewRelicEnabled {
		t.Fatal("New Relic should default to enabled when a license key is configured")
	}
	if !cfg.NewRelicDistributedTracing || !cfg.NewRelicLogForwarding {
		t.Fatal("New Relic tracing and log forwarding should default to enabled")
	}
}
