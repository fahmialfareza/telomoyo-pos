package config

import (
	"fmt"
	"net/mail"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	TenantProvisioningEnabled   bool
	HTTPAddr                    string
	PrivacyOperatorName         string
	PrivacyContactEmail         string
	DatabaseURL                 string
	RedisURL                    string
	AutoMigrate                 bool
	SandboxEnabled              bool
	SandboxRetentionDays        int
	SandboxQRISAmount           int64
	SandboxQRISAmountDeprecated bool
	SandboxCleanupInterval      time.Duration
	LogLevel                    string
	ShutdownTimeout             time.Duration
	SessionCacheTTL             time.Duration
	LoginRateLimit              int
	LoginRateWindow             time.Duration
	TrustedProxies              []string
	NewRelicEnabled             bool
	NewRelicAppName             string
	NewRelicLicenseKey          string
	NewRelicDistributedTracing  bool
	NewRelicLogForwarding       bool
}

func Load() (Config, error) {
	cfg := Config{
		HTTPAddr:               env("HTTP_ADDR", ":8080"),
		PrivacyOperatorName:    env("PRIVACY_OPERATOR_NAME", "Pengelola Wisata Telomoyo"),
		PrivacyContactEmail:    strings.TrimSpace(os.Getenv("PRIVACY_CONTACT_EMAIL")),
		DatabaseURL:            strings.TrimSpace(os.Getenv("DATABASE_URL")),
		RedisURL:               strings.TrimSpace(os.Getenv("REDIS_URL")),
		SandboxRetentionDays:   30,
		SandboxQRISAmount:      1_000,
		SandboxCleanupInterval: 24 * time.Hour,
		LogLevel:               env("LOG_LEVEL", "info"),
		ShutdownTimeout:        10 * time.Second,
		SessionCacheTTL:        15 * time.Minute,
		LoginRateLimit:         10,
		LoginRateWindow:        time.Minute,
		NewRelicAppName:        env("NEW_RELIC_APP_NAME", "sewa-motor-backend"),
		NewRelicLicenseKey: strings.TrimSpace(
			os.Getenv("NEW_RELIC_LICENSE_KEY"),
		),
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	// Optional for existing deployments, but public legal pages are unavailable
	// until a real contact is configured. Never publish a placeholder mailbox.
	if cfg.PrivacyContactEmail != "" {
		address, err := mail.ParseAddress(cfg.PrivacyContactEmail)
		if err != nil || address.Name != "" || address.Address != cfg.PrivacyContactEmail ||
			strings.ContainsAny(cfg.PrivacyContactEmail, "\r\n?#&%\"<>") {
			return Config{}, fmt.Errorf("PRIVACY_CONTACT_EMAIL must be a single plain email address")
		}
	}

	var err error
	if cfg.TenantProvisioningEnabled, err = strconv.ParseBool(env("TENANT_PROVISIONING_ENABLED", "false")); err != nil {
		return Config{}, fmt.Errorf("TENANT_PROVISIONING_ENABLED: %w", err)
	}
	if cfg.AutoMigrate, err = strconv.ParseBool(env("AUTO_MIGRATE", "false")); err != nil {
		return Config{}, fmt.Errorf("AUTO_MIGRATE: %w", err)
	}
	if cfg.SandboxEnabled, err = strconv.ParseBool(env("SANDBOX_ENABLED", "false")); err != nil {
		return Config{}, fmt.Errorf("SANDBOX_ENABLED: %w", err)
	}
	if cfg.SandboxRetentionDays, err = strconv.Atoi(env("SANDBOX_RETENTION_DAYS", "30")); err != nil || cfg.SandboxRetentionDays < 1 || cfg.SandboxRetentionDays > 365 {
		return Config{}, fmt.Errorf("SANDBOX_RETENTION_DAYS must be an integer between 1 and 365")
	}
	if cfg.SandboxQRISAmount, err = strconv.ParseInt(env("SANDBOX_QRIS_AMOUNT", "1000"), 10, 64); err != nil || cfg.SandboxQRISAmount != 1_000 {
		return Config{}, fmt.Errorf("SANDBOX_QRIS_AMOUNT is deprecated; remove it or retain exactly 1000 for legacy session compatibility")
	}
	cfg.SandboxQRISAmountDeprecated = strings.TrimSpace(os.Getenv("SANDBOX_QRIS_AMOUNT")) != ""
	if cfg.SandboxCleanupInterval, err = time.ParseDuration(env("SANDBOX_CLEANUP_INTERVAL", "24h")); err != nil || cfg.SandboxCleanupInterval < time.Minute {
		return Config{}, fmt.Errorf("SANDBOX_CLEANUP_INTERVAL must be a duration of at least 1m")
	}
	if cfg.ShutdownTimeout, err = time.ParseDuration(env("SHUTDOWN_TIMEOUT", "10s")); err != nil {
		return Config{}, fmt.Errorf("SHUTDOWN_TIMEOUT: %w", err)
	}
	if cfg.SessionCacheTTL, err = time.ParseDuration(env("SESSION_CACHE_TTL", "15m")); err != nil {
		return Config{}, fmt.Errorf("SESSION_CACHE_TTL: %w", err)
	}
	if cfg.LoginRateLimit, err = strconv.Atoi(env("LOGIN_RATE_LIMIT", "10")); err != nil || cfg.LoginRateLimit < 1 {
		return Config{}, fmt.Errorf("LOGIN_RATE_LIMIT must be a positive integer")
	}
	if cfg.LoginRateWindow, err = time.ParseDuration(env("LOGIN_RATE_WINDOW", "1m")); err != nil {
		return Config{}, fmt.Errorf("LOGIN_RATE_WINDOW: %w", err)
	}
	newRelicDefault := strconv.FormatBool(cfg.NewRelicLicenseKey != "")
	if cfg.NewRelicEnabled, err = strconv.ParseBool(env("NEW_RELIC_ENABLED", newRelicDefault)); err != nil {
		return Config{}, fmt.Errorf("NEW_RELIC_ENABLED: %w", err)
	}
	if cfg.NewRelicEnabled && cfg.NewRelicLicenseKey == "" {
		return Config{}, fmt.Errorf("NEW_RELIC_LICENSE_KEY is required when NEW_RELIC_ENABLED=true")
	}
	if cfg.NewRelicDistributedTracing, err = strconv.ParseBool(env("NEW_RELIC_DISTRIBUTED_TRACING_ENABLED", "true")); err != nil {
		return Config{}, fmt.Errorf("NEW_RELIC_DISTRIBUTED_TRACING_ENABLED: %w", err)
	}
	if cfg.NewRelicLogForwarding, err = strconv.ParseBool(env("NEW_RELIC_LOG_FORWARDING_ENABLED", "true")); err != nil {
		return Config{}, fmt.Errorf("NEW_RELIC_LOG_FORWARDING_ENABLED: %w", err)
	}
	if proxies := strings.TrimSpace(os.Getenv("TRUSTED_PROXIES")); proxies != "" {
		for _, proxy := range strings.Split(proxies, ",") {
			if proxy = strings.TrimSpace(proxy); proxy != "" {
				cfg.TrustedProxies = append(cfg.TrustedProxies, proxy)
			}
		}
	}
	return cfg, nil
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
